// Recall evaluation with real embeddings: keyword search vs hybrid search on fixed memories
// and questions, plus how well the "same meaning" thresholds separate paraphrases from
// different facts. Run with: npm run eval (calls Workers AI; well within the free allowance).
import { type Memory, hybridSearch, searchMemories } from "../../src/format";
import {
	IMPORT_SAME_MEANING,
	REVIEW_SAME_MEANING,
	SAME_MEANING,
	cosine,
	dequantize,
	embed,
	quantize,
} from "../../src/semantic";
import fixtures from "./fixtures.json";

interface Env {
	AI: Ai;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export default {
	async fetch(_request, env) {
		const now = new Date().toISOString();
		const memories: Memory[] = fixtures.memories.map((m) => ({
			...m,
			category: m.category as Memory["category"],
			title: m.content,
			source: "eval",
			created: now,
			updated: now,
		}));
		const docs = await embed(env.AI, memories.map((m) => m.content));
		const stored = docs.map((v) => dequantize(quantize(v))); // as kept in the encrypted index
		const queryVectors = await embed(env.AI, fixtures.queries.map((q) => q.q));

		const queries = fixtures.queries.map((q, i) => {
			const sims = new Map(memories.map((m, j) => [m.id, cosine(queryVectors[i], stored[j])]));
			const keyword = searchMemories(memories, q.q, 3).map((m) => m.id);
			const hybrid = hybridSearch(memories, q.q, sims, 3).map((m) => m.id);
			return {
				q: q.q,
				expect: q.expect,
				keyword,
				hybrid,
				expectedSimilarity: round(sims.get(q.expect) ?? 0),
				bestOtherSimilarity: round(Math.max(...[...sims].filter(([id]) => id !== q.expect).map(([, s]) => s))),
			};
		});
		const rate = (pick: (r: (typeof queries)[number]) => string[], k: number) =>
			round(queries.filter((r) => pick(r).slice(0, k).includes(r.expect)).length / queries.length);

		const pairVectors = await embed(env.AI, fixtures.pairs.flatMap((p) => [p.a, p.b]));
		const pairs = fixtures.pairs.map((p, i) => ({
			...p,
			similarity: round(cosine(pairVectors[2 * i], pairVectors[2 * i + 1])),
		}));
		const judge = (threshold: number) => ({
			threshold,
			paraphrasesCaught: `${pairs.filter((p) => p.same && p.similarity >= threshold).length}/${pairs.filter((p) => p.same).length}`,
			differentFactsWronglyFlagged: `${pairs.filter((p) => !p.same && p.similarity >= threshold).length}/${pairs.filter((p) => !p.same).length}`,
		});

		return Response.json({
			retrieval: {
				queries: queries.length,
				keyword: { hitAt1: rate((r) => r.keyword, 1), hitAt3: rate((r) => r.keyword, 3) },
				hybrid: { hitAt1: rate((r) => r.hybrid, 1), hitAt3: rate((r) => r.hybrid, 3) },
			},
			quantization: { worstCosineToOriginal: round(Math.min(...docs.map((v, i) => cosine(v, stored[i])))) },
			sameMeaning: [judge(REVIEW_SAME_MEANING), judge(SAME_MEANING), judge(IMPORT_SAME_MEANING)],
			misses: queries.filter((r) => !r.hybrid.includes(r.expect)),
			pairs,
		});
	},
} satisfies ExportedHandler<Env>;
