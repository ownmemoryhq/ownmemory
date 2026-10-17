#!/usr/bin/env node
// Used by the "Update OwnMemory" workflow: takes the new release's wrangler.jsonc and carries
// over what belongs to this server, so the update deploys to the same Worker and data:
//   - the Worker name ("name")
//   - the KV namespace id (OAUTH_KV) and the D1 database id (DB), which the deploy button wrote
//     into this repository on the first deploy
//
//   node scripts/merge-wrangler.mjs <current wrangler.jsonc> <new wrangler.jsonc> <output>
import { readFile, writeFile } from "node:fs/promises";

/** The values in this server's config that an update must keep. */
export function ownValues(text) {
	return {
		name: /^\s*"name":\s*"([^"]+)"/m.exec(text)?.[1],
		kvId: /"binding":\s*"OAUTH_KV"\s*,\s*"id":\s*"([^"]+)"/.exec(text)?.[1],
		dbId: /"binding":\s*"DB"[^}]*"database_id":\s*"([^"]+)"/.exec(text)?.[1],
	};
}

/** The new config with this server's name and resource ids put back. Throws if any is missing. */
export function mergeWrangler(current, next) {
	const own = ownValues(current);
	if (!own.name || !own.kvId || !own.dbId) {
		throw new Error(
			`Couldn't find this server's ${["name", "kvId", "dbId"].filter((k) => !own[k]).join(", ")} in wrangler.jsonc, so nothing was changed.`,
		);
	}
	let out = next.replace(/^(\s*"name":\s*)"[^"]+"/m, `$1"${own.name}"`);
	// Drop any ids the new file carries (it shouldn't), then add this server's.
	out = out.replace(/("binding":\s*"OAUTH_KV")\s*,\s*"id":\s*"[^"]*"/, "$1");
	out = out.replace(/("binding":\s*"OAUTH_KV")/, `$1, "id": "${own.kvId}"`);
	out = out.replace(/("binding":\s*"DB"[^}]*?)\s*,\s*"database_id":\s*"[^"]*"/, "$1");
	out = out.replace(/("binding":\s*"DB"[^}]*?"database_name":\s*"[^"]+")/, `$1, "database_id": "${own.dbId}"`);
	const check = ownValues(out);
	if (check.name !== own.name || check.kvId !== own.kvId || check.dbId !== own.dbId) {
		throw new Error("The new wrangler.jsonc has an unexpected layout, so nothing was changed.");
	}
	return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [currentPath, nextPath, outPath] = process.argv.slice(2);
	if (!currentPath || !nextPath || !outPath) {
		console.error("Usage: node scripts/merge-wrangler.mjs <current> <new> <output>");
		process.exit(1);
	}
	const merged = mergeWrangler(await readFile(currentPath, "utf8"), await readFile(nextPath, "utf8"));
	await writeFile(outPath, merged);
}
