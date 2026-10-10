import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { chunkPage, contentHash, MAX_CHUNK_LENGTH, CHUNK_OVERLAP } from "../../src/lib/chunk";
import { extractHtml } from "../../src/lib/crawl/extract";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { ingest } from "../../src/lib/ingest";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { fixtureCrawl } from "../helpers/fixture-crawl";

vi.mock("node:http", () => ({ request: () => { throw new Error("Network forbidden"); } }));
vi.mock("node:https", () => ({ request: () => { throw new Error("Network forbidden"); } }));
vi.mock("node:dns/promises", () => ({ lookup: () => { throw new Error("DNS forbidden"); } }));
const A = "00000000-0000-0000-0000-000000000001";
let db: PGlite;
describe("offline ingestion", () => {
  beforeAll(async () => {
    db = await openDatabase();
    await businessRepository(db, A).createBusiness({ slug: "bright", name: "Bright", sourceUrl: "https://bright.test",
      phone: null, contactUrl: null, embeddingModel: new FakeEmbeddings().model });
  }, 30000);
  afterAll(async () => { await db?.close(); });
  it("keeps fixture headings, stable IDs and hashes", () => {
    const sections = extractHtml(readFileSync("tests/fixtures/bright-salon/index.html", "utf8")).sections;
    const chunks = chunkPage("https://bright.test/", sections);
    expect(chunks).toEqual(chunkPage("https://bright.test/", sections));
    expect(chunks.map(chunk => chunk.heading)).toEqual(["Hours", "Contact"]);
    expect(chunks[0].text).toBe("Tuesday to Saturday, 10 AM to 6 PM.");
    expect(chunks[0].contentHash).toBe(contentHash(JSON.stringify([chunks[0].heading, chunks[0].text])));
    expect(chunkPage("https://other.test/", sections)[0].id).not.toBe(chunks[0].id);
    expect(chunkPage("https://bright.test/", [{ ...sections[1], text: "Changed." }])[0].id).not.toBe(chunks[0].id);
  });
  it("caps long sections with small overlap and never crosses headings", () => {
    const text = "x".repeat(2100);
    const chunks = chunkPage("https://bright.test/", [{ heading: "Long", level: 2, text }, { heading: "Next", level: 2, text: "End." }]);
    expect(chunks.map(chunk => chunk.text.length)).toEqual([800, 800, 660, 4]);
    expect(chunks.every(chunk => chunk.text.length <= MAX_CHUNK_LENGTH)).toBe(true);
    expect(chunks[0].text.slice(-CHUNK_OVERLAP)).toBe(chunks[1].text.slice(0, CHUNK_OVERLAP));
    expect(chunks[3].heading).toBe("Next");
    expect(chunkPage("https://bright.test/", [])).toEqual([]);
  });
  it("repeated crawls store no duplicate pages/chunks or changed citation IDs", async () => {
    const repo = businessRepository(db, A);
    const options = { crawlOptions: fixtureCrawl("bright-salon") };
    const first = await ingest("https://bright.test/", repo, options);
    const before = (await db.query("SELECT id,content_hash,embedding_model,embedding_dimensions FROM chunks ORDER BY id")).rows;
    expect(first).toMatchObject({ pages: 2, chunks: 3, embeddingDimensions: 768 });
    expect(await ingest("https://bright.test/", repo, options)).toEqual(first);
    expect((await db.query("SELECT id,content_hash,embedding_model,embedding_dimensions FROM chunks ORDER BY id")).rows).toEqual(before);
    expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM pages")).rows[0].count).toBe(2);
  });
  it("rejects wrong model/dimension before crawling and rolls back invalid snapshots", async () => {
    const repo = businessRepository(db, A);
    const adapter = new FakeEmbeddings();
    for (const wrong of [{ ...adapter, model: "other", dimensions: 768 }, { ...adapter, model: adapter.model, dimensions: 3 }]) {
      await expect(ingest("https://bright.test/", repo, { adapter: { ...wrong, embed: text => adapter.embed(text) } })).rejects.toThrow("mismatch");
    }
    await expect(repo.storeIngestion("10000000-0000-0000-0000-000000000001", [{ id: A, url: "https://bright.test/",
      title: "bad", cleanText: "bad", contentHash: "bad", chunks: [{ id: A, pageId: A, ordinal: 0, heading: "bad", text: "bad",
        contentHash: "bad", embedding: await adapter.embed("bad"), embeddingModel: "other" }] }], {})).rejects.toThrow("mismatch");
    expect(await repo.getCrawlRun("10000000-0000-0000-0000-000000000001")).toBeNull();
    await expect(ingest("https://other.test/", repo)).rejects.toThrow("origin mismatch");
    await expect(ingest("https://bright.test/", repo, { crawlOptions: { ...fixtureCrawl("bright-salon"), limits: { maxPages: 1 } } })).rejects.toThrow("incomplete");
  });
  it("refreshes changed pages and removes disappeared pages without stale search content", async () => {
    const repo = businessRepository(db, A);
    const crawlOptions = fixtureCrawl("bright-salon");
    crawlOptions.transport = async request => ({ status: 200,
      headers: { "content-type": request.url.pathname === "/robots.txt" ? "text/plain" : "text/html" },
      body: (async function* () { yield Buffer.from(request.url.pathname === "/robots.txt"
        ? "User-agent: *\nAllow: /" : "<h2>Hours</h2><p>Monday, 9 AM to 5 PM.</p>"); })(), destroy() {} });
    await ingest("https://bright.test/", repo, { crawlOptions });
    expect(await repo.listPageTexts()).toEqual([{ pageUrl: "https://bright.test/", text: "## Hours\nMonday, 9 AM to 5 PM." }]);
    const chunks = (await db.query<{ text: string; embedding_dimensions: number }>("SELECT text,embedding_dimensions FROM chunks")).rows;
    expect(chunks).toEqual([{ text: "Monday, 9 AM to 5 PM.", embedding_dimensions: 768 }]);
    await expect(db.query("UPDATE chunks SET embedding_dimensions=3")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE businesses SET embedding_dimensions=3")).rejects.toMatchObject({ code: "23514" });
  });
});
