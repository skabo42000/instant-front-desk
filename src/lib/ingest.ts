import "server-only";
import { randomUUID } from "node:crypto";
import { chunkPage, contentHash, stableId } from "./chunk";
import { crawl, DEFAULT_CRAWL_LIMITS, type CrawlOptions } from "./crawl/crawl";
import { FakeEmbeddings, type EmbeddingAdapter } from "./models/embeddings";
import { assertEmbeddingSpace, type Repository } from "./retrieve";

export async function ingest(url: string, repo: Repository,
  options: { adapter?: EmbeddingAdapter; crawlOptions?: CrawlOptions } = {},
) {
  const adapter = options.adapter ?? new FakeEmbeddings();
  await assertEmbeddingSpace(repo, adapter);
  const business = (await repo.getBusiness())!;
  if (new URL(url).origin !== new URL(business.sourceUrl).origin) throw new Error("Business source origin mismatch");
  const result = await crawl(url, options.crawlOptions);
  // Partial crawls do not silently replace a previously complete snapshot.
  if (result.status !== "completed" || result.errors.length || !result.pages.length) throw new Error("Crawl incomplete; ingestion not stored");
  const pages = [];
  for (const page of result.pages) {
    const pageId = stableId(page.url);
    const chunks = [];
    for (const chunk of chunkPage(page.url, page.sections)) {
      const embedding = await adapter.embed(`${chunk.heading}\n${chunk.text}`);
      if (embedding.length !== adapter.dimensions || !embedding.every(Number.isFinite)) throw new Error("Invalid embedding dimension/values");
      chunks.push({ ...chunk, pageId, embedding, embeddingModel: adapter.model, embeddingDimensions: adapter.dimensions });
    }
    pages.push({ id: pageId, url: page.url, title: page.title, cleanText: page.cleanText,
      contentHash: contentHash(page.cleanText), chunks });
  }
  await repo.storeIngestion(randomUUID(), pages, { ...DEFAULT_CRAWL_LIMITS, ...options.crawlOptions?.limits });
  return { pages: pages.length, chunks: pages.reduce((sum, page) => sum + page.chunks.length, 0),
    embeddingModel: adapter.model, embeddingDimensions: adapter.dimensions };
}
