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
	"kv_namespaces": [{ "binding": "OAUTH_KV","id": "4c3e586cf1f44c02a438565900799fab" }],
	"d1_databases": [{ "binding": "DB", "database_name": "ownmemory","database_id": "ebab74a6-17a2-4e7b-ac35-f73783ef3281" }],
	"vars": { "STORAGE": "d1" }
}`;

test("an update keeps the server's name and resource ids", () => {
	const merged = mergeWrangler(deployed, release);
	assert.deepEqual(ownValues(merged), { name: "my-memory", kvId: "4c3e586cf1f44c02a438565900799fab", dbId: "ebab74a6-17a2-4e7b-ac35-f73783ef3281" });
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
