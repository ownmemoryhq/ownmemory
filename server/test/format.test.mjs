import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown, looksLikeSecret, searchMemories, toMarkdown } from "../src/format.ts";

const base = { source: "claude", created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z" };

test("markdown round-trips, including quotes and newlines in titles", () => {
	const m = { ...base, title: 'Says "hi": often', category: "preference", content: "Line one\n\nLine two" };
	assert.deepEqual(fromMarkdown("abc", toMarkdown(m)), { id: "abc", ...m });
});

test("search finds English words and Chinese phrases without spaces", () => {
	const memories = [
		{ ...base, id: "1", title: "Tea", category: "preference", content: "喜欢喝乌龙茶，不喝咖啡" },
		{ ...base, id: "2", title: "Job", category: "work", content: "Works as a data engineer in Lisbon" },
		{ ...base, id: "3", title: "Pet", category: "profile", content: "Has a cat named Mochi" },
	];
	assert.deepEqual(searchMemories(memories, "lisbon engineer", 5).map((m) => m.id), ["2"]);
	assert.deepEqual(searchMemories(memories, "乌龙茶", 5).map((m) => m.id), ["1"]);
	assert.deepEqual(searchMemories(memories, "喝什么茶", 5).map((m) => m.id), ["1"]);
	assert.deepEqual(searchMemories(memories, "mochi", 5).map((m) => m.id), ["3"]);
	assert.equal(searchMemories(memories, "", 2).length, 2);
});

test("secret detection catches credentials but not ordinary facts", () => {
	assert.ok(looksLikeSecret("my password is hunter22"));
	assert.ok(looksLikeSecret("API key sk-abcdefghijklmnopqrstuvwx"));
	assert.ok(looksLikeSecret("密码是 123456"));
	assert.ok(looksLikeSecret("card 4111 1111 1111 1111"));
	assert.ok(!looksLikeSecret("Prefers window seats on long flights"));
	assert.ok(!looksLikeSecret("Uses a password manager for everything"));
});

test("duplicates: same or nearly the same wording, not different facts", async () => {
	const { findDuplicate, duplicateGroups } = await import("../src/format.ts");
	const m = (id, content) => ({ ...base, id, title: "", category: "preference", content });
	const memories = [m("1", "Prefers oolong tea over coffee."), m("2", "喜欢喝乌龙茶，不喝咖啡。"), m("3", "Works as a data engineer in Lisbon")];
	assert.equal(findDuplicate(memories, "prefers oolong tea over coffee")?.id, "1");
	assert.equal(findDuplicate(memories, "Prefers oolong tea over coffees.")?.id, "1");
	assert.equal(findDuplicate(memories, "喜欢喝乌龙茶,不喝咖啡")?.id, "2");
	assert.equal(findDuplicate(memories, "Prefers green tea over coffee."), undefined);
	assert.equal(findDuplicate(memories, "Works as a data scientist in Lisbon"), undefined);
	const groups = duplicateGroups([...memories, m("4", "Prefers oolong tea over coffee")]);
	assert.deepEqual(groups.map((g) => g.map((x) => x.id)), [["1", "4"]]);
});

test("history survives the round trip and shows the last earlier version", async () => {
	const { fromMarkdown, toMarkdown, describe } = await import("../src/format.ts");
	const m = {
		...base,
		title: "Home",
		category: "profile",
		content: "Lives in Austin.",
		history: [{ content: "Lives in Lisbon.", until: "2026-09-01T00:00:00.000Z" }],
	};
	const back = fromMarkdown("h1", toMarkdown(m));
	assert.deepEqual(back.history, m.history);
	assert.match(describe(back), /Before 2026-09-01: Lives in Lisbon\./);
	assert.equal(fromMarkdown("h2", toMarkdown({ ...m, history: undefined })).history, undefined);
});

test("hybrid search ranks by meaning, keeps keyword hits, drops unrelated memories", async () => {
	const { hybridSearch } = await import("../src/format.ts");
	const m = (id, content) => ({ ...base, id, title: "", category: "preference", content });
	const memories = [m("tea", "Prefers oolong tea over coffee."), m("job", "Works as a data engineer."), m("cat", "Has a cat named Mochi.")];
	// "What do I like to drink?" shares no keywords with the tea memory; meaning finds it.
	const sims = new Map([["tea", 0.71], ["job", 0.32], ["cat", 0.28]]);
	assert.deepEqual(hybridSearch(memories, "What do I like to drink?", sims, 5).map((x) => x.id), ["tea"]);
	// A keyword hit stays even when its meaning score is low.
	assert.deepEqual(hybridSearch(memories, "Mochi", new Map([["cat", 0.2]]), 5).map((x) => x.id), ["cat"]);
	// Without any similarity scores it behaves like keyword search.
	assert.deepEqual(hybridSearch(memories, "engineer", new Map(), 5).map((x) => x.id), ["job"]);
});
