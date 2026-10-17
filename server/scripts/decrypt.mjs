#!/usr/bin/env node
// Turns a downloaded OwnMemory folder back into plain Markdown, entirely on your computer.
//
//   1. In Google Drive, right-click the OwnMemory folder → Download, and unzip it.
//   2. node scripts/decrypt.mjs ~/Downloads/OwnMemory --out ~/Desktop/my-memories
//
// Add --recovery to unlock with your recovery key instead of your passphrase.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { decryptMemory, importMemoryKey, unlockWithPassphrase, unlockWithRecoveryCode } from "../public/keys.js";

function usage(message) {
	if (message) console.error(`${message}\n`);
	console.error("Usage: node scripts/decrypt.mjs <OwnMemory folder> [--out <dir>] [--recovery]");
	process.exit(1);
}

async function ask(question, { hidden = false } = {}) {
	if (!process.stdin.isTTY) {
		// Piped input: take the first line.
		let input = "";
		for await (const chunk of process.stdin) input += chunk;
		return input.split(/\r?\n/)[0];
	}
	return new Promise((done) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (hidden) {
			rl._writeToOutput = (s) => {
				if (s.includes(question)) rl.output.write(s);
			};
		}
		rl.question(question, (answer) => {
			rl.close();
			if (hidden) process.stdout.write("\n");
			done(answer);
		});
	});
}

function slug(text) {
	const s = text
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return s || "memory";
}

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const outIndex = args.indexOf("--out");
const out = resolve(outIndex >= 0 ? args[outIndex + 1] ?? usage("--out needs a folder") : "ownmemory-export");
const useRecovery = args.includes("--recovery");
if (!folder) usage();

const keyinfo = JSON.parse(await readFile(join(folder, "keyinfo.json"), "utf8").catch(() => usage(`No keyinfo.json in ${folder}`)));
const secret = await ask(useRecovery ? "Recovery key: " : "Passphrase: ", { hidden: !useRecovery });
const memoryKey = await (useRecovery ? unlockWithRecoveryCode(keyinfo, secret) : unlockWithPassphrase(keyinfo, secret)).catch(
	(error) => usage(error.message),
);
const key = await importMemoryKey(memoryKey);

await mkdir(out, { recursive: true });
// index.omem holds search embeddings, not a memory.
const files = (await readdir(folder)).filter((f) => f.endsWith(".omem") && f !== "index.omem");
let written = 0;
let failed = 0;
for (const file of files) {
	try {
		const text = await decryptMemory(key, await readFile(join(folder, file), "utf8"));
		if (file === "settings.omem") {
			await writeFile(join(out, "settings.json"), text);
			continue;
		}
		const title = /^title: (.*)$/m.exec(text)?.[1];
		const name = `${slug(title ? JSON.parse(title) : "")}-${basename(file, ".omem").slice(0, 8)}.md`;
		await writeFile(join(out, name), text);
		written++;
	} catch {
		failed++;
		console.error(`Could not decrypt ${file}`);
	}
}
console.log(`Wrote ${written} memories to ${out}${failed ? ` (${failed} failed)` : ""}.`);
