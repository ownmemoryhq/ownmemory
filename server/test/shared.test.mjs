import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// ownmemory.app/decrypt runs copies of these files; `npm run sync-site` refreshes them.
test("the site's decrypt page uses the same key, format and zip code", async () => {
	for (const name of ["keys.js", "memory-file.js", "zip.js"]) {
		const server = await readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
		const site = await readFile(new URL(`../../site/public/${name}`, import.meta.url), "utf8");
		assert.equal(site, server, `site/public/${name} differs: run npm run sync-site`);
	}
});
