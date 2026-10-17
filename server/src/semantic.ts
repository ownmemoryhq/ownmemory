// Meaning-based search. Each memory gets an embedding from Cloudflare Workers AI (bge-m3,
// multilingual), in the owner's own account. Embeddings are derived from memory text, so
// they are stored like everything else: as one encrypted index file in the owner's storage.
// If Workers AI is unavailable or switched off, callers fall back to keyword search.
import { type Memory, embeddingText } from "./format";
import type { MemoryStore } from "./store";

export const EMBED_MODEL = "@cf/baai/bge-m3";

/** Cosine similarity at or above which a new fact is "probably already saved". */
export const SAME_MEANING = 0.9;
/** Stricter bar for skipping facts automatically during import_memories. */
export const IMPORT_SAME_MEANING = 0.95;
/** Bar for grouping memories in review_memories (the user decides what to merge). */
export const REVIEW_SAME_MEANING = 0.88;

interface IndexEntry {
	/** The memory's "updated" value when this embedding was computed. */
	u: string;
	/** Scale for the int8 values. */
	s: number;
	/** Int8 vector, base64. */
	q: string;
}

export interface EmbeddingIndex {
	v: 1;
	model: string;
	entries: Record<string, IndexEntry>;
}

function normalize(v: ArrayLike<number>): Float32Array {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
}

/** Stores a vector in a quarter of the space: int8 values plus one scale. */
export function quantize(v: Float32Array): { s: number; q: string } {
	let max = 0;
	for (const x of v) max = Math.max(max, Math.abs(x));
	const s = max / 127 || 1;
	const bytes = new Uint8Array(v.length);
	for (let i = 0; i < v.length; i++) bytes[i] = Math.round(v[i] / s) & 0xff;
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return { s, q: btoa(bin) };
}

export function dequantize(e: { s: number; q: string }): Float32Array {
	const bin = atob(e.q);
	const v = new Float32Array(bin.length);
	for (let i = 0; i < bin.length; i++) v[i] = ((bin.charCodeAt(i) << 24) >> 24) * e.s;
	return normalize(v);
}

/** Cosine similarity of two normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

export async function embed(ai: Ai, texts: string[]): Promise<Float32Array[]> {
	const out: Float32Array[] = [];
	for (let i = 0; i < texts.length; i += 32) {
		const result = (await ai.run(EMBED_MODEL as Parameters<Ai["run"]>[0], { text: texts.slice(i, i + 32) } as never)) as {
			data?: number[][];
		};
		if (!result.data || result.data.length !== Math.min(32, texts.length - i)) throw new Error("Unexpected embedding response");
		out.push(...result.data.map(normalize));
	}
	return out;
}

/** The encrypted embedding index for one store, kept in step with its memories. */
export class Semantic {
	private loaded: { index: EmbeddingIndex; fileId: string | null } | null = null;

	constructor(
		private readonly store: MemoryStore,
		private readonly ai: Ai,
	) {}

	private async load() {
		if (!this.loaded) {
			const { index, fileId } = await this.store.readIndex();
			this.loaded = {
				index: index && index.model === EMBED_MODEL ? index : { v: 1, model: EMBED_MODEL, entries: {} },
				fileId,
			};
		}
		return this.loaded;
	}

	private async save() {
		const loaded = await this.load();
		loaded.fileId = await this.store.writeIndex(loaded.index, loaded.fileId);
	}

	/** Up-to-date vectors for these memories, computing any that are missing or stale. */
	async vectors(memories: Memory[]): Promise<Map<string, Float32Array>> {
		const { index } = await this.load();
		const stale = memories.filter((m) => index.entries[m.id]?.u !== m.updated);
		const live = new Set(memories.map((m) => m.id));
		const pruned = Object.keys(index.entries).filter((id) => !live.has(id));
		for (const id of pruned) delete index.entries[id];
		if (stale.length) {
			const vectors = await embed(this.ai, stale.map(embeddingText));
			stale.forEach((m, i) => {
				index.entries[m.id] = { u: m.updated, ...quantize(vectors[i]) };
			});
		}
		if (stale.length || pruned.length) await this.save();
		return new Map(memories.map((m) => [m.id, dequantize(index.entries[m.id])]));
	}

	async embedText(text: string): Promise<Float32Array> {
		const [v] = await embed(this.ai, [text]);
		return v;
	}

	/** Several texts in batched calls. */
	embedTexts(texts: string[]): Promise<Float32Array[]> {
		return embed(this.ai, texts);
	}

	/** Records the vectors of memories just created or updated, in one index write. */
	async remember(items: { memory: Memory; vector?: Float32Array }[]) {
		if (!items.length) return;
		const { index } = await this.load();
		const missing = items.filter((i) => !i.vector);
		const computed = missing.length ? await embed(this.ai, missing.map((i) => embeddingText(i.memory))) : [];
		missing.forEach((item, i) => {
			item.vector = computed[i];
		});
		for (const { memory, vector } of items) index.entries[memory.id] = { u: memory.updated, ...quantize(vector!) };
		await this.save();
	}
}

/** The closest memory to a vector, if any. */
export function closest(vector: Float32Array, vectors: Map<string, Float32Array>): { id: string; similarity: number } | null {
	let best: { id: string; similarity: number } | null = null;
	for (const [id, v] of vectors) {
		const similarity = cosine(vector, v);
		if (!best || similarity > best.similarity) best = { id, similarity };
	}
	return best;
}
