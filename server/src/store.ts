// Memories as encrypted files in the customer's storage. Plain text exists only in memory
// during a request; the cache below holds ciphertext only.
import { decryptMemory, encryptMemory } from "../public/keys.js";
import { type Memory, type MemoryFields, fromMarkdown, toMarkdown } from "./format";
import type { EmbeddingIndex } from "./semantic";
import { type Settings, newSettings, parseSettings } from "./settings";
import type { FileRef, Storage } from "./storage";

// Ciphertext by file id, reused while the file's modifiedTime is unchanged, so a search does
// not download every file each time. Unreadable without the memory key.
const cache = new Map<string, { modified: string; body: string }>();
const CACHE_LIMIT = 5000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function randomName() {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return `${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}.omem`;
}

export class MemoryStore {
	constructor(
		private readonly storage: Storage,
		private readonly key: CryptoKey,
	) {}

	private async body(file: FileRef): Promise<string> {
		const hit = cache.get(file.id);
		if (hit && hit.modified === file.modifiedTime) return hit.body;
		const body = await this.storage.read(file.id);
		if (cache.size >= CACHE_LIMIT) cache.clear();
		cache.set(file.id, { modified: file.modifiedTime, body });
		return body;
	}

	private remember(file: FileRef, body: string) {
		cache.set(file.id, { modified: file.modifiedTime, body });
	}

	private async read(file: FileRef): Promise<Memory | null> {
		try {
			return fromMarkdown(file.id, await decryptMemory(this.key, await this.body(file)));
		} catch {
			return null; // not decryptable with this key, or damaged: skip it
		}
	}

	/** Every memory, decrypted. Files that fail to decrypt are skipped and counted. */
	async all(): Promise<{ memories: Memory[]; unreadable: number }> {
		const files = await this.storage.list("memory");
		const read = await mapLimit(files, 8, (f) => this.read(f));
		const memories = read.filter((m): m is Memory => m !== null);
		return { memories, unreadable: files.length - memories.length };
	}

	async get(id: string): Promise<Memory | null> {
		const file = await this.storage.find(id, "memory");
		return file ? this.read(file) : null;
	}

	async create(fields: MemoryFields): Promise<Memory> {
		const body = await encryptMemory(this.key, toMarkdown(fields));
		const file = await this.storage.create("memory", randomName(), body);
		this.remember(file, body);
		return { id: file.id, ...fields };
	}

	async update(memory: Memory): Promise<Memory> {
		const { id, ...fields } = memory;
		const body = await encryptMemory(this.key, toMarkdown(fields));
		this.remember(await this.storage.update(id, body), body);
		return memory;
	}

	/** The memory mode and ramp-up state; created (as ramp-up) the first time it is read. */
	async settings(now = new Date()): Promise<{ settings: Settings; fileId: string }> {
		const [file] = await this.storage.list("settings");
		if (file) {
			try {
				return { settings: parseSettings(await decryptMemory(this.key, await this.body(file)), now), fileId: file.id };
			} catch {
				// unreadable: fall through and replace it with fresh settings
			}
		}
		const settings = newSettings(now);
		const body = await encryptMemory(this.key, JSON.stringify(settings));
		const saved = file ? await this.storage.update(file.id, body) : await this.storage.create("settings", "settings.omem", body);
		this.remember(saved, body);
		return { settings, fileId: saved.id };
	}

	async saveSettings(fileId: string, settings: Settings) {
		const body = await encryptMemory(this.key, JSON.stringify(settings));
		this.remember(await this.storage.update(fileId, body), body);
	}

	/** The encrypted embedding index (see semantic.ts), if one exists yet. */
	async readIndex(): Promise<{ index: EmbeddingIndex | null; fileId: string | null }> {
		const [file] = await this.storage.list("index");
		if (!file) return { index: null, fileId: null };
		try {
			return { index: JSON.parse(await decryptMemory(this.key, await this.body(file))), fileId: file.id };
		} catch {
			return { index: null, fileId: file.id }; // unreadable: it gets rebuilt
		}
	}

	async writeIndex(index: EmbeddingIndex, fileId: string | null): Promise<string> {
		const body = await encryptMemory(this.key, JSON.stringify(index));
		const saved = fileId ? await this.storage.update(fileId, body) : await this.storage.create("index", "index.omem", body);
		this.remember(saved, body);
		return saved.id;
	}

	async remove(id: string): Promise<boolean> {
		if (!(await this.storage.find(id, "memory"))) return false;
		await this.storage.remove(id);
		cache.delete(id);
		return true;
	}
}
