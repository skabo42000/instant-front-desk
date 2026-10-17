import type { RetrievedChunk } from "../answer";

export function retrievalMetrics(gold: readonly string[], ranked: readonly { id: string }[], evidenceGroups?: readonly (readonly string[])[]) {
  const groups = evidenceGroups ?? [...new Set(gold)].map(id => [id]);
  const relevant = new Set(groups.flat());
  if (!groups.length) return { recallAt1: null, recallAt5: null, recallAt8: null, poolRecall: null, complete: null, reciprocalRank: null };
  const recall = (n: number) => {
    const found = new Set(ranked.slice(0, n).map(c => c.id));
    return groups.filter(group => group.some(id => found.has(id))).length / groups.length;
  };
  const first = ranked.findIndex(c => relevant.has(c.id));
  return { recallAt1: recall(1), recallAt5: recall(5), recallAt8: recall(8), poolRecall: recall(ranked.length),
    complete: recall(ranked.length) === 1, reciprocalRank: first === -1 ? 0 : 1 / (first + 1) };
}
const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
// CPU-only BM25 experiment on the SAME hybrid candidate pool. This is a lexical reranker,
// not a neural cross-encoder. It never sees expected answers or gold evidence IDs.
export function bm25Rerank(question: string, chunks: readonly RetrievedChunk[]): RetrievedChunk[] {
  if (!chunks.length) return [];
  const docs = chunks.map(c => words(`${c.heading} ${c.heading} ${c.text}`));
  const averageLength = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const query = [...new Set(words(question))];
  return chunks.map((chunk, index) => {
    const doc = docs[index];
    const score = query.reduce((sum, term) => {
      const frequency = doc.filter(w => w === term).length;
      const df = docs.filter(d => d.includes(term)).length;
      return sum + Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) *
        (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * doc.length / averageLength));
    }, 0);
    return { chunk, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(r => r.chunk);
}
