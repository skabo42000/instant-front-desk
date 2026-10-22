import "server-only";
import { randomUUID } from "node:crypto";
import { chunkPage, contentHash, stableId } from "./chunk";
import { crawl, DEFAULT_CRAWL_LIMITS, type CrawlOptions } from "./crawl/crawl";
import { FakeEmbeddings, type EmbeddingAdapter } from "./models/embeddings";
import { assertEmbeddingSpace } from "./retrieve";
import type { businessRepository } from "./db/repository";

export class IngestionError extends Error {
  constructor(readonly reason: "robots" | "empty" | "incomplete" | "unreachable", message: string) { super(message); }
}

export async function ingest(url: string, repo: ReturnType<typeof businessRepository>,
  options: { adapter?: EmbeddingAdapter; crawlOptions?: CrawlOptions; batchEmbeddings?: boolean } = {},
) {
  const adapter: EmbeddingAdapter = options.adapter ?? new FakeEmbeddings();
  await assertEmbeddingSpace(repo, adapter);
  const business = (await repo.getBusiness())!;
  if (new URL(url).origin !== new URL(business.sourceUrl).origin) throw new Error("Business source origin mismatch");
  const result = await crawl(url, options.crawlOptions);
  // Strict callers reject partial snapshots; the box explicitly accepts skipped/truncated pages.
  if (result.status !== "completed" || result.errors.length || !result.pages.length) {
    const first = result.errors[0];
    const reason = result.errors.some(error => error.message === "Robots disallow.") ? "robots"
      : result.errors.length ? (result.pages.length ? "incomplete" : "unreachable") : "empty";
    throw new IngestionError(reason, `Crawl incomplete (${result.status}, ${result.pages.length} pages, ${result.errors.length} errors${first ? `; first: ${first.url} ${first.message}` : ""}); ingestion not stored`);
  }
  const preparedPages = result.pages.map(page => {
    const pageId = stableId(page.url);
    return { id: pageId, url: page.url, title: page.title, cleanText: page.cleanText,
      contentHash: contentHash(page.cleanText), chunks: chunkPage(page.url, page.sections).map(chunk => ({ ...chunk, pageId })) };
  });
  const texts = preparedPages.flatMap(page => page.chunks.map(chunk => `${chunk.heading}\n${chunk.text}`));
  if (!texts.length) throw new IngestionError("empty", "No readable pages; ingestion not stored");
  let vectors: readonly (readonly number[])[];
  if (options.batchEmbeddings) {
    if (!adapter.embedMany) throw new Error("Batch embeddings required");
    // Count/preflight the entire website before embedding any of its chunks.
    vectors = await adapter.embedMany(texts);
  } else {
    const singleVectors = [];
    for (const text of texts) singleVectors.push(await adapter.embed(text));
    vectors = singleVectors;
  }
  if (vectors.length !== texts.length || vectors.some(vector => vector.length !== adapter.dimensions || !vector.every(Number.isFinite))) {
    throw new Error("Invalid embedding dimension/values");
  }
  let index = 0;
  const pages = preparedPages.map(page => ({ ...page, chunks: page.chunks.map(chunk => ({ ...chunk,
    embedding: vectors[index++], embeddingModel: adapter.model, embeddingDimensions: adapter.dimensions })) }));
  await repo.storeIngestion(randomUUID(), pages, { ...DEFAULT_CRAWL_LIMITS, ...options.crawlOptions?.limits });
  return { pages: pages.length, chunks: pages.reduce((sum, page) => sum + page.chunks.length, 0),
    embeddingModel: adapter.model, embeddingDimensions: adapter.dimensions,
    ...(options.crawlOptions?.policy === "tolerant" ? { skipped: result.skipped?.length ?? 0, truncated: result.truncated ?? false } : {}) };
}
