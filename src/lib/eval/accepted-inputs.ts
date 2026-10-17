import "server-only";
import { benchmarkHash, fingerprint, reviewProvenance, validateBenchmark, type Benchmark } from "./benchmark";

export interface QueryCache {
  schema: 1;
  snapshotHash: string;
  model: string;
  queries: Record<string, number[]>;
}

// Acceptance here means reviewed dataset input, never human validation or release approval.
export function acceptedInputs(bundle: Benchmark, prior: QueryCache) {
  validateBenchmark(bundle);
  if (bundle.review?.method !== "ai") throw new Error("This preparation requires explicit AI review");
  if (prior.schema !== 1 || prior.snapshotHash !== bundle.snapshotHash || prior.model !== bundle.snapshot.business.embeddingModel) {
    throw new Error("Prior query cache mismatch");
  }
  const provenance = reviewProvenance(bundle);
  const queries: Record<string, number[]> = {};
  const needsEmbedding: { id: string; question: string }[] = [];
  for (const q of bundle.cases) {
    const key = fingerprint(q.question);
    const vector = prior.queries[key];
    if (vector?.length === 768 && vector.every(Number.isFinite)) queries[key] = [...vector];
    else needsEmbedding.push({ id: q.id, question: q.question });
  }
  return {
    bundle: { ...bundle, ...provenance },
    cache: { schema: 1 as const, snapshotHash: bundle.snapshotHash, model: prior.model,
      queries, benchmarkHash: benchmarkHash(bundle), ...provenance },
    needsEmbedding,
  };
}
