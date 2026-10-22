import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { embeddingBatches, GeminiEmbeddings, MAX_EMBEDDING_BATCH_BYTES, type HttpTransport } from "../../src/lib/models/providers";
import { createChatRuntime } from "../../src/lib/chat-runtime";
import { openDatabase } from "../../src/lib/db/client";
import { databaseRpc, PostgresProviderBudget } from "../../src/lib/shared-controls";
import { LocalProviderStop } from "../../src/lib/provider-stop";

const env = { LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes", GEMINI_EVAL_API_KEY: "fixture-gemini", GROQ_EVAL_API_KEY: "fixture-groq" };
const model = "gemini-embedding-001";
const texts = (count: number) => Array.from({ length: count }, (_, i) => `Chunk ${i}`);
const vector = (text: string) => Array(768).fill(Number(text.match(/\d+/)?.[0] ?? 0) / 1000);
function fakeHttp() {
  return vi.fn<HttpTransport>(async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith(":batchEmbedContents")) return Response.json({ embeddings: body.requests.map((entry: { content: { parts: { text: string }[] } }) => ({ values: vector(entry.content.parts[0].text) })) });
    if (url.endsWith(":embedContent")) return Response.json({ embedding: { values: vector(body.content.parts[0].text) } });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "Supported reply.", citedChunkIds: [] }) }] } }] });
  });
}

describe("bounded Gemini embedding batches", () => {
  it.each([[0, []], [1, [1]], [93, [93]], [100, [100]], [101, [100, 1]], [250, [100, 100, 50]]] as const)(
    "splits %i texts in order, and charges one budget reservation per request", async (count, sizes) => {
      const http = fakeHttp(); const budget = { reserve: vi.fn(async () => true), stop: vi.fn(async () => {}) };
      const runtime = createChatRuntime(env, http, budget);
      const vectors = await runtime(model).embeddings.embedMany!(texts(count));
      expect(vectors).toEqual(texts(count).map(vector));
      expect(http.mock.calls.map(([url, init]) => {
        expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`);
        expect(Buffer.byteLength(String(init.body))).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_BYTES);
        const body = JSON.parse(String(init.body));
        for (const entry of body.requests) {
          expect(entry.model).toBe(`models/${model}`); expect(entry.outputDimensionality).toBe(768);
          expect(entry).not.toHaveProperty("taskType"); expect(entry).not.toHaveProperty("title");
        }
        return body.requests.length;
      })).toEqual(sizes);
      expect(budget.reserve).toHaveBeenCalledTimes(sizes.length); expect(budget.stop).not.toHaveBeenCalled();
    });
  it("serializes the same task/model/dimension/content in single queries and batch entries", async () => {
    const http = fakeHttp(); const adapter = new GeminiEmbeddings("fixture-gemini", http);
    const single = await adapter.embed("Chunk 7"); const batch = await adapter.embedMany(["Chunk 7"]);
    expect(batch[0]).toEqual(single);
    const singleBody = JSON.parse(String(http.mock.calls[0][1].body));
    const batchBody = JSON.parse(String(http.mock.calls[1][1].body));
    expect(batchBody.requests[0]).toEqual(singleBody);
    expect(singleBody).not.toHaveProperty("taskType");
  });
  it("splits on serialized UTF-8 bytes and rejects an oversized individual text before HTTP", async () => {
    const http = fakeHttp(); const adapter = new GeminiEmbeddings("fixture-gemini", http);
    const input = "\u{1f680}".repeat(100_000);
    expect(embeddingBatches([input, input, input]).map(batch => batch.length)).toEqual([2, 1]);
    await adapter.embedMany([input, input, input]);
    for (const [, init] of http.mock.calls) expect(Buffer.byteLength(String(init.body))).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_BYTES);
    http.mockClear();
    await expect(adapter.embedMany(["x".repeat(MAX_EMBEDDING_BATCH_BYTES)])).rejects.toMatchObject({ code: "MALFORMED" });
    expect(http).not.toHaveBeenCalled();
  });
  it.each([
    { embeddings: [] }, { embeddings: [{ values: [1, 2] }] }, { embeddings: [{ values: Array(768).fill(null) }] },
  ])("rejects malformed/count-mismatched batch output without silently losing chunks", async reply => {
    await expect(new GeminiEmbeddings("fixture-gemini", async () => Response.json(reply)).embedMany(["one"])).rejects.toThrow();
  });
  it("refuses a load exceeding the remaining cap before any batch/budget call, and other-business chat still works", async () => {
    const http = fakeHttp(); const budget = { reserve: vi.fn(async () => true), stop: vi.fn(async () => {}) };
    const runtime = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "3" }, http, budget);
    await runtime(model).embeddings.embed("earlier chat"); // Two calls remain.
    await expect(runtime(model).embeddings.embedMany!(texts(250))).rejects.toMatchObject({ code: "LOCAL_CALL_LIMIT" });
    expect(http).toHaveBeenCalledTimes(1); expect(budget.reserve).toHaveBeenCalledTimes(1); expect(budget.stop).not.toHaveBeenCalled();
    await expect(runtime(model).embeddings.embed("another business question")).resolves.toHaveLength(768);
    await expect(runtime(model).gateway.generate({ businessId: "other-business", question: "Another business?", sources: [] })).resolves.toMatchObject({ ok: true });
    expect(http).toHaveBeenCalledTimes(3);
    expect(() => runtime(model)).not.toThrow();
    await expect(runtime(model).embeddings.embedMany!(texts(1))).rejects.toMatchObject({ code: "LOCAL_CALL_LIMIT" });
    expect(budget.stop).not.toHaveBeenCalled();
  });
  it("holds the entire load's slots against simultaneous chat and releases holds on failure", async () => {
    const normal = fakeHttp(); let finish!: (response: Response) => void;
    const http = vi.fn<HttpTransport>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(normal);
    const runtime = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "3" }, http);
    const pending = runtime(model).embeddings.embedMany!(texts(250));
    await expect(runtime(model).embeddings.embed("simultaneous chat")).rejects.toMatchObject({ code: "LOCAL_CALL_LIMIT" });
    expect(http).toHaveBeenCalledTimes(1);
    finish(Response.json({}, { status: 500 }));
    await expect(pending).rejects.toMatchObject({ code: "HTTP_ERROR" });
    // One attempted batch counted, its unused two held slots were returned.
    await expect(runtime(model).embeddings.embed("next chat")).resolves.toHaveLength(768);
    await expect(runtime(model).embeddings.embed("next answer slot")).resolves.toHaveLength(768);
    expect(() => runtime(model)).not.toThrow();
  });
  it("includes pending database reservations in the preflight and does not hold slots after DB failure", async () => {
    const http = fakeHttp(); let fail!: (error: Error) => void;
    const budget = { reserve: vi.fn<() => Promise<boolean>>().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue(true), stop: vi.fn(async () => {}) };
    const runtime = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "1" }, http, budget);
    const pending = runtime(model).embeddings.embed("pending chat");
    await expect(runtime(model).embeddings.embedMany!(texts(1))).rejects.toMatchObject({ code: "LOCAL_CALL_LIMIT" });
    fail(Error("database unavailable")); await expect(pending).rejects.toMatchObject({ code: "HTTP_ERROR" });
    await expect(runtime(model).embeddings.embedMany!(texts(93))).resolves.toHaveLength(93);
    expect(http).toHaveBeenCalledTimes(1); expect(budget.stop).not.toHaveBeenCalled();
  });
  it.each([429, 403])("real provider quota %i still stops batches and chat, and persists the shared stop", async status => {
    const http = vi.fn<HttpTransport>(async () => Response.json({ error: "quota exceeded" }, { status }));
    const budget = { reserve: vi.fn(async () => true), stop: vi.fn(async () => {}) };
    const runtime = createChatRuntime(env, http, budget);
    await expect(runtime(model).embeddings.embedMany!(texts(250))).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
    expect(http).toHaveBeenCalledTimes(1); expect(budget.reserve).toHaveBeenCalledTimes(1); expect(budget.stop).toHaveBeenCalledTimes(1);
    expect(() => runtime(model)).toThrow("FREE_TIER_EXHAUSTED");
  });
});

describe("batch calls through the actual PostgresProviderBudget (offline PGlite)", () => {
  let db: PGlite;
  const directory = mkdtempSync(join(tmpdir(), "ifd-batch-stop-"));
  beforeAll(async () => { db = await openDatabase(); }, 30000);
  afterAll(async () => { await db?.close(); rmSync(directory, { recursive: true, force: true }); });
  it("records three shared calls for 250 chunks, and cap refusal never writes the sticky stop", async () => {
    const stop = new LocalProviderStop(directory);
    const runtime = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "4" }, fakeHttp(), new PostgresProviderBudget(databaseRpc(db), stop));
    await runtime(model).embeddings.embedMany!(texts(250));
    expect((await db.query("SELECT used,stopped FROM pilot_budget")).rows).toEqual([{ used: 3, stopped: false }]);
    await expect(runtime(model).embeddings.embedMany!(texts(101))).rejects.toMatchObject({ code: "LOCAL_CALL_LIMIT" });
    expect(stop.exists()).toBe(false);
    await runtime(model).embeddings.embed("saved business query");
    expect((await db.query("SELECT used,stopped FROM pilot_budget")).rows).toEqual([{ used: 4, stopped: false }]);
    expect(stop.exists()).toBe(false);
  });
  it("still persists real batch quota exhaustion to Postgres and the sticky marker", async () => {
    await db.query("DELETE FROM pilot_budget");
    const stop = new LocalProviderStop(directory);
    const http = vi.fn<HttpTransport>(async () => Response.json({}, { status: 429 }));
    const runtime = createChatRuntime(env, http, new PostgresProviderBudget(databaseRpc(db), stop));
    await expect(runtime(model).embeddings.embedMany!(texts(101))).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
    expect((await db.query("SELECT used,stopped FROM pilot_budget")).rows).toEqual([{ used: 1, stopped: true }]);
    expect(stop.exists()).toBe(true); expect(http).toHaveBeenCalledTimes(1);
    expect(await new PostgresProviderBudget(databaseRpc(db), stop).reserve(60)).toBe(false);
  });
});
