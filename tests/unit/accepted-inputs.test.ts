import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { acceptedInputs, type QueryCache } from "../../src/lib/eval/accepted-inputs";
import { applyAiReview, type AiReviewNotes } from "../../src/lib/eval/ai-review";
import { benchmarkHash, fingerprint, type Benchmark } from "../../src/lib/eval/benchmark";

async function fixture(site: string) {
  const base = `benchmarks/owned-sites/2026-10-15/${site}`;
  const json = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`${base}/${name}`, "utf8"));
  const draft = await json<Benchmark>("draft.json");
  return { bundle: applyAiReview(draft, await json<AiReviewNotes>("ai-review-notes.json")), cache: await json<QueryCache>("queries.json") };
}

it.each(["synq", "salon"])("preserves %s reviewed labels, vectors and hashes without human claims", async site => {
  const { bundle, cache } = await fixture(site);
  const before = fingerprint({ bundle, cache });
  const result = acceptedInputs(bundle, cache);
  expect(result.needsEmbedding).toEqual([]);
  expect(result.bundle).toMatchObject({ reviewMethod: "ai", humanReviewed: false, provisional: true });
  expect(result.cache).toMatchObject({ reviewMethod: "ai", humanReviewed: false, provisional: true });
  expect(benchmarkHash(result.bundle)).toBe(benchmarkHash(bundle));
  expect(result.bundle.cases.filter(q => q.kind === "source")).toHaveLength(20);
  expect(new Set(result.bundle.cases.filter(q => q.kind !== "source").map(q => q.kind)).size).toBe(6);
  expect(Object.keys(result.cache.queries)).toHaveLength(26);
  expect(result.cache.queries).toEqual(cache.queries);
  expect(fingerprint({ bundle, cache })).toBe(before);
});

it("lists changed questions and invalid vectors exactly instead of silently embedding them", async () => {
  const { bundle, cache } = await fixture("synq");
  bundle.cases[0].question = "A changed question for the offline regression?";
  cache.queries[fingerprint(bundle.cases[1].question)] = Array(768).fill(NaN);
  const result = acceptedInputs(bundle, cache);
  expect(result.needsEmbedding).toEqual(bundle.cases.slice(0, 2).map(({ id, question }) => ({ id, question })));
  expect(Object.keys(result.cache.queries)).toHaveLength(24);
});

it("rejects foreign snapshot/vector spaces and non-AI provenance", async () => {
  const { bundle, cache } = await fixture("salon");
  for (const bad of [{ ...cache, schema: 2 }, { ...cache, model: "foreign" }, { ...cache, snapshotHash: "foreign" }]) {
    expect(() => acceptedInputs(bundle, bad as QueryCache)).toThrow("mismatch");
  }
  bundle.review!.method = "human";
  expect(() => acceptedInputs(bundle, cache)).toThrow("explicit AI");
  bundle.review = null;
  expect(() => acceptedInputs(bundle, cache)).toThrow("review provenance");
});
