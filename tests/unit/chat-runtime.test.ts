import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createChatRuntime } from "../../src/lib/chat-runtime";
import { createChatHandler } from "../../src/lib/chat-handler";
import { ChatRateLimiter } from "../../src/lib/chat-limits";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import type { HttpTransport } from "../../src/lib/models/providers";

const env = { LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes", GEMINI_EVAL_API_KEY: "synthetic-gemini-eval-key",
  GROQ_EVAL_API_KEY: "synthetic-groq-eval-key" };
const model = "gemini-embedding-001";
const businessId = "00000000-0000-0000-0000-000000000021";
const chunkId = "00000000-0000-0000-0000-000000000024";
const vector = Array(768).fill(0.1);
const request = () => new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ slug: "real-fixture", question: "What are your hours?" }) });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function transport(): HttpTransport {
  return vi.fn(async (url, init) => {
    if (url.includes(":embedContent")) {
      expect(JSON.parse(String(init.body)).outputDimensionality).toBe(768);
      return json({ embedding: { values: vector } });
    }
    const reply = { text: "We open at 10 AM.", citedChunkIds: [chunkId] };
    return url.includes("groq") ? json({ choices: [{ message: { content: JSON.stringify(reply) } }] })
      : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] });
  });
}
let db: PGlite;
beforeAll(async () => {
  db = await openDatabase();
  const repo = businessRepository(db, businessId);
  await repo.createBusiness({ slug: "real-fixture", name: "Fictional salon", sourceUrl: "https://salon.example/", phone: null, contactUrl: null, embeddingModel: model });
  await repo.createCrawlRun("00000000-0000-0000-0000-000000000022", "completed");
  await repo.createPage({ id: "00000000-0000-0000-0000-000000000023", crawlRunId: "00000000-0000-0000-0000-000000000022",
    url: "https://salon.example/", title: "Hours", cleanText: "We open at 10 AM.", contentHash: "fixture" });
  await repo.createChunk({ id: chunkId, pageId: "00000000-0000-0000-0000-000000000023", ordinal: 0, heading: "Hours",
    text: "We open at 10 AM.", embedding: vector, embeddingModel: model, contentHash: "fixture" });
}, 60000);
afterAll(async () => { await db?.close(); });

describe("local real chat, with fake HTTP only", () => {
  it("retries failed stops on refused requests at most every 30 seconds without waiting", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const stop = vi.fn<() => Promise<void>>().mockRejectedValueOnce(Error("offline"));
      const budget = { reserve: vi.fn().mockResolvedValue(true), stop };
      const http = vi.fn(async () => json({}, 429));
      const runtime = createChatRuntime(env, http, budget);
      const services = runtime(model);
      await expect(services.embeddings.embed("hours")).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
      expect(stop).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(129_999);
      expect(() => runtime(model)).toThrow("FREE_TIER_EXHAUSTED");
      expect(stop).toHaveBeenCalledTimes(1);
      let finish!: () => void;
      stop.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      clock.mockReturnValue(130_000);
      expect(() => runtime(model)).toThrow("FREE_TIER_EXHAUSTED");
      await Promise.resolve();
      expect(stop).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(200_000);
      expect(() => runtime(model)).toThrow("FREE_TIER_EXHAUSTED");
      await expect(services.embeddings.embed("hours")).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
      expect(stop).toHaveBeenCalledTimes(2); // No overlapping writes, even after the interval.
      finish();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(http).toHaveBeenCalledTimes(1);
      expect(budget.reserve).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it("does not burn the process cap on failed reservations, including concurrent outages", async () => {
    const http = transport();
    const reserve = vi.fn().mockRejectedValue(Error("offline"));
    const services = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "1" }, http,
      { reserve, stop: vi.fn().mockResolvedValue(undefined) })(model);
    const results = await Promise.allSettled([services.embeddings.embed("hours"), services.embeddings.embed("hours")]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    await expect(services.embeddings.embed("hours")).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
    reserve.mockResolvedValue(true);
    await expect(services.embeddings.embed("hours")).resolves.toHaveLength(768);
    await expect(services.embeddings.embed("hours")).rejects.toMatchObject({ code: "LOCAL_CALL_LIMIT" });
    expect(http).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(3);
  });
  it("never calls the provider when a shared reservation is refused", async () => {
    const http = transport();
    const runtime = createChatRuntime(env, http, { reserve: vi.fn().mockResolvedValue(false), stop: vi.fn().mockResolvedValue(undefined) });
    await expect(runtime(model).embeddings.embed("hours")).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
    await expect(runtime(model).embeddings.embed("hours")).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
    expect(() => runtime(model)).not.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
  it("defaults to offline mode and never uses real keys for fake businesses", () => {
    const http = transport();
    expect(() => createChatRuntime({}, http)(model)).toThrow("LOCAL_CHAT_MODE");
    expect(() => createChatRuntime({ ...env, FREE_TIER_CONFIRMED: "" }, http)(model)).toThrow("FREE_TIER_CONFIRMED");
    const restricted = new Proxy(env, { get(target, key) {
      if (String(key).endsWith("API_KEY")) throw new Error("Unexpected credential access");
      return target[key as keyof typeof target];
    } });
    expect(createChatRuntime(restricted, http)(new FakeEmbeddings().model).mode).toBe("fake");
    expect(() => createChatRuntime(env, http)("other-model")).toThrow("Unsupported");
    expect(http).not.toHaveBeenCalled();
  });
  it("returns cited real-mode answers through the route with matching vectors and no credentials/logs", async () => {
    const http = transport();
    const response = await createChatHandler(async () => db, new ChatRateLimiter(), undefined, createChatRuntime(env, http))(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "answer", text: "We open at 10 AM.", citations: [{ id: chunkId, pageUrl: "https://salon.example/", heading: "Hours" }] });
    expect(http).toHaveBeenCalledTimes(2);
    expect(vi.mocked(http).mock.calls[0][1].headers).toMatchObject({ "x-goog-api-key": env.GEMINI_EVAL_API_KEY });
  });
  it("counts every retry and cross-provider fallback against one process cap", async () => {
    const http = vi.fn(async (url, init) => url.includes(":generateContent") ? json({}, 503) : transport()(url, init));
    const handler = createChatHandler(async () => db, new ChatRateLimiter(), undefined, createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "4" }, http));
    expect((await handler(request())).status).toBe(200);
    expect(http).toHaveBeenCalledTimes(4);
    expect(http.mock.calls.at(-1)![0]).toContain("groq");
    expect((await handler(request())).status).toBe(503);
    expect(http).toHaveBeenCalledTimes(4);
  });
  it.each([429, 403])("quota status %s stops all subsequent calls and never falls back", async status => {
    const normal = transport();
    const http = vi.fn(async (url, init) => url.includes(":embedContent") ? normal(url, init) : json({ error: "quota exceeded" }, status));
    const handler = createChatHandler(async () => db, new ChatRateLimiter(), undefined, createChatRuntime(env, http));
    for (let i = 0; i < 2; i++) expect((await handler(request())).status).toBe(503);
    expect(http).toHaveBeenCalledTimes(2);
    expect(http.mock.calls.every(([url]) => !url.includes("groq"))).toBe(true);
  });
  it("reserves a cap synchronously across concurrent embedding requests", async () => {
    const http = transport();
    const runtime = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "1" }, http);
    const services = runtime(model);
    const results = await Promise.allSettled([services.embeddings.embed("hours"), services.embeddings.embed("hours")]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("hides configuration failures and rejects echoed evaluation credentials", async () => {
    const disabled = createChatHandler(async () => db, new ChatRateLimiter());
    expect((await disabled(request())).status).toBe(503);
    const http = vi.fn(async () => json({ note: env.GROQ_EVAL_API_KEY }));
    const handler = createChatHandler(async () => db, new ChatRateLimiter(), undefined, createChatRuntime(env, http));
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/synthetic|API_KEY|logs|embedding/);
  });
});
