// Decrypts a downloaded OwnMemory folder into a zip of Markdown files, entirely in the
// browser. The page's Content-Security-Policy (src/index.ts) forbids network requests.
// keys.js, memory-file.js and zip.js are copies of server/public (npm run sync-site there).
import { decryptMemory, importMemoryKey, unlockWithPassphrase, unlockWithRecoveryCode } from "/keys.js";
import { fromMarkdown } from "/memory-file.js";
import { download, memoryFileName, zip } from "/zip.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const form = document.getElementById("decrypt-form");
const status = form.querySelector(".status");

/** Reads the files out of a zip, such as the one Google Drive makes when downloading a folder. */
async function unzip(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(bytes.buffer);
	let end = bytes.length - 22;
	while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) throw new Error(`${blob.name} is not a zip file.`);
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const files = [];
	for (let i = 0; i < count; i++) {
		if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`${blob.name} looks damaged.`);
		const method = view.getUint16(at + 10, true);
		const size = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extraLength + commentLength;

		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = bytes.subarray(start, start + size);
		const base = name.split("/").pop();
		if (!base || !(base.endsWith(".omem") || base === "keyinfo.json")) continue;
		if (method === 0) files.push({ name: base, text: dec.decode(data) });
		else if (method === 8) {
			const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
			files.push({ name: base, text: await new Response(stream).text() });
		} else throw new Error(`${blob.name} uses a compression this page can't read.`);
	}
	return files;
}

async function readPicked(picked) {
	const files = [];
	for (const file of picked) {
		if (file.name.toLowerCase().endsWith(".zip")) files.push(...(await unzip(file)));
		else files.push({ name: file.name, text: await file.text() });
	}
	return files;
}

/** The passphrase, or failing that the recovery key, unlocks the memory key. */
async function unlock(keyinfo, secret) {
	try {
		return await unlockWithPassphrase(keyinfo, secret);
	} catch (passphraseError) {
		try {
			return await unlockWithRecoveryCode(keyinfo, secret);
		} catch {
			throw passphraseError;
		}
	}
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const button = form.querySelector("button[type=submit]");
	status.textContent = "";
	button.disabled = true;
	button.textContent = "Decrypting…";
	try {
		const files = await readPicked([...form.elements.files.files]);
		const keyfile = files.find((f) => f.name === "keyinfo.json");
		if (!keyfile) throw new Error("keyinfo.json is missing: it holds your locked memory key. Pick the whole zip, or every file in the folder.");
		const key = await importMemoryKey(await unlock(JSON.parse(keyfile.text), form.elements.secret.value));
		form.elements.secret.value = "";

		const entries = [];
		let failed = 0;
		for (const file of files.filter((f) => f.name.endsWith(".omem") && f.name !== "index.omem")) {
			try {
				const text = await decryptMemory(key, file.text);
				if (file.name === "settings.omem") {
					entries.push({ name: "settings.json", data: enc.encode(text) });
					continue;
				}
				const id = file.name.replace(/\.omem$/, "");
				entries.push({ name: memoryFileName(fromMarkdown(id, text).title, id), data: enc.encode(text) });
			} catch {
				failed++;
			}
		}
		const count = entries.filter((e) => e.name.endsWith(".md")).length;
		if (!count && !failed) throw new Error("No memories found in what you picked.");
		download(zip(entries));
		status.textContent = `Downloaded ${count} memories${failed ? `; ${failed} files could not be decrypted` : ""}.`;
	} catch (error) {
		status.textContent = error.message || String(error);
	} finally {
		button.disabled = false;
		button.textContent = "Decrypt and download";
	}
});
