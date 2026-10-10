import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { EMBEDDING_DIMENSIONS, migrateDatabase, openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { FAKE_EMBEDDING_MODEL, fakeEmbedding } from "../helpers/fake-embeddings";

const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
const missing = "00000000-0000-0000-0000-000000000003";
const id = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let db: PGlite;

describe("business-scoped PGlite repository", () => {
  beforeAll(async () => {
    db = await openDatabase();
    for (const [businessId, offset] of [[A, 0], [B, 100]] as const) {
      const repo = businessRepository(db, businessId);
      await repo.createBusiness({ slug: `fixture-${offset}`, name: `Fixture ${offset}`,
        sourceUrl: "https://fixture.invalid", contactUrl: null, phone: null,
        embeddingModel: FAKE_EMBEDDING_MODEL });
      await repo.createCrawlRun(id(offset + 1));
      await repo.createPage({ id: id(offset + 2), crawlRunId: id(offset + 1),
        url: `https://fixture.invalid/${offset}`, title: "Fixture", cleanText: "Test data", contentHash: "hash" });
      await repo.createChunk({ id: id(offset + 3), pageId: id(offset + 2), ordinal: 0,
        heading: "Hours", text: `Business ${offset}`, embedding: fakeEmbedding(`business ${offset}`),
        embeddingModel: FAKE_EMBEDDING_MODEL, contentHash: "hash" });
      await db.query(`INSERT INTO question_lists (business_id,version,approved_at) VALUES ($1,1,now())`, [businessId]);
      await db.query(`INSERT INTO eval_questions
        (business_id, id, version, kind, question, expected_behavior) VALUES ($1,$2,1,'source','Hours?','Cite')`,
      [businessId, id(offset + 4)]);
      await db.query(`UPDATE eval_questions SET approved_at=now() WHERE business_id=$1`, [businessId]);
      await db.query(`INSERT INTO eval_runs
        (business_id,id,question_version,crawl_run_id,answer_model,judge_model,prompt_version,status)
        VALUES ($1,$2,1,$3,'fake-answer','fake-judge','v1','running')`, [businessId, id(offset + 5), id(offset + 1)]);
      await db.query(`INSERT INTO eval_results (business_id,id,eval_run_id,question_id,answer)
        VALUES ($1,$2,$3,$4,'Fixture answer')`, [businessId, id(offset + 6), id(offset + 5), id(offset + 4)]);
    }
  }, 30_000);
  afterAll(async () => { if (db) await db.close(); });

  it("migrates a fresh database and reruns without losing existing rows", async () => {
    await migrateDatabase(db);
    expect((await businessRepository(db, A).getBusiness())?.name).toBe("Fixture 0");
    expect(await businessRepository(db, B).getChunk(id(103))).not.toBeNull();
    const tables = await db.query<{ table_name: string; is_nullable: string }>(`SELECT table_name, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id'`);
    expect(tables.rows).toHaveLength(11);
    expect(tables.rows.every(row => row.is_nullable === "NO")).toBe(true);
    const indexes = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_indexes
      WHERE schemaname = 'public' AND (indexdef ILIKE '%hnsw%' OR indexdef ILIKE '%ivfflat%')`);
    expect(indexes.rows[0].count).toBe(0);
  });

  it("cannot retrieve another business's rows by ID", async () => {
    const a = businessRepository(db, A);
    const b = businessRepository(db, B);
    expect((await a.getBusiness())?.businessId).toBe(A);
    expect(await a.getCrawlRun(id(101))).toBeNull();
    expect(await a.getPage(id(102))).toBeNull();
    expect(await a.getChunk(id(103))).toBeNull();
    expect(await b.getCrawlRun(id(1))).toBeNull();
    expect(await b.getPage(id(2))).toBeNull();
    expect(await b.getChunk(id(3))).toBeNull();
    expect(await businessRepository(db, missing).getBusiness()).toBeNull();
  });

  it("rejects cross-business pages and chunks at the database boundary", async () => {
    const a = businessRepository(db, A);
    await expect(a.createPage({ id: id(10), crawlRunId: id(101), url: "https://fixture.invalid",
      title: "Wrong owner", cleanText: "", contentHash: "hash" })).rejects.toMatchObject({ code: "23503" });
    await expect(a.createChunk({ id: id(11), pageId: id(102), ordinal: 1, heading: "",
      text: "Wrong owner", embedding: fakeEmbedding("test"), embeddingModel: FAKE_EMBEDDING_MODEL,
      contentHash: "hash" })).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects every cross-business evaluation and citation foreign key", async () => {
    const cases: [string, unknown[]][] = [
      [`INSERT INTO eval_runs (business_id,id,question_version,crawl_run_id,answer_model,judge_model,prompt_version,status)
        VALUES ($1,$2,1,$3,'fake','judge','v1','running')`, [A,id(20),id(101)]],
      [`INSERT INTO eval_results (business_id,id,eval_run_id,question_id,answer) VALUES ($1,$2,$3,$4,'test')`,
        [A,id(21),id(105),id(4)]],
      [`INSERT INTO eval_results (business_id,id,eval_run_id,question_id,answer) VALUES ($1,$2,$3,$4,'test')`,
        [A,id(22),id(5),id(104)]],
      [`INSERT INTO question_evidence (business_id,id,question_id,chunk_id) VALUES ($1,$2,$3,$4)`,
        [A,id(23),id(104),id(3)]],
      [`INSERT INTO question_evidence (business_id,id,question_id,chunk_id) VALUES ($1,$2,$3,$4)`,
        [A,id(24),id(4),id(103)]],
      [`INSERT INTO result_citations (business_id,id,result_id,chunk_id) VALUES ($1,$2,$3,$4)`,
        [A,id(25),id(106),id(3)]],
      [`INSERT INTO result_citations (business_id,id,result_id,chunk_id) VALUES ($1,$2,$3,$4)`,
        [A,id(26),id(6),id(103)]],
      [`INSERT INTO model_requests (business_id,id,eval_run_id,purpose,provider,model,attempt,status,latency_ms)
        VALUES ($1,$2,$3,'eval','fake','fake',1,'ok',0)`, [A,id(27),id(105)]],
    ];
    for (const [sql, params] of cases) {
      await expect(db.query(sql, params)).rejects.toMatchObject({ code: "23503" });
    }
    await db.query(`INSERT INTO question_evidence (business_id,id,question_id,chunk_id)
      VALUES ($1,$2,$3,$4)`, [A,id(28),id(4),id(3)]);
    await db.query(`INSERT INTO result_citations (business_id,id,result_id,chunk_id)
      VALUES ($1,$2,$3,$4)`, [A,id(29),id(6),id(3)]);
    await db.query(`INSERT INTO model_requests (business_id,id,eval_run_id,purpose,provider,model,attempt,status,latency_ms)
      VALUES ($1,$2,NULL,'answer','fake','fake',1,'ok',0)`, [A,id(30)]);
  });

  it("isolates exact vector search even when the other business is the closest match", async () => {
    const a = businessRepository(db, A);
    const b = businessRepository(db, B);
    const bVector = fakeEmbedding("business 100");
    const hits = await a.searchChunks(bVector, FAKE_EMBEDDING_MODEL);
    expect(hits.map(hit => hit.id)).toEqual([id(3)]);
    expect(hits.every(hit => hit.businessId === A)).toBe(true);
    const expectedDistance = Math.sqrt(fakeEmbedding("business 0").reduce(
      (sum, value, i) => sum + (value - bVector[i]) ** 2, 0));
    expect(hits[0].distance).toBeCloseTo(expectedDistance, 4);
    expect((await b.searchChunks(bVector, FAKE_EMBEDDING_MODEL))[0].distance).toBe(0);
    expect(await businessRepository(db, missing).searchChunks(bVector, FAKE_EMBEDDING_MODEL)).toEqual([]);
    expect(await a.searchChunks(bVector, "different-space")).toEqual([]);
  });

  it("scopes joins even when both businesses use the same local IDs", async () => {
    for (const businessId of [A, B]) {
      const repo = businessRepository(db, businessId);
      await repo.createPage({ id: id(40), crawlRunId: id(businessId === A ? 1 : 101),
        url: `https://fixture.invalid/${businessId}`, title: "Same ID", cleanText: "text", contentHash: "hash" });
      await repo.createChunk({ id: id(41), pageId: id(40), ordinal: 0, heading: "Shared ID",
        text: businessId, embedding: fakeEmbedding("same"), embeddingModel: FAKE_EMBEDDING_MODEL, contentHash: "hash" });
    }
    for (const businessId of [A, B]) {
      const repo = businessRepository(db, businessId);
      expect((await repo.getChunk(id(41)))?.pageUrl).toBe(`https://fixture.invalid/${businessId}`);
      const hits = await repo.searchChunks(fakeEmbedding("same"), FAKE_EMBEDDING_MODEL, 1);
      expect(hits).toHaveLength(1);
      expect(hits[0].businessId).toBe(businessId);
      expect(hits[0].pageUrl).toBe(`https://fixture.invalid/${businessId}`);
    }
  });

  it("rejects wrong dimensions in writes, search and direct SQL", async () => {
    const a = businessRepository(db, A);
    for (const size of [0, EMBEDDING_DIMENSIONS - 1, EMBEDDING_DIMENSIONS + 1]) {
      const embedding = Array<number>(size).fill(0);
      await expect(a.createChunk({ id: id(50), pageId: id(2), ordinal: 1, heading: "",
        text: "Wrong dimension", embedding, embeddingModel: FAKE_EMBEDDING_MODEL,
        contentHash: "hash" })).rejects.toThrow("finite numbers");
      await expect(a.searchChunks(embedding, FAKE_EMBEDDING_MODEL)).rejects.toThrow("finite numbers");
    }
    await expect(db.query(`INSERT INTO chunks
      (business_id,id,page_id,ordinal,heading,text,embedding,embedding_model,content_hash)
      VALUES ($1,$2,$3,1,'','bad','[1,2,3]'::vector,$4,'hash')`,
    [A,id(51),id(2),FAKE_EMBEDDING_MODEL])).rejects.toThrow("expected 768 dimensions, not 3");
  });

  it("rejects invalid vector values, limits and mixed embedding models", async () => {
    const a = businessRepository(db, A);
    for (const value of [NaN, Infinity, -Infinity]) {
      const embedding = fakeEmbedding("test");
      embedding[0] = value;
      await expect(a.searchChunks(embedding, FAKE_EMBEDDING_MODEL)).rejects.toThrow("finite numbers");
    }
    for (const limit of [0, 101, 1.5]) {
      await expect(a.searchChunks(fakeEmbedding("test"), FAKE_EMBEDDING_MODEL, limit)).rejects.toThrow("Limit");
    }
    await expect(a.createChunk({ id: id(52), pageId: id(2), ordinal: 1, heading: "", text: "test",
      embedding: fakeEmbedding("test"), embeddingModel: "other-model", contentHash: "hash" }))
      .rejects.toThrow("embedding model mismatch");
    expect(fakeEmbedding("repeat")).toEqual(fakeEmbedding("repeat"));
    expect(fakeEmbedding("repeat")).not.toEqual(fakeEmbedding("different"));
  });

  it("denies table access to an untrusted database role", async () => {
    await db.exec("CREATE ROLE ifd_untrusted; SET ROLE ifd_untrusted;");
    try {
      await expect(db.query("SELECT * FROM chunks WHERE business_id = $1", [A]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
