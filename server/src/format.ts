// Memory types, search and duplicate checks. The file format itself (front matter, the
// secrets filter) lives in public/memory-file.js, shared with the browser.
import { CATEGORIES, HISTORY_LIMIT, fromMarkdown as parse, looksLikeSecret, toMarkdown } from "../public/memory-file.js";

export { CATEGORIES, HISTORY_LIMIT, looksLikeSecret, toMarkdown };

export type Category = (typeof CATEGORIES)[number];

/** Categories loaded at the start of a chat by load_core_memories. */
export const CORE_CATEGORIES: readonly Category[] = ["profile", "preference"];

/** An earlier wording of a fact, kept when update_memory changes it. */
export interface PastVersion {
	content: string;
	until: string; // when it stopped being current
}

export interface MemoryFields {
	title: string;
	category: Category;
	content: string;
	source: string;
	created: string;
	updated: string;
	/** Earlier versions, oldest first; absent when the fact never changed. */
	history?: PastVersion[];
}

export interface Memory extends MemoryFields {
	id: string;
}

export const fromMarkdown: (id: string, text: string) => Memory = parse;

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

// Question words and particles that carry no topic: ignored when matching single characters.
const CJK_FILLER = new Set("的了是我你他她它们吗呢吧啊什么哪怎样谁几个有在和与就都也还要会想喜欢");

function bigrams(s: string) {
	const out: string[] = [];
	for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
	return out;
}

/** Share of a CJK term found in the text: two-character pieces first, then single characters. */
function cjkOverlap(term: string, text: string) {
	const grams = bigrams(term);
	const gramShare = grams.filter((g) => text.includes(g)).length / grams.length;
	const chars = [...term].filter((ch) => CJK.test(ch) && !CJK_FILLER.has(ch));
	const charShare = chars.length ? chars.filter((ch) => text.includes(ch)).length / chars.length : 0;
	return Math.max(gramShare, charShare * 0.75);
}

// Common English words that carry no topic; "i" or "do" would otherwise match inside other words.
const STOPWORDS = new Set(
	"a an the i me my mine we our you your he she it its they them their is am are was were be been do does did what which who whom whose when where why how to of in on at for from with by about and or but if so as that this these those there here have has had can could would should will shall may might must not no yes any some all".split(
		" ",
	),
);

function queryTerms(query: string) {
	return query
		.toLowerCase()
		.split(/[\s,.;:!?()"'，。；：！？、（）“”‘’]+/)
		.filter((t) => t && !STOPWORDS.has(t) && (CJK.test(t) || t.length > 1));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Latin terms match from the start of a word ("tea" in "teas", not in "steady"). */
function hasWord(text: string, term: string) {
	return CJK.test(term) ? text.includes(term) : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, "u").test(text);
}

/**
 * Keyword score that also works for Chinese and Japanese, which have no spaces: a CJK term
 * that is not found whole still scores by how much of it appears. 0 means no match.
 */
export function keywordScore(m: Memory, terms: string[]): number {
	const title = m.title.toLowerCase();
	const body = `${m.content} ${m.category}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (hasWord(title, term)) score += 3;
		if (hasWord(body, term)) score += 2;
		else if (CJK.test(term) && term.length > 1) {
			const share = cjkOverlap(term, `${title} ${body}`);
			if (share >= 0.5) score += 2 * share;
		}
	}
	return score;
}

/** Keyword-only search: the fallback when meaning-based search is off or unavailable. */
export function searchMemories(memories: Memory[], query: string, limit: number): Memory[] {
	const terms = queryTerms(query);
	if (terms.length === 0) return newestFirst(memories).slice(0, limit);
	const scored = memories.map((m) => ({ m, score: keywordScore(m, terms) })).filter((s) => s.score > 0);
	scored.sort((a, b) => b.score - a.score || b.m.updated.localeCompare(a.m.updated));
	return scored.slice(0, limit).map((s) => s.m);
}

/** Meaning similarity (cosine, -1 to 1) at or above which a memory counts as relevant. */
export const RELEVANT = 0.5;

/**
 * Hybrid search: meaning similarity from embeddings, plus keywords, plus a little recency.
 * similarity maps memory id to cosine similarity with the query; ids missing from it are
 * ranked by keywords alone.
 */
export function hybridSearch(
	memories: Memory[],
	query: string,
	similarity: Map<string, number>,
	limit: number,
	now = Date.now(),
): Memory[] {
	const terms = queryTerms(query);
	if (terms.length === 0) return newestFirst(memories).slice(0, limit);
	const scored = memories
		.map((m) => {
			const kw = keywordScore(m, terms);
			const sim = similarity.get(m.id);
			const ageDays = Math.max(0, (now - Date.parse(m.updated || m.created)) / 86_400_000) || 0;
			const recency = Math.exp(-ageDays / 365);
			const keywords = Math.min(kw / 5, 1);
			const score = sim === undefined ? keywords * 0.9 + recency * 0.1 : sim * 0.65 + keywords * 0.25 + recency * 0.1;
			const relevant = kw > 0 || (sim !== undefined && sim >= RELEVANT);
			return { m, score, relevant };
		})
		.filter((s) => s.relevant);
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.m);
}

/** Text reduced to letters and digits, for comparing wording. */
export function normalizeForMatch(text: string) {
	return text.toLowerCase().normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function similarity(a: string, b: string) {
	const counts = new Map<string, number>();
	for (const g of bigrams(a)) counts.set(g, (counts.get(g) ?? 0) + 1);
	let shared = 0;
	for (const g of bigrams(b)) {
		const n = counts.get(g) ?? 0;
		if (n > 0) {
			shared++;
			counts.set(g, n - 1);
		}
	}
	return (2 * shared) / (a.length - 1 + (b.length - 1));
}

const SAME = 0.9;

function sameFact(a: string, b: string) {
	return a === b || (a.length >= 12 && b.length >= 12 && similarity(a, b) >= SAME);
}

/**
 * An existing memory with the same or nearly the same wording. Catches repeats and small
 * edits ("Prefers oolong tea." / "prefers oolong tea"); a fact reworded entirely is not caught.
 */
export function findDuplicate(memories: Memory[], content: string): Memory | undefined {
	const target = normalizeForMatch(content);
	if (!target) return undefined;
	return memories.find((m) => sameFact(normalizeForMatch(m.content), target));
}

/**
 * Groups of memories that look like the same fact, for review_memories: the same or nearly
 * the same wording, or (when given) the same meaning.
 */
export function duplicateGroups(memories: Memory[], sameMeaning?: (a: Memory, b: Memory) => boolean): Memory[][] {
	const normalized = memories.map((m) => normalizeForMatch(m.content));
	const used = new Set<number>();
	const groups: Memory[][] = [];
	for (let i = 0; i < memories.length; i++) {
		if (used.has(i)) continue;
		const group = [memories[i]];
		for (let j = i + 1; j < memories.length; j++) {
			if (!used.has(j) && (sameFact(normalized[i], normalized[j]) || sameMeaning?.(memories[i], memories[j]))) {
				group.push(memories[j]);
				used.add(j);
			}
		}
		if (group.length > 1) groups.push(group);
	}
	return groups;
}

export function newestFirst(memories: Memory[]): Memory[] {
	return [...memories].sort((a, b) => b.updated.localeCompare(a.updated));
}

/** How a memory is shown to the AI in tool results, with its last earlier version if any. */
export function describe(m: Memory): string {
	const titled = m.title && !m.content.startsWith(m.title.replace(/…$/, ""));
	const last = m.history?.at(-1);
	const before = last ? `\n(Before ${last.until.slice(0, 10)}: ${last.content})` : "";
	return `[${m.id}] ${m.category} · ${m.updated.slice(0, 10)}${titled ? ` · ${m.title}` : ""}\n${m.content}${before}`;
}

/** The text an embedding is computed from. */
export function embeddingText(m: Pick<Memory, "title" | "content">): string {
	const titled = m.title && !m.content.startsWith(m.title.replace(/…$/, ""));
	return titled ? `${m.title}\n${m.content}` : m.content;
}
