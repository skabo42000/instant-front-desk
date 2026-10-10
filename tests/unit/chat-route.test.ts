import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createChatHandler } from "../../src/lib/chat-handler";
import { ChatRateLimiter } from "../../src/lib/chat-limits";
import { ModelGateway } from "../../src/lib/models/gateway";
import { FakeModel } from "../../src/lib/models/fake";
import { businessRepository } from "../../src/lib/db/repository";
import { retrieve } from "../../src/lib/retrieve";
import { seedChatDatabase } from "../helpers/chat-database";
let db: PGlite;
const cookie = "ifd-client=00000000-0000-0000-0000-000000000099";
function request(slug = "bright-salon", question = "What are your hours?", client = cookie) {
  return new Request("http://localhost/api/chat", { method: "POST", headers: { cookie: client }, body: JSON.stringify({ slug, question }) });
}
describe("offline chat endpoint", () => {
  beforeAll(async () => { db = await seedChatDatabase(); }, 30000);
  afterAll(async () => { await db?.close(); });
  it("returns validated citations without logs, and keeps businesses separate", async () => {
    const chunks = (await retrieve("What are your hours?", businessRepository(db, "00000000-0000-0000-0000-000000000001"))).chunks;
    const hours = chunks.find(chunk => chunk.heading === "Hours")!;
    const handler = createChatHandler(async () => db, new ChatRateLimiter(), () => new ModelGateway({
      primary: { provider: "fake", model: "scripted", family: "fake", adapter: new FakeModel([{ text: hours.text, citedChunkIds: [hours.id] }]) }, retry: false,
    }));
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "answer", text: hours.text,
      citations: [{ id: hours.id, pageUrl: hours.pageUrl, heading: "Hours" }] });
    const other = await handler(request("maple-repair"));
    const body = await other.json();
    expect(body.kind).toBe("refusal");
    expect(JSON.stringify(body)).not.toContain("bright-salon");
    expect(JSON.stringify(body)).not.toContain("10 AM");
  });
  it("defaults to a fake refusal and sets a private browser identity", async () => {
    const response = await createChatHandler(async () => db, new ChatRateLimiter())(request("bright-salon", "What are your prices?", ""));
    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("refusal");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("enforces client limits across businesses and business limits across clients", async () => {
    const clients = createChatHandler(async () => db, new ChatRateLimiter(1, 20));
    expect((await clients(request())).status).toBe(200);
    expect((await clients(request("maple-repair"))).status).toBe(429);
    const businesses = createChatHandler(async () => db, new ChatRateLimiter(20, 1));
    expect((await businesses(request())).status).toBe(200);
    const blocked = await businesses(request("bright-salon", "hours", ""));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await businesses(request("maple-repair", "hours", ""))).status).toBe(200);
  });
  it("returns 404 for an unknown slug and rejects invalid or oversized input", async () => {
    const handler = createChatHandler(async () => db, new ChatRateLimiter());
    expect((await handler(request("missing"))).status).toBe(404);
    for (const question of ["", "x".repeat(2001), "x".repeat(13000)]) expect((await handler(request("bright-salon", question))).status).toBe(400);
    expect((await handler(new Request("http://localhost/api/chat", { method: "POST", body: "{" }))).status).toBe(400);
  });
  it("bounds model output and hides internal errors", async () => {
    const text = "Hours 10 AM " + "x".repeat(4100) + ".";
    const repo = businessRepository(db, "00000000-0000-0000-0000-000000000001");
    const runId = "00000000-0000-0000-0000-000000000011";
    const pageId = "00000000-0000-0000-0000-000000000012";
    const chunkId = "00000000-0000-0000-0000-000000000013";
    const { FakeEmbeddings } = await import("../../src/lib/models/embeddings");
    const embedding = new FakeEmbeddings();
    await repo.createCrawlRun(runId);
    await repo.createPage({ id: pageId, crawlRunId: runId, url: "https://bright-salon.test/long", title: "Hours", cleanText: text, contentHash: "long" });
    await repo.createChunk({ id: chunkId, pageId, ordinal: 0, heading: "Hours", text, embedding: await embedding.embed("hours"), embeddingModel: embedding.model, contentHash: "long" });
    const handler = createChatHandler(async () => db, new ChatRateLimiter(), () => new ModelGateway({ primary: {
      provider: "fake", model: "scripted", family: "fake", adapter: new FakeModel([{ text, citedChunkIds: [chunkId] }]),
    } }));
    const response = await handler(request("bright-salon", "hours"));
    const body = await response.json();
    expect(body.kind).toBe("refusal");
    expect(body.text.length).toBeLessThanOrEqual(4000);
    const failure = await createChatHandler(async () => { throw new Error("synthetic-secret-marker"); }, new ChatRateLimiter())(request());
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("synthetic-secret-marker");
  });
  it("expires limits without keeping questions", () => {
    const limiter = new ChatRateLimiter(1, 1, 100);
    expect(limiter.take("a", "b", 0)).toBe(true);
    expect(limiter.take("a", "b", 99)).toBe(false);
    expect(limiter.take("a", "b", 100)).toBe(true);
  });
});
