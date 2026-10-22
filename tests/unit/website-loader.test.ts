import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { createWebsiteLoader, createWebsiteLoadHandler, websiteRoot, type WebsiteLoadResult } from "../../src/lib/website-loader";
import { localIngestAllowed } from "../../src/lib/local-ingest-policy";
import { createChatRuntime } from "../../src/lib/chat-runtime";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { stableId } from "../../src/lib/chunk";
import { retrieve } from "../../src/lib/retrieve";
import { localBusinessData } from "../../src/lib/business-data";
import { createChatHandler } from "../../src/lib/chat-handler";
import { ChatRateLimiter } from "../../src/lib/chat-limits";
import { IngestionError } from "../../src/lib/ingest";
import { ProviderError } from "../../src/lib/models/providers";
import { fixtureCrawl } from "../helpers/fixture-crawl";
import { proxy } from "../../src/proxy";
import { POST } from "../../src/app/api/ingest/route";
import { websiteLoadSummary } from "../../src/lib/website-load-summary";

vi.mock("node:http", () => ({ request: () => { throw Error("Network forbidden"); } }));
vi.mock("node:https", () => ({ request: () => { throw Error("Network forbidden"); } }));
vi.mock("node:dns/promises", () => ({ lookup: () => { throw Error("DNS forbidden"); } }));

const env = { LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes", GEMINI_EVAL_API_KEY: "fixture-gemini", GROQ_EVAL_API_KEY: "fixture-groq" };
const model = "gemini-embedding-001";
const loadResult = (slug = "loaded"): WebsiteLoadResult => ({ slug, pages: 1, skipped: 0, truncated: false });
const request = (url: unknown = "https://bright.test/services.html?x=1#heading", host = "localhost:3000", extra: Record<string, string> = {}) =>
  new Request(`http://${host}/api/ingest`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", ...extra }, body: JSON.stringify({ url }) });
let db: PGlite;
beforeAll(async () => { db = await openDatabase(); }, 30000);
afterAll(async () => { await db?.close(); });

describe("local website loading", () => {
  it("normalizes narrow entry points to the exact site root", () => {
    expect(websiteRoot(" https://Bright.test/services.html?q=1#part ").href).toBe("https://bright.test/");
  });
  it.each(["ftp://bright.test", "file:///etc/passwd", "javascript:alert(1)", "not a URL", "https://user:password@bright.test", "https://bright.test:444/",
    "http://localhost", "http://a.localhost", "http://127.0.0.1", "http://2130706433", "http://10.1.2.3", "http://192.168.1.1", "http://172.16.0.1", "http://169.254.169.254",
    "http://[::1]", "http://[fc00::1]", "http://[fe80::1]", "http://[::ffff:127.0.0.1]", ""])("rejects unsafe input %s", async url => {
    const load = vi.fn();
    const response = await createWebsiteLoadHandler(load, env, { loading: false })(request(url));
    expect(response.status).toBe(400); expect(load).not.toHaveBeenCalled();
  });
  it.each([
    { IFD_PILOT_MODE: "yes" }, { PILOT_ACCESS_TOKEN: "synthetic-invitation" },
    { LOCAL_CHAT_MODE: "fake" }, { FREE_TIER_CONFIRMED: "no" }, { IFD_DATA_STORE: "postgres" }, { IFD_DATA_STORE: "supabase" },
  ])("returns 404 before any work for excluded configuration %j", async settings => {
    const load = vi.fn();
    const response = await createWebsiteLoadHandler(load, { ...env, ...settings }, { loading: false })(request());
    expect(response.status).toBe(404); expect(load).not.toHaveBeenCalled();
  });
  it.each(["public.example", "192.168.1.20", "127.0.0.1.evil.example"])("returns 404 for non-loopback host %s", async host => {
    const load = vi.fn();
    expect((await createWebsiteLoadHandler(load, env)(request(undefined, host))).status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });
  it("accepts Next's direct loopback headers and rejects remote forwarding or mismatched URL hosts", async () => {
    const load = vi.fn(async () => loadResult());
    const handler = createWebsiteLoadHandler(load, env, { loading: false });
    expect((await handler(request(undefined, "localhost:3000", { "x-forwarded-host": "localhost:3000", "x-forwarded-for": "::ffff:127.0.0.1" }))).status).toBe(200);
    for (const headers of [{ "x-forwarded-for": "192.168.1.20" }, { "x-forwarded-for": "127.0.0.1, 8.8.8.8" },
      { "x-forwarded-host": "public.example" }, { forwarded: "for=8.8.8.8" }] as Record<string, string>[]) {
      expect((await handler(request(undefined, "localhost:3000", headers))).status).toBe(404);
    }
    const mismatch = new Request("http://public.example/api/ingest", { method: "POST", headers: { host: "localhost:3000" } });
    expect((await handler(mismatch)).status).toBe(404);
    const alias = request();
    expect((await handler(new Request("http://127.0.0.1:3000/api/ingest", {
      method: "POST", headers: alias.headers, body: JSON.stringify({ url: "https://bright.test" }),
    }))).status).toBe(200);
    for (const host of ["127.0.0.1:3000", "[::1]:3000"]) expect(localIngestAllowed(new Headers({ host }), env)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("rejects cross-origin and missing-Origin writes, malformed/oversized bodies without starting a load", async () => {
    const load = vi.fn(); const handler = createWebsiteLoadHandler(load, env, { loading: false });
    expect((await handler(request(undefined, "localhost:3000", { origin: "https://evil.example" }))).status).toBe(403);
    expect((await handler(request(undefined, "localhost:3000", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    const missing = request(); missing.headers.delete("origin"); expect((await handler(missing)).status).toBe(403);
    for (const body of ["{", JSON.stringify({ url: "x".repeat(5000) }), JSON.stringify({ url: 42 })]) {
      const req = request();
      expect((await handler(new Request(req, { body }))).status).toBe(400);
    }
    expect(load).not.toHaveBeenCalled();
  });
  it("returns 404 through both the proxy and exported route before pilot invitation checks", async () => {
    try {
      for (const settings of [{ IFD_PILOT_MODE: "yes", PILOT_ACCESS_TOKEN: "" }, { IFD_PILOT_MODE: "", PILOT_ACCESS_TOKEN: "synthetic-invitation" }]) {
        for (const [key, value] of Object.entries({ ...env, ...settings })) vi.stubEnv(key, value);
        expect(proxy(new NextRequest(request()))?.status).toBe(404);
        expect((await POST(request())).status).toBe(404);
      }
      vi.stubEnv("IFD_PILOT_MODE", ""); vi.stubEnv("PILOT_ACCESS_TOKEN", "");
      expect(proxy(new NextRequest(request(undefined, "public.example")))?.status).toBe(404);
      expect((await POST(request(undefined, "public.example"))).status).toBe(404);
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects a second load across handler objects and releases the shared lock after success/failure", async () => {
    const lock = { loading: false }; let finish!: (result: WebsiteLoadResult) => void;
    const load = vi.fn(() => new Promise<WebsiteLoadResult>(resolve => { finish = resolve; }));
    const first = createWebsiteLoadHandler(load, env, lock)(request());
    const second = createWebsiteLoadHandler(load, env, lock);
    const busy = await second(request());
    expect(busy.status).toBe(409); expect(await busy.text()).toContain("already loading");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    finish(loadResult("new-site")); expect(await (await first).json()).toEqual({ location: "/b/new-site", pages: 1, skipped: 0, truncated: false });
    expect(lock.loading).toBe(false);
    const failure = createWebsiteLoadHandler(async () => { throw Error("internal-secret"); }, env, lock);
    const failed = await failure(request()); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("internal-secret");
    expect(lock.loading).toBe(false);
    expect((await createWebsiteLoadHandler(async () => loadResult("again"), env, lock)(request())).status).toBe(200);
  });
  it.each([
    [new IngestionError("robots", "private-page-text"), "blocks automated reading"],
    [new IngestionError("empty", "private-page-text"), "No readable pages"],
    [new IngestionError("unreachable", "private-page-text"), "Could not reach"],
    [new IngestionError("incomplete", "private-page-text"), "previously saved pages were kept"],
    [new ProviderError("FREE_TIER_EXHAUSTED"), "Free daily limit reached"],
  ])("returns only a safe plain-English failure for %s", async (error, message) => {
    const response = await createWebsiteLoadHandler(async () => { throw error; }, env, { loading: false })(request());
    const body = await response.text(); expect(response.ok).toBe(false); expect(body).toContain(message); expect(body).not.toContain("private-page-text");
  });
  it("stores Gemini 768 vectors through the actual ingest pipeline and retrieves/chats with the same runtime", async () => {
    const calls = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(":batchEmbedContents")) {
        const body = JSON.parse(String(init.body));
        expect(body.requests.length).toBeGreaterThan(0);
        for (const entry of body.requests) {
          expect(entry).toMatchObject({ model: `models/${model}`, outputDimensionality: 768 });
          expect(entry).not.toHaveProperty("taskType");
        }
        return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(0.01) })) });
      }
      if (url.includes(":embedContent")) {
        expect(JSON.parse(String(init.body))).toMatchObject({ model: `models/${model}`, outputDimensionality: 768 });
        return Response.json({ embedding: { values: Array(768).fill(0.01) } });
      }
      // A supported refusal is sufficient to verify the new business reaches the answer path.
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "The website doesn't say.", citedChunkIds: [] }) }] } }] });
    });
    const runtime = createChatRuntime(env, calls);
    const load = createWebsiteLoader(async () => db, runtime, fixtureCrawl("bright-salon"));
    const response = await createWebsiteLoadHandler(load, env, { loading: false })(request());
    expect(response.status).toBe(200);
    const id = stableId(`https://bright.test\n${model}`); const slug = `site-${id}`;
    expect(await response.json()).toEqual({ location: `/b/${slug}`, pages: 2, skipped: 0, truncated: false });
    const repo = businessRepository(db, id);
    expect(await repo.getBusiness()).toMatchObject({ embeddingModel: model, embeddingDimensions: 768, sourceUrl: "https://bright.test" });
    expect((await db.query("SELECT DISTINCT embedding_model, embedding_dimensions FROM chunks")).rows).toEqual([{ embedding_model: model, embedding_dimensions: 768 }]);
    expect(calls).toHaveBeenCalledTimes(1); // Three chunks share one batch request.
    expect(JSON.parse(String(calls.mock.calls[0][1].body)).requests).toHaveLength(3);
    const retrieved = await retrieve("What are your hours?", repo, { adapter: runtime(model).embeddings });
    expect(retrieved.chunks.length).toBeGreaterThan(0);
    const chat = createChatHandler(async () => db, new ChatRateLimiter(), undefined, runtime, { data: localBusinessData(async () => db) });
    const chatReply = await chat(new Request("http://localhost:3000/api/chat", { method: "POST", body: JSON.stringify({ slug, question: "What are your hours?" }) }));
    expect(chatReply.status).toBe(200);
    expect(await chatReply.json()).toHaveProperty("kind");
    expect(calls.mock.calls.some(([url]) => url.includes(":generateContent"))).toBe(true);
    expect(await localBusinessData(async () => db).report(id)).toBeNull();
    const before = await repo.listPageTexts();
    const capped = createWebsiteLoader(async () => db, runtime, { ...fixtureCrawl("bright-salon"), limits: { maxPages: 1 } });
    expect(before).toHaveLength(2);
    expect(await capped(websiteRoot("https://bright.test"))).toEqual({ slug, pages: 1, skipped: 0, truncated: true });
    expect(await repo.listPageTexts()).toHaveLength(1);
    await load(websiteRoot("https://bright.test"));
    expect((await db.query("SELECT business_id FROM businesses")).rows).toHaveLength(1);
  });
  it("returns safe page/skip/truncation counts, replaces a box snapshot on partial success, and preserves it on fatal failure", async () => {
    const http = vi.fn(async (_url: string, init: RequestInit) => Response.json({ embeddings:
      JSON.parse(String(init.body)).requests.map(() => ({ values: Array(768).fill(0.01) })) }));
    const runtime = createChatRuntime(env, http);
    const options = fixtureCrawl("bright-salon");
    options.limits = { maxPages: 2 };
    options.transport = async ({ url }) => {
      if (url.pathname === "/offline") throw Error("internal-network-error");
      const status = url.pathname === "/apply" ? 302 : url.pathname === "/missing" ? 404 : 200;
      const body = url.pathname === "/robots.txt" ? "User-agent: *\nDisallow: /private"
        : url.pathname === "/" ? '<h1>Business</h1><p>Public information.</p><nav>' +
          ["/apply", "/missing", "/pdf", "/private", "/offline", "/good", "/extra"].map(path => `<a href="${path}">Page</a>`).join("") + "</nav>"
          : "<h2>Services</h2><p>Helpful service information.</p>";
      return { status, headers: { "content-type": url.pathname === "/pdf" ? "application/pdf" : "text/html",
        ...(status === 302 ? { location: "https://outside.test/portal" } : {}) },
        body: (async function* () { yield Buffer.from(body); })(), destroy() {} };
    };
    const load = createWebsiteLoader(async () => db, runtime, options);
    const response = await createWebsiteLoadHandler(load, env, { loading: false })(request("https://partial.test"));
    const slug = `site-${stableId(`https://partial.test\n${model}`)}`;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ location: `/b/${slug}`, pages: 2, skipped: 5, truncated: true });
    expect(websiteLoadSummary(slug)).toEqual({ pages: 2, skipped: 5, truncated: true });
    const repo = businessRepository(db, stableId(`https://partial.test\n${model}`));
    expect((await repo.listPageTexts()).map(page => page.pageUrl)).toEqual(["https://partial.test/", "https://partial.test/good"]);
    const refresh = fixtureCrawl("bright-salon");
    refresh.transport = async ({ url }) => ({ status: url.pathname === "/robots.txt" ? 404 : 200, headers: { "content-type": "text/html" },
      body: (async function* () { yield Buffer.from("<h1>Updated</h1><p>Only the new homepage was collected.</p>"); })(), destroy() {} });
    await createWebsiteLoader(async () => db, runtime, refresh)(websiteRoot("https://partial.test"));
    const beforeFailure = await repo.listPageTexts(); expect(beforeFailure).toHaveLength(1);
    const broken = fixtureCrawl("bright-salon");
    broken.transport = async () => { throw Error("private-internal-failure"); };
    expect((await createWebsiteLoadHandler(createWebsiteLoader(async () => db, runtime, broken), env)(request("https://partial.test"))).status).toBe(422);
    expect(await repo.listPageTexts()).toEqual(beforeFailure);
  });
  it.each(["start-http", "start-redirect", "start-network", "robots-http", "robots-disallow", "zero-readable"])("fails %s loads before embedding any content", async kind => {
    const http = vi.fn(); const options = fixtureCrawl("bright-salon");
    options.transport = async ({ url }) => {
      const robots = url.pathname === "/robots.txt";
      if (!robots && kind === "start-network") throw Error("private-network-error");
      const status = robots ? kind === "robots-http" ? 503 : kind === "robots-disallow" ? 200 : 404
        : kind === "start-http" ? 404 : kind === "start-redirect" ? 302 : 200;
      return { status, headers: { "content-type": "text/html", ...(status === 302 ? { location: "https://outside.test/" } : {}) },
        body: (async function* () { yield Buffer.from(robots ? "User-agent: *\nDisallow: /" : "<h1>Heading only</h1>"); })(), destroy() {} };
    };
    const response = await createWebsiteLoadHandler(createWebsiteLoader(async () => db, createChatRuntime(env, http), options), env)(request(`https://${kind}.test`));
    expect(response.status).toBe(422); const body = await response.text();
    expect(body).not.toMatch(/private-network-error|External origin ignored|Page status/);
    if (kind === "zero-readable") expect(body).toContain("No readable pages");
    expect(http).not.toHaveBeenCalled();
  });
  it("rejects private DNS, private redirects, robots denial and empty HTML through the real crawler, without embeddings", async () => {
    const http = vi.fn(); const runtime = createChatRuntime(env, http);
    for (const mode of ["dns", "redirect", "robots", "empty", "unreachable"] as const) {
      const options = fixtureCrawl("bright-salon");
      if (mode === "dns") options.dns = async () => [{ address: "127.0.0.1", family: 4 }];
      options.transport = vi.fn(async ({ url }) => {
        if (mode === "unreachable") throw Error("private-internal-details");
        return { status: mode === "redirect" ? 302 : 200,
          headers: { "content-type": "text/html", ...(mode === "redirect" ? { location: "http://169.254.169.254/" } : {}) },
          body: (async function* () { yield Buffer.from(url.pathname === "/robots.txt" ? mode === "robots" ? "User-agent: *\nDisallow: /" : "User-agent: *\nAllow: /" : "<html><body></body></html>"); })(), destroy() {} };
      });
      const load = createWebsiteLoader(async () => db, runtime, options);
      const response = await createWebsiteLoadHandler(load, env, { loading: false })(request(`https://${mode}.test/`));
      expect(response.status).toBe(422);
      const body = await response.text(); expect(body).not.toContain("private-internal-details");
      if (mode === "robots") expect(body).toContain("blocks automated reading");
      if (mode === "empty") expect(body).toContain("No readable pages");
      if (mode === "dns") expect(options.transport).not.toHaveBeenCalled();
    }
    expect(http).not.toHaveBeenCalled();
  });
  it("refuses an oversized load before embedding and still serves another saved business through the actual chat handler", async () => {
    const http = vi.fn(async (url: string) => url.includes(":embedContent")
      ? Response.json({ embedding: { values: Array(768).fill(0.01) } })
      : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "The website doesn't say.", citedChunkIds: [] }) }] } }] }));
    const budget = { reserve: vi.fn(async () => true), stop: vi.fn(async () => {}) };
    const runtime = createChatRuntime({ ...env, LOCAL_CHAT_MAX_CALLS: "3" }, http, budget);
    await runtime(model).embeddings.embed("earlier request");
    const options = fixtureCrawl("bright-salon");
    options.transport = async ({ url }) => ({ status: 200, headers: { "content-type": "text/html" },
      body: (async function* () { yield Buffer.from(url.pathname === "/robots.txt" ? "User-agent: *\nAllow: /"
        : Array.from({ length: 250 }, (_, i) => `<h2>Section ${i}</h2><p>A separate short excerpt.</p>`).join("")); })(), destroy() {} });
    const response = await createWebsiteLoadHandler(createWebsiteLoader(async () => db, runtime, options), env, { loading: false })(request("https://too-large.test"));
    expect(response.status).toBe(409); expect(await response.text()).toContain("remaining calls are still available for chat");
    expect(http).toHaveBeenCalledTimes(1); expect(budget.reserve).toHaveBeenCalledTimes(1); expect(budget.stop).not.toHaveBeenCalled();
    const chat = createChatHandler(async () => db, new ChatRateLimiter(), undefined, runtime);
    const slug = `site-${stableId(`https://bright.test\n${model}`)}`;
    const answer = await chat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ slug, question: "What are your hours?" }) }));
    expect(answer.status).toBe(200); expect(await answer.json()).toHaveProperty("kind");
    expect(http).toHaveBeenCalledTimes(3); expect(budget.stop).not.toHaveBeenCalled();
    expect((await businessRepository(db, stableId(`https://too-large.test\n${model}`)).listPageTexts())).toEqual([]);
  });
  it("quota exhaustion during embedding preserves the last complete snapshot and shares the chat stop", async () => {
    const id = stableId(`https://bright.test\n${model}`); const repo = businessRepository(db, id);
    const before = await repo.listPageTexts(); expect(before.length).toBeGreaterThan(0);
    const http = vi.fn(async () => Response.json({}, { status: 429 }));
    const runtime = createChatRuntime(env, http);
    const load = createWebsiteLoader(async () => db, runtime, fixtureCrawl("bright-salon"));
    const response = await createWebsiteLoadHandler(load, env, { loading: false })(request());
    expect(response.status).toBe(503); expect(await response.text()).toContain("Free daily limit reached");
    expect(await repo.listPageTexts()).toEqual(before);
    expect(() => runtime(model)).toThrow("FREE_TIER_EXHAUSTED");
    expect(http).toHaveBeenCalledTimes(1);
  });
});
