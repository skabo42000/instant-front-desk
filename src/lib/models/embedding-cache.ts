import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingAdapter } from "./embeddings";

// Store vectors only, never website text. Model and dimensions keep vector spaces separate.
export function cachedEmbeddings(adapter: EmbeddingAdapter, directory: string): EmbeddingAdapter {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    model: adapter.model, dimensions: adapter.dimensions,
    async embed(text) {
      const textHash = hash(text);
      const path = join(directory, `${hash(JSON.stringify([adapter.model, adapter.dimensions, textHash]))}.json`);
      const valid = (values: unknown): values is number[] => Array.isArray(values) &&
        values.length === adapter.dimensions && values.every(v => typeof v === "number" && Number.isFinite(v));
      try {
        const entry = JSON.parse(await readFile(path, "utf8"));
        if (entry.model === adapter.model && entry.dimensions === adapter.dimensions &&
          entry.textHash === textHash && valid(entry.values)) return entry.values;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const values = await adapter.embed(text);
      if (!valid(values)) throw new Error("Invalid embedding dimension/values");
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ model: adapter.model, dimensions: adapter.dimensions, textHash, values }), { mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      return values;
    },
  };
}
