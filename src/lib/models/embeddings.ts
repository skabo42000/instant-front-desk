import "server-only";
import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "../db/client";

export interface EmbeddingAdapter {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<readonly number[]>;
  embedMany?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
const stopWords = new Set("a an the is are do does what when where how can i you your of for to and me please tell about".split(" "));

// Token overlap only: deterministic offline plumbing, not semantic model quality.
export class FakeEmbeddings implements EmbeddingAdapter {
  readonly model = "fake-token-hash-v1";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  async embed(text: string): Promise<number[]> {
    const vector = Array<number>(this.dimensions).fill(0);
    for (const token of new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])) {
      if (stopWords.has(token)) continue;
      const hash = createHash("sha256").update(token).digest();
      vector[hash.readUInt32BE(0) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm ? vector.map(value => value / norm) : vector;
  }
}
