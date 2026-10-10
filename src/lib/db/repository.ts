import "server-only";
import type { PGlite } from "@electric-sql/pglite";
import type { Business, SourceChunk } from "../types";
import { EMBEDDING_DIMENSIONS } from "./client";

export interface StoredBusiness extends Business {
  contactUrl: string | null;
  phone: string | null;
  embeddingModel: string;
}
export interface PageInput {
  id: string;
  crawlRunId: string;
  url: string;
  title: string;
  cleanText: string;
  contentHash: string;
}
export interface ChunkInput {
  id: string;
  pageId: string;
  ordinal: number;
  heading: string;
  text: string;
  embedding: readonly number[];
  embeddingModel: string;
  contentHash: string;
}
export interface SearchHit extends SourceChunk { distance: number }

function vectorLiteral(values: readonly number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS || !values.every(Number.isFinite)) {
    throw new Error(`Embedding must contain ${EMBEDDING_DIMENSIONS} finite numbers`);
  }
  return `[${values.join(",")}]`;
}

// The trusted caller selects the business once; no method accepts another scope.
export function businessRepository(db: PGlite, businessId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
    throw new Error("Business ID must be a UUID");
  }
  return {
    async createBusiness(input: Omit<StoredBusiness, "businessId">): Promise<void> {
      await db.query(`INSERT INTO businesses
        (business_id, id, slug, name, source_url, contact_url, phone, embedding_model)
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7)`,
      [businessId, input.slug, input.name, input.sourceUrl, input.contactUrl, input.phone, input.embeddingModel]);
    },
    async getBusiness(): Promise<StoredBusiness | null> {
      const result = await db.query<StoredBusiness>(`SELECT business_id AS "businessId",
        slug, name, source_url AS "sourceUrl", contact_url AS "contactUrl", phone,
        embedding_model AS "embeddingModel" FROM businesses WHERE business_id = $1`, [businessId]);
      return result.rows[0] ?? null;
    },
    async createCrawlRun(id: string, status = "running", limits: Record<string, number> = {}): Promise<void> {
      await db.query(`INSERT INTO crawl_runs (business_id, id, status, limits_json)
        VALUES ($1, $2, $3, $4::jsonb)`, [businessId, id, status, JSON.stringify(limits)]);
    },
    async getCrawlRun(id: string) {
      const result = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM crawl_runs WHERE business_id = $1 AND id = $2", [businessId, id]);
      return result.rows[0] ?? null;
    },
    async createPage(input: PageInput): Promise<void> {
      await db.query(`INSERT INTO pages
        (business_id, id, crawl_run_id, url, title, clean_text, content_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [businessId, input.id, input.crawlRunId, input.url, input.title, input.cleanText, input.contentHash]);
    },
    async getPage(id: string): Promise<PageInput | null> {
      const result = await db.query<PageInput>(`SELECT id, crawl_run_id AS "crawlRunId",
        url, title, clean_text AS "cleanText", content_hash AS "contentHash"
        FROM pages WHERE business_id = $1 AND id = $2`, [businessId, id]);
      return result.rows[0] ?? null;
    },
    async createChunk(input: ChunkInput): Promise<void> {
      const embedding = vectorLiteral(input.embedding);
      // Refuse mixed spaces even when their dimensions happen to match.
      const result = await db.query(`INSERT INTO chunks
        (business_id, id, page_id, ordinal, heading, text, embedding, embedding_model, content_hash)
        SELECT $1, $2, $3, $4, $5, $6, $7::vector, $8, $9
        FROM businesses WHERE business_id = $1 AND embedding_model = $8 RETURNING id`,
      [businessId, input.id, input.pageId, input.ordinal, input.heading, input.text, embedding,
        input.embeddingModel, input.contentHash]);
      if (result.rows.length !== 1) throw new Error("Business missing or embedding model mismatch");
    },
    async getChunk(id: string): Promise<SourceChunk | null> {
      const result = await db.query<SourceChunk>(`SELECT c.business_id AS "businessId", c.id,
        p.url AS "pageUrl", c.heading, c.text FROM chunks c
        JOIN pages p ON p.business_id = c.business_id AND p.id = c.page_id
        WHERE c.business_id = $1 AND c.id = $2`, [businessId, id]);
      return result.rows[0] ?? null;
    },
    async searchChunks(embedding: readonly number[], embeddingModel: string, limit = 5): Promise<SearchHit[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be 1 to 100");
      const queryVector = vectorLiteral(embedding);
      const result = await db.query<SearchHit>(`SELECT c.business_id AS "businessId", c.id,
        p.url AS "pageUrl", c.heading, c.text, (c.embedding <-> $2::vector) AS distance
        FROM chunks c JOIN pages p ON p.business_id = c.business_id AND p.id = c.page_id
        JOIN businesses b ON b.business_id = c.business_id
        WHERE c.business_id = $1 AND c.embedding_model = $3 AND b.embedding_model = $3
        ORDER BY distance, c.id LIMIT $4`, [businessId, queryVector, embeddingModel, limit]);
      return result.rows;
    },
  };
}
