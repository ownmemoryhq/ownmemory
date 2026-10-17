import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { fromB64, importMemoryKey } from "../public/keys.js";
import {
	CATEGORIES,
	CORE_CATEGORIES,
	type Category,
	type Memory,
	type MemoryFields,
	describe,
	duplicateGroups,
	HISTORY_LIMIT,
	findDuplicate,
	hybridSearch,
	looksLikeSecret,
	newestFirst,
	searchMemories,
} from "./format";
import { Drive, refreshAccessToken } from "./google";
import type { Props } from "./props";
import { IMPORT_SAME_MEANING, REVIEW_SAME_MEANING, SAME_MEANING, Semantic, closest, cosine } from "./semantic";
import {
	type Settings,
	RAMP_MIN_MEMORIES,
	SNOOZE_DAYS,
	applyChoice,
	catchUpDue,
	markCaughtUp,
	markNudged,
	rampStatus,
} from "./settings";
import { D1Storage, DriveStorage } from "./storage";
import { MemoryStore } from "./store";
import { UPDATING_GUIDE, VERSION, availableUpdate } from "./updates";
import { ownerCodeHash } from "./web";

const INSTRUCTIONS = `OwnMemory is the user's long-term memory, stored encrypted in storage they own.

1. At the start of every conversation, call load_core_memories once, before replying. It returns the user's memory mode, what to do in that mode, and any message to pass on to the user. Follow it.
2. Save durable facts with save_memory as soon as you learn them, even if you also keep your own built-in memory: who the user is, their preferences, decisions, ongoing projects, people in their life, and anything they ask you to remember. One fact per memory, written as a standalone sentence that will make sense months from now. Before finishing each reply, check whether the user revealed such a fact. Each time you save or update a fact in your built-in memory, make the matching save_memory or update_memory call in the same reply: a built-in save never reaches OwnMemory on its own.
3. Don't save small talk, one-off requests, things true only today, or anything the user asks you not to remember. Never save passwords, keys, card numbers or other credentials; the server refuses them.
4. When a fact changes, update_memory the old one. save_memory tells you if a fact is already saved.
5. To copy many facts at once, for example everything your built-in memory knows about the user, use import_memories.
6. When the user says how they want OwnMemory to work alongside your built-in memory, record it with set_memory_mode.
7. Tell the user briefly when you save, update or delete a memory.`;

const MAX_CONTENT = 2000;
const MAX_TITLE = 120;
const RECENT_WORK = 10;

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }] };
}

function refuse(t: string) {
	return { content: [{ type: "text" as const, text: t }], isError: true };
}

function list(memories: Memory[], empty: string) {
	return text(memories.length ? memories.map(describe).join("\n\n") : empty);
}

function blockedCategories(): Set<string> {
	return new Set(
		(env.BLOCKED_CATEGORIES ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

const PAUSED = "Saving is paused by the owner of this memory. Nothing was saved.";

/** The owner's hard rules, enforced here whatever the AI was told. */
function writeRefusal(category: Category, ...texts: string[]): string | null {
	if (env.WRITES_PAUSED === "true") return PAUSED;
	if (blockedCategories().has(category)) {
		return `The owner does not allow saving "${category}" memories. Nothing was saved.`;
	}
	if (texts.some(looksLikeSecret)) {
		return "This looks like a password, key or card number, which OwnMemory never stores. Nothing was saved.";
	}
	return null;
}

function defaultTitle(content: string) {
	const first = content.trim().split(/\n/)[0];
	return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

function newFields(content: string, category: Category, title?: string): MemoryFields {
	const now = new Date().toISOString();
	return {
		title: title?.trim() || defaultTitle(content),
		category,
		content: content.trim(),
		source: "claude",
		created: now,
		updated: now,
	};
}

async function openStore(): Promise<MemoryStore> {
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props?.memoryKey) throw new Error("Not signed in to OwnMemory");
	const key = await importMemoryKey(fromB64(props.memoryKey));
	if (props.storage === "d1") {
		if (!env.DB) throw new Error("This server has no D1 database bound as DB");
		if (props.ownerCode !== (await ownerCodeHash(env))) {
			throw new Error("This connection has ended: the server's owner code changed. Reconnect OwnMemory in Claude's settings.");
		}
		return new MemoryStore(new D1Storage(env.DB), key);
	}
	// Drive. Grants made before storage choices existed carry no "storage" field.
	if (!props.google || !props.folderId) throw new Error("Grant is missing its Google Drive details");
	let accessToken = props.google.accessToken;
	if (props.google.expiresAt < Date.now() + 60_000) {
		// The grant's copy is refreshed on each OAuth token refresh; this covers the gap.
		accessToken = (await refreshAccessToken(env, props.google.refreshToken)).accessToken;
	}
	return new MemoryStore(new DriveStorage(new Drive(accessToken), props.folderId), key);
}

/** Meaning-based search for this store, or null when Workers AI is missing or switched off. */
function semanticFor(store: MemoryStore): Semantic | null {
	return env.AI && env.SEMANTIC_SEARCH !== "off" ? new Semantic(store, env.AI) : null;
}

/** Runs a meaning-based step; if Workers AI fails (quota, outage), returns null so callers fall back. */
async function tryMeaning<T>(fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch (error) {
		console.error("semantic search unavailable", error instanceof Error ? error.name : typeof error);
		return null;
	}
}

const MEMORY_SETTING = "Settings → Capabilities → Memory";

// Once a day while Claude's memory is on: catches facts Claude saved only to its own memory.
const CATCH_UP =
	"Daily catch-up: call import_memories with every durable fact about the user in your built-in memory (up to 50 per call), so any fact saved only there reaches OwnMemory. Facts already in OwnMemory are skipped, so don't check first. Do it without asking, and mention it only if something was added, in one short line.";

/** What load_core_memories tells Claude in each mode; returns whether a nudge was given. */
function modeBriefing(settings: Settings, count: number, now: Date): { lines: string[]; nudged: boolean } {
	if (settings.mode === "ownmemory_only") {
		return {
			lines: [
				"Memory mode: OwnMemory only. The user has turned off Claude's built-in memory, so OwnMemory is their only memory.",
				"Use the memories below, and call search_memories before answering anything that may depend on the user's history, preferences or past decisions.",
			],
			nudged: false,
		};
	}
	if (settings.mode === "keep_both") {
		return {
			lines: [
				"Memory mode: keep both. Claude's built-in memory handles recall, so no memories are listed here.",
				"Save every new durable fact to OwnMemory too, as the user's own copy. Each time you save or update a fact in your built-in memory, make the matching save_memory or update_memory call in the same reply: a built-in save never reaches OwnMemory on its own. Don't mention OwnMemory's status unless the user asks.",
			],
			nudged: false,
		};
	}
	const { day, nudge } = rampStatus(settings, now, count);
	const lines = [
		`Memory mode: ramp-up, day ${day} of ${settings.rampDays}. Claude's built-in memory is still on and handles recall, so no memories are listed here.`,
		"Save every new durable fact to OwnMemory as well. Each time you save or update a fact in your built-in memory, make the matching save_memory or update_memory call in the same reply: a built-in save never reaches OwnMemory on its own.",
	];
	if (count === 0) {
		lines.push(
			"OwnMemory is empty. At a natural point, offer to copy what your built-in memory knows about the user into OwnMemory with import_memories.",
		);
	}
	if (nudge === "progress" && count > 0) {
		lines.push(
			`Pass this on briefly at a natural point in your reply: "OwnMemory now holds ${count} memories, day ${day} of ${settings.rampDays} of your ramp-up."`,
		);
	}
	if (nudge === "ask") {
		lines.push(
			`Ramp-up is complete (${count} memories). At a natural point in your reply, ask the user whether they'd like to turn off Claude's built-in memory, so their memories live only in OwnMemory. The switch is at ${MEMORY_SETTING}.`,
			`Offer three answers and record theirs with set_memory_mode: they've turned it off (ownmemory_only); not yet (not_yet, asks again in ${SNOOZE_DAYS} days); or keep using both (keep_both, no more reminders).`,
			"Before they switch, offer to copy anything your built-in memory knows that isn't in OwnMemory yet, with import_memories.",
		);
	}
	return { lines, nudged: nudge !== "none" && (nudge === "ask" || count > 0) };
}

const category = z.enum(CATEGORIES);

export function createServer() {
	const server = new McpServer({ name: "OwnMemory", version: VERSION }, { instructions: INSTRUCTIONS });

	server.registerTool(
		"load_core_memories",
		{
			title: "Start of conversation",
			description:
				"Call once at the start of every conversation, before replying. Returns the user's memory mode, what to do in it, any message for the user, and (when OwnMemory is their only memory) their profile, preferences and recent work.",
			annotations: { readOnlyHint: true },
		},
		async () => {
			const store = await openStore();
			const now = new Date();
			const [{ memories }, { settings, fileId }, update] = await Promise.all([
				store.all(),
				store.settings(now),
				availableUpdate(env).catch(() => null),
			]);
			const { lines, nudged } = modeBriefing(settings, memories.length, now);
			const catchUp = catchUpDue(settings, now, memories.length);
			if (catchUp) lines.push(CATCH_UP);
			// Each new release is mentioned once.
			const announce = update && settings.updateNotified !== update.latest;
			if (announce) {
				lines.push(
					`Pass this on briefly at a natural point in your reply: "OwnMemory ${update.latest} is available; your server runs ${update.current}. What's new: ${update.url}. How to update: ${UPDATING_GUIDE}"`,
				);
			}
			if (nudged || catchUp || announce) {
				let next = nudged ? markNudged(settings, now) : settings;
				if (catchUp) next = markCaughtUp(next, now);
				if (announce) next = { ...next, updateNotified: update.latest };
				await store.saveSettings(fileId, next);
			}
			if (settings.mode === "ownmemory_only") {
				const sorted = newestFirst(memories);
				const core = sorted.filter((m) => CORE_CATEGORIES.includes(m.category)).slice(0, 50);
				const work = sorted.filter((m) => m.category === "work" || m.category === "project").slice(0, RECENT_WORK);
				const shown = [...core, ...work];
				lines.push(
					"",
					shown.length
						? `Profile, preferences and recent work (${shown.length} of ${memories.length} memories):\n\n${shown.map(describe).join("\n\n")}`
						: "No memories yet. Save facts about the user as you learn them.",
				);
			}
			return text(lines.join("\n"));
		},
	);

	server.registerTool(
		"search_memories",
		{
			title: "Search memories",
			description:
				"Searches the user's saved memories by meaning and keywords (English, Chinese or mixed). Use before answering questions that depend on the user's history, preferences or decisions.",
			inputSchema: z.object({
				query: z.string().max(200).describe("What to look for, in words or a short question. Empty returns the most recent memories."),
				category: category.optional().describe("Only search this category."),
				limit: z.number().int().min(1).max(25).default(8),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ query, category, limit }) => {
			const store = await openStore();
			const { memories, unreadable } = await store.all();
			const pool = category ? memories.filter((m) => m.category === category) : memories;
			const semantic = query.trim() ? semanticFor(store) : null;
			const similarity = semantic
				? await tryMeaning(async () => {
						const [vectors, q] = await Promise.all([semantic.vectors(pool), semantic.embedText(query)]);
						return new Map([...vectors].map(([id, v]) => [id, cosine(q, v)]));
					})
				: null;
			const found = similarity ? hybridSearch(pool, query, similarity, limit) : searchMemories(pool, query, limit);
			const result = list(found, "No matching memories.");
			if (unreadable) result.content.push({ type: "text", text: `(${unreadable} files could not be decrypted.)` });
			return result;
		},
	);

	server.registerTool(
		"list_memories",
		{
			title: "List recent memories",
			description: "Lists the most recently updated memories, optionally in one category.",
			inputSchema: z.object({
				category: category.optional(),
				limit: z.number().int().min(1).max(50).default(20),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ category, limit }) => {
			const { memories } = await (await openStore()).all();
			const pool = category ? memories.filter((m) => m.category === category) : memories;
			return list(newestFirst(pool).slice(0, limit), "No memories yet.");
		},
	);

	server.registerTool(
		"save_memory",
		{
			title: "Save a memory",
			description:
				"Saves one durable fact about the user to their encrypted memory. Call it even when you also save the fact to your own built-in memory, which never copies it here. Write it as a standalone sentence. Never include passwords, keys or card numbers.",
			inputSchema: z.object({
				content: z.string().min(1).max(MAX_CONTENT).describe("The fact to remember, as a standalone sentence."),
				category: category.describe(
					"profile: who the user is; preference: likes, dislikes, how they want things done; work, project, relationship, health, finance, other.",
				),
				title: z.string().max(MAX_TITLE).optional().describe("A short label. Defaults to the first line."),
				force: z
					.boolean()
					.optional()
					.describe("Save even though a memory with a very similar meaning exists, when it really is a different fact."),
			}),
		},
		async ({ content, category, title, force }) => {
			const refusal = writeRefusal(category, content, title ?? "");
			if (refusal) return refuse(refusal);
			const store = await openStore();
			const { memories } = await store.all();
			const existing = findDuplicate(memories, content);
			if (existing) {
				return text(
					`Already saved as memory ${existing.id}; no new memory created. Use update_memory if the fact changed.`,
				);
			}
			const semantic = semanticFor(store);
			const check = semantic
				? await tryMeaning(async () => {
						const [vectors, vector] = await Promise.all([semantic.vectors(memories), semantic.embedText(content)]);
						return { vector, near: closest(vector, vectors) };
					})
				: null;
			if (!force && check?.near && check.near.similarity >= SAME_MEANING) {
				const similar = memories.find((m) => m.id === check.near!.id)!;
				return text(
					`Not saved yet: a memory with a very similar meaning exists.\n${describe(similar)}\nIf it is the same fact, nothing to do; if the fact changed, use update_memory on it; if it is a different fact, call save_memory again with force: true.`,
				);
			}
			const memory = await store.create(newFields(content, category, title));
			if (semantic && check) await tryMeaning(() => semantic.remember([{ memory, vector: check.vector }]));
			return text(`Saved memory ${memory.id}.`);
		},
	);

	server.registerTool(
		"import_memories",
		{
			title: "Import memories",
			description:
				"Saves many facts in one call, for example everything your built-in memory knows about the user. Each fact is checked like save_memory; facts already saved are skipped.",
			inputSchema: z.object({
				memories: z
					.array(
						z.object({
							content: z.string().min(1).max(MAX_CONTENT),
							category,
							title: z.string().max(MAX_TITLE).optional(),
						}),
					)
					.min(1)
					.max(50),
			}),
		},
		async ({ memories: incoming }) => {
			if (env.WRITES_PAUSED === "true") return refuse(PAUSED);
			const store = await openStore();
			const { memories: existing } = await store.all();
			let duplicates = 0;
			const refused: string[] = [];
			// Hard rules and exact duplicates first, so refused text is never sent anywhere.
			const known = [...existing];
			const candidates: MemoryFields[] = [];
			for (const item of incoming) {
				const refusal = writeRefusal(item.category, item.content, item.title ?? "");
				if (refusal) {
					refused.push(`"${item.content.slice(0, 60)}": ${refusal.replace(" Nothing was saved.", "")}`);
					continue;
				}
				if (findDuplicate(known, item.content)) {
					duplicates++;
					continue;
				}
				const fields = newFields(item.content, item.category, item.title);
				candidates.push(fields);
				known.push({ id: "", ...fields });
			}
			// Then the meaning check, for the whole batch at once.
			const semantic = semanticFor(store);
			const meaning =
				semantic && candidates.length
					? await tryMeaning(async () => ({
							existing: [...(await semantic.vectors(existing)).values()],
							fresh: await semantic.embedTexts(candidates.map((c) => c.content)),
						}))
					: null;
			const toSave: MemoryFields[] = [];
			const toSaveVectors: Float32Array[] = [];
			for (const [i, fields] of candidates.entries()) {
				const vector = meaning?.fresh[i];
				if (vector && [...meaning.existing, ...toSaveVectors].some((v) => cosine(vector, v) >= IMPORT_SAME_MEANING)) {
					duplicates++;
					continue;
				}
				toSave.push(fields);
				if (vector) toSaveVectors.push(vector);
			}
			const created: Memory[] = [];
			for (let i = 0; i < toSave.length; i += 4) {
				created.push(...(await Promise.all(toSave.slice(i, i + 4).map((f) => store.create(f)))));
			}
			const saved = created.length;
			if (semantic && meaning && created.length) {
				await tryMeaning(() => semantic.remember(created.map((memory, i) => ({ memory, vector: toSaveVectors[i] }))));
			}
			const report = [`Imported ${saved} of ${incoming.length}.`];
			if (duplicates) report.push(`Skipped ${duplicates} already saved (same or very similar meaning).`);
			if (refused.length) report.push(`Refused ${refused.length}:\n${refused.join("\n")}`);
			return text(report.join(" "));
		},
	);

	server.registerTool(
		"update_memory",
		{
			title: "Update a memory",
			description:
				"Changes the text, title or category of an existing memory when a fact changed. The previous wording is kept as history with its date, so you can still answer what was true before.",
			inputSchema: z.object({
				id: z.string().min(1).max(200).describe("The memory id, shown in [brackets] in results."),
				content: z.string().min(1).max(MAX_CONTENT).optional(),
				category: category.optional(),
				title: z.string().max(MAX_TITLE).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async ({ id, content, category, title }) => {
			const store = await openStore();
			const existing = await store.get(id);
			if (!existing) return refuse(`No memory with id ${id}.`);
			const changed = content !== undefined && content.trim() !== existing.content;
			const history = changed
				? [...(existing.history ?? []), { content: existing.content, until: new Date().toISOString() }].slice(-HISTORY_LIMIT)
				: existing.history;
			const next: Memory = {
				...existing,
				...(history ? { history } : {}),
				content: content?.trim() ?? existing.content,
				category: category ?? existing.category,
				title: title?.trim() || (content ? defaultTitle(content) : existing.title),
				updated: new Date().toISOString(),
			};
			const refusal = writeRefusal(next.category, next.content, next.title);
			if (refusal) return refuse(refusal.replace("saved", "changed"));
			await store.update(next);
			const semantic = semanticFor(store);
			if (semantic && (changed || title !== undefined)) await tryMeaning(() => semantic.remember([{ memory: next }]));
			return text(`Updated memory ${id}.${changed ? " The previous wording is kept as history." : ""}`);
		},
	);

	server.registerTool(
		"delete_memory",
		{
			title: "Delete a memory",
			description:
				"Deletes a memory when the user asks you to forget something or a memory is wrong. It can be restored for 30 days.",
			inputSchema: z.object({ id: z.string().min(1).max(200) }),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ id }) => {
			if (env.WRITES_PAUSED === "true") return refuse("Changes are paused by the owner. Nothing was deleted.");
			const removed = await (await openStore()).remove(id);
			return removed ? text(`Deleted memory ${id}.`) : refuse(`No memory with id ${id}.`);
		},
	);

	server.registerTool(
		"review_memories",
		{
			title: "Review memories",
			description:
				"Finds memories that look like the same fact, so they can be merged. Use when the user asks to tidy up their memory.",
			annotations: { readOnlyHint: true },
		},
		async () => {
			const store = await openStore();
			const { memories } = await store.all();
			const semantic = semanticFor(store);
			const vectors = semantic ? await tryMeaning(() => semantic.vectors(memories)) : null;
			const sameMeaning = vectors
				? (a: Memory, b: Memory) => cosine(vectors.get(a.id)!, vectors.get(b.id)!) >= REVIEW_SAME_MEANING
				: undefined;
			const groups = duplicateGroups(newestFirst(memories), sameMeaning).slice(0, 20);
			if (!groups.length) return text(`No duplicates found among ${memories.length} memories.`);
			const body = groups.map((g, i) => `Group ${i + 1}:\n${g.map(describe).join("\n")}`).join("\n\n");
			return text(
				`${groups.length} groups of memories that look like the same fact${vectors ? " (same wording or meaning)" : ""} among ${memories.length} memories. Show them to the user; with their agreement, keep the best wording in one memory (update_memory) and delete the others (delete_memory).\n\n${body}`,
			);
		},
	);

	server.registerTool(
		"set_memory_mode",
		{
			title: "Set memory mode",
			description:
				"Records how the user wants OwnMemory to work alongside Claude's built-in memory. ownmemory_only: they turned Claude's memory off. keep_both: keep Claude's memory and save a copy to OwnMemory, with no more reminders. not_yet: ask again later. ramp_up: restart the ramp-up period.",
			inputSchema: z.object({
				choice: z.enum(["ownmemory_only", "keep_both", "not_yet", "ramp_up"]),
			}),
			annotations: { idempotentHint: true },
		},
		async ({ choice }) => {
			const store = await openStore();
			const now = new Date();
			const { settings, fileId } = await store.settings(now);
			await store.saveSettings(fileId, markNudged(applyChoice(settings, choice, now), now));
			const confirm = {
				ownmemory_only:
					"Done: OwnMemory is now the user's only memory. From the next conversation, load_core_memories returns their memories and you should search OwnMemory before answering questions about them.",
				keep_both:
					"Done: the user keeps Claude's built-in memory, OwnMemory keeps a copy of every new fact, and there will be no more reminders.",
				not_yet: `Done: the user will be asked again in ${SNOOZE_DAYS} days.`,
				ramp_up: `Done: a new ${settings.rampDays}-day ramp-up starts today. At the end, once at least ${RAMP_MIN_MEMORIES} memories are saved, you'll ask the user to choose a mode.`,
			}[choice];
			return text(confirm);
		},
	);

	return server;
}
