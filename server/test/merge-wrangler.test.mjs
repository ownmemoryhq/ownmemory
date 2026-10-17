import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { mergeWrangler, ownValues } from "../scripts/merge-wrangler.mjs";

// The release's config: no ids, as in the repo.
const release = `{
	"name": "ownmemory",
	"main": "src/index.ts",
	"kv_namespaces": [{ "binding": "OAUTH_KV" }],
	"d1_databases": [{ "binding": "DB", "database_name": "ownmemory" }],
	"vars": { "STORAGE": "d1" },
	"ai": { "binding": "AI" },
	"observability": { "enabled": true }
}`;

// What the deploy button committed to a user's copy (Cloudflare's own formatting).
const deployed = `{
	"name": "my-memory",
	"main": "src/index.ts",
	"kv_namespaces": [{ "binding": "OAUTH_KV","id": "0123456789abcdef0123456789abcdef" }],
	"d1_databases": [{ "binding": "DB", "database_name": "ownmemory","database_id": "00000000-1111-2222-3333-444444444444" }],
	"vars": { "STORAGE": "d1" }
}`;

test("an update keeps the server's name and resource ids", () => {
	const merged = mergeWrangler(deployed, release);
	assert.deepEqual(ownValues(merged), { name: "my-memory", kvId: "0123456789abcdef0123456789abcdef", dbId: "00000000-1111-2222-3333-444444444444" });
	assert.match(merged, /"observability": \{ "enabled": true \}/, "new settings come through");
	assert.equal(mergeWrangler(merged, release), merged, "running it again changes nothing");
});

test("an update refuses to guess when the server's ids are missing", () => {
	assert.throws(() => mergeWrangler(release, release), /Couldn't find this server's kvId, dbId/);
});

test("the shipped wrangler.jsonc merges cleanly", async () => {
	const shipped = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	const merged = mergeWrangler(deployed, shipped);
	assert.deepEqual(ownValues(merged), ownValues(deployed));
});
