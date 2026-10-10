import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "../../src/lib/db/client";

export const FAKE_EMBEDDING_MODEL = "fake-sha256-v1";

// Stable offline vectors for database tests; these do not model semantic similarity.
export function fakeEmbedding(text: string): number[] {
  const hash = createHash("sha256").update(text, "utf8").digest();
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (hash[i % hash.length] - 128) / 128);
}
