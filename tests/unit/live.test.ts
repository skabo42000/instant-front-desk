import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { outputPath } from "../../src/lib/output-path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { evalKeysFromFile, guardedTransport, main, pacedEmbeddings } from "../../scripts/live";
import { latestReport } from "../../src/lib/eval/runner";
import { questionRepository } from "../../src/lib/eval/questions";
import { stableId } from "../../src/lib/chunk";
import { evaluationProviders, GeminiQuestions, GeminiAnswer } from "../../src/lib/models/providers";
import { ModelGateway } from "../../src/lib/models/gateway";
import type { HttpTransport } from "../../src/lib/models/providers";

const GEMINI = "synthetic-live-gemini-marker", GROQ = "synthetic-live-groq-marker";
const env = { LIVE_OK: "yes", FREE_TIER_CONFIRMED: "yes", GEMINI_EVAL_API_KEY: GEMINI, GROQ_EVAL_API_KEY: GROQ };
let db: PGlite;
beforeAll(async () => { db = await openDatabase(); }, 60000);
afterAll(async () => { await db?.close(); });
afterEach(() => { process.exitCode = 0; });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const gemini = (value: unknown) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
function fixture(name: string, options: { quotaAt?: number; status?: number; echo?: boolean; flags?: boolean } = {}) {
  const url = `https://${name}.example/`;
  const output: string[] = [];
  let count = 0;
  const transport: HttpTransport = vi.fn(async (requestUrl, init) => {
    count++;
    if (count === options.quotaAt) return json({ error: { status: "RESOURCE_EXHAUSTED", message: GEMINI + " quota exceeded" } }, options.status ?? 429);
    if (requestUrl.includes("embedContent")) {
      expect(JSON.parse(String(init.body)).outputDimensionality).toBe(768);
      return json({ embedding: { values: Array(768).fill(0.1) } });
    }
    if (requestUrl.includes("groq")) return json({ choices: [{ message: { content: JSON.stringify({ pass: false, reason: options.echo ? GEMINI : "fixture failure" }) } }] });
    const body = JSON.parse(String(init.body));
    if (body.systemInstruction.parts[0].text.includes("Generate 20")) {
      const chunks = JSON.parse(body.contents[0].parts[0].text);
      return gemini([{ question: "What haircuts are available?", expectedBehavior: "Cite the service.", evidenceChunkIds: [chunks[0].id] },
        ...(options.flags ? [{ question: "Unsourced?", expectedBehavior: "Answer", evidenceChunkIds: [] }] : [])]);
    }
    const sources = JSON.parse(body.contents[0].parts[0].text).sources;
    return gemini({ text: "Haircuts available.", citedChunkIds: [sources[0].id] });
  });
  const crawlOptions = { dns: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: vi.fn(async ({ url: pageUrl }: { url: URL }) => ({ status: 200,
      headers: { "content-type": pageUrl.pathname === "/robots.txt" ? "text/plain" : "text/html" },
      body: (async function* () { yield Buffer.from(pageUrl.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : "<html><h1>Haircuts</h1><p>Haircuts available.</p></html>"); })(), destroy() {} })) };
  return { url, output, transport, dependencies: { env, db, transport, crawlOptions, embeddingCacheDirectory: outputPath("data/embedding-cache", randomUUID()), readEnv: async () => "", output: (line: string) => output.push(line), sleep: async () => {} },
    businessId: stableId(`${new URL(url).origin}|gemini-embedding-001`) };
}
it("refuses without LIVE_OK before env-file access or any transport", async () => {
  const readEnv = vi.fn(), transport = vi.fn();
  await expect(main(["https://fixture.example/"], { env: {}, readEnv, transport })).rejects.toThrow("LIVE_OK=yes");
  expect(readEnv).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});
it("requires free-plan confirmation before reading credentials or making calls", async () => {
  const readEnv = vi.fn(), transport = vi.fn();
  await expect(main(["https://fixture.example/"], { env: { LIVE_OK: "yes" }, readEnv, transport })).rejects.toThrow("FREE_TIER_CONFIRMED=yes");
  expect(readEnv).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});
it("reruns the exact approved questions and snapshot without crawling or generating questions", async () => {
  const first = fixture("frozen-regression");
  await main([first.url, "--approve-generated"], first.dependencies);
  const before = (await latestReport(db, first.businessId))!;
  const second = fixture("frozen-regression");
  await main([second.url, "--reuse-snapshot", "--question-version", String(before.questionVersion)], second.dependencies);
  const after = (await latestReport(db, first.businessId))!;
  expect(after.id).not.toBe(before.id);
  expect(after.questionVersion).toBe(before.questionVersion);
  expect(after.crawlRunId).toBe(before.crawlRunId);
  expect(after.results.map(r => r.question)).toEqual(before.results.map(r => r.question));
  expect(second.dependencies.crawlOptions.transport).not.toHaveBeenCalled();
  expect(vi.mocked(second.transport).mock.calls.every(([, init]) => !String(init.body).includes("Generate 20"))).toBe(true);
  expect(await questionRepository(db, first.businessId).list()).toHaveLength(1);
  const report = JSON.parse(await readFile(outputPath("reports/private", `${after.id}.json`), "utf8"));
  expect(report.questionVersion).toBe(before.questionVersion);
  expect(report.results.filter((r: { question: { kind: string }; questionModel: string | null }) => r.question.kind === "source").every((r: { questionModel: string | null }) => r.questionModel === null)).toBe(true);
});
it("rejects an invalid frozen run before any website or provider call", async () => {
  for (const args of [["--reuse-snapshot"], ["--question-version", "1"], ["--reuse-snapshot", "--question-version", "0"],
    ["--reuse-snapshot", "--question-version", "1", "--approve-generated"]]) {
    const f = fixture("bad-frozen-flags");
    await expect(main([f.url, ...args], f.dependencies)).rejects.toThrow("Usage");
    expect(f.transport).not.toHaveBeenCalled();
  }
  for (const approved of [false, true]) {
    const f = fixture(`missing-frozen-${approved}`);
    if (!approved) await main([f.url], f.dependencies);
    vi.mocked(f.transport).mockClear(); vi.mocked(f.dependencies.crawlOptions.transport).mockClear();
    await main([f.url, "--reuse-snapshot", "--question-version", "1"], f.dependencies);
    expect(f.transport).not.toHaveBeenCalled(); expect(f.dependencies.crawlOptions.transport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  }
});
it("loads only evaluation keys from local file and never reads widget env settings", async () => {
  expect(evalKeysFromFile('GEMINI_API_KEY=forbidden\nGROQ_API_KEY=forbidden\nLIVE_OK=yes\nGEMINI_EVAL_API_KEY="fixture-g"\nexport GROQ_EVAL_API_KEY=fixture-q # comment')).toEqual({ GEMINI_EVAL_API_KEY: "fixture-g", GROQ_EVAL_API_KEY: "fixture-q" });
  const f = fixture("review");
  const restricted = new Proxy(env, { get(target, name) {
    if (["GEMINI_API_KEY", "GROQ_API_KEY"].includes(String(name))) throw new Error("Forbidden read");
    return target[name as keyof typeof target];
  } });
  await main([f.url], { ...f.dependencies, env: restricted, readEnv: async () => `GEMINI_EVAL_API_KEY=${GEMINI}\nGROQ_EVAL_API_KEY=${GROQ}` });
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect(f.output.join("\n")).toContain("questions: 7");
  expect(f.output.join("\n")).toContain(`npm run questions -- ${f.businessId} show 1`);
  expect(await latestReport(db, f.businessId)).toBeNull();
  expect((await questionRepository(db, f.businessId).get(1)).approvedAt).toBeNull();
});
it("enforces the shared hard cap during eval and refuses values above 300", async () => {
  const f = fixture("capped");
  await main([f.url, "--max-calls", "4", "--approve-generated"], f.dependencies);
  expect(f.transport).toHaveBeenCalledTimes(4);
  expect(f.output).toContain("request cap reached"); expect(f.output).toContain("calls used: 4");
  const results = (await latestReport(db, f.businessId))!.results;
  const stoppedAt = results.findIndex(r => r.error === "REQUEST_CAP_REACHED");
  expect(stoppedAt).toBeGreaterThanOrEqual(0);
  expect(results.slice(stoppedAt).every(r => !r.verdict)).toBe(true);
  await expect(main([f.url, "--max-calls", "301"], f.dependencies)).rejects.toThrow("Usage");
});
it("429/quota stops immediately at embedding, answer and judge stages across providers", async () => {
  for (const [name, quotaAt, status] of [["embed-quota", 1, 429], ["answer-quota", 4, 429], ["judge-quota", 5, 403]] as const) {
    const f = fixture(name, { quotaAt, status });
    await main([f.url, "--approve-generated"], f.dependencies);
    expect(f.transport).toHaveBeenCalledTimes(quotaAt);
    expect(f.output.some(line => line.startsWith("free-tier limit reached: "))).toBe(true);
    // The output names which service hit the limit. The first question is a trap refused without asking
    // Gemini, so call 4 is the Groq judge and call 5 embeds the second question (Gemini).
    expect(f.output.join("\n")).toContain(name === "answer-quota" ? "limit reached: groq" : "limit reached: gemini");
    expect(f.output.join("\n")).not.toContain(GEMINI);
    const report = await latestReport(db, f.businessId);
    if (report) expect(JSON.stringify(report)).not.toContain(GEMINI);
  }
});
it("rejects cross-provider echoed keys; output and both report copies stay key-free", async () => {
  const f = fixture("redacted", { echo: true });
  await main([f.url, "--approve-generated"], f.dependencies);
  const report = (await latestReport(db, f.businessId))!;
  expect(report.results.some(r => r.error)).toBe(true);
  for (const content of [f.output.join("\n"), JSON.stringify(report), await readFile(outputPath("reports/private", `${report.id}.json`), "utf8"), await readFile(outputPath("data/eval-reports", `${report.id}.json`), "utf8")]) {
    expect(content).not.toContain(GEMINI); expect(content).not.toContain(GROQ);
  }
});
it("wrong-family judge rejected before crawling or model calls", async () => {
  const f = fixture("wrong-family");
  await main([f.url, "--approve-generated"], { ...f.dependencies, judge: { provider: "fixture", model: "gemini-fixture", family: "gemini", judge: vi.fn() } });
  expect(f.transport).not.toHaveBeenCalled(); expect(f.dependencies.crawlOptions.transport).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
it("explicit approval evaluates only unflagged questions while preserving flagged originals", async () => {
  const f = fixture("flagged", { flags: true });
  await main([f.url, "--approve-generated"], f.dependencies);
  const report = (await latestReport(db, f.businessId))!;
  expect(f.output.join("\n")).toContain("flagged: Unsourced?");
  expect(report.results).toHaveLength(7);
  expect(report.results.every(r => !r.question.validationErrors.length)).toBe(true);
  expect((await questionRepository(db, f.businessId).get(1)).questions).toHaveLength(8);
  expect(report.questionVersion).toBe(2);
  expect(f.output).toContain("score: 0/7");
});
it("transport deadlines and raw exceptions never expose keys and exhausted caps stay latched", async () => {
  const blocked = vi.fn(async () => { throw new Error(GEMINI); });
  const budget = guardedTransport(blocked, 1, [GEMINI]);
  await expect(budget.transport("https://fixture.invalid", {})).rejects.toThrow("PROVIDER_REQUEST_FAILED");
  await expect(budget.transport("https://fixture.invalid", {})).rejects.toThrow("REQUEST_CAP_REACHED");
  await expect(budget.transport("https://fixture.invalid", {})).rejects.toThrow("REQUEST_CAP_REACHED");
  expect(blocked).toHaveBeenCalledTimes(1);
  const timeout = guardedTransport(async () => new Promise(() => {}), 120, [GEMINI], 5);
  await expect(timeout.transport("https://fixture.invalid", {})).rejects.toThrow("TIMEOUT");
});
it("paced embeddings wait before a call that would pass the per-minute cap, then continue", async () => {
  let clock = 0;
  const waits: number[] = [];
  const inner = { model: "m", dimensions: 3, embed: vi.fn(async () => [0, 0, 1]) };
  const paced = pacedEmbeddings(inner, 3, async ms => { waits.push(ms); clock += ms; }, () => clock);
  for (let i = 0; i < 3; i++) { await paced.embed("x"); clock += 1000; }
  expect(waits).toEqual([]);
  await paced.embed("x");
  expect(waits).toEqual([58_000]);
  expect(inner.embed).toHaveBeenCalledTimes(4);
  expect(paced.model).toBe("m"); expect(paced.dimensions).toBe(3);
});

it("timeout retried once then succeeds, with backoff and failure kind/model", async () => {
  const transport = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(json({ ok: true }));
  const sleep = vi.fn(async () => {});
  const budget = guardedTransport(transport, 2, [], 5, sleep);
  const response = await budget.transport("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", {});
  expect(response.ok).toBe(true);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(budget.callsUsed()).toBe(2);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
  expect(budget.lastFailure()).toBe("gemini call #1 generation model gemini-3.5-flash-lite timeout after 5 ms");
});

it("retries 5xx once, but never 429, quota, 4xx or arbitrary exceptions", async () => {
  for (const [status, body, attempts] of [[503, {}, 2], [429, {}, 1], [503, { error: "quota exceeded" }, 1], [400, {}, 1]] as const) {
    const transport = vi.fn(async () => json(body, status));
    const sleep = vi.fn(async () => {});
    const budget = guardedTransport(transport, 10, [], 5, sleep);
    await budget.transport("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent", {}).catch(() => {});
    expect(transport).toHaveBeenCalledTimes(attempts);
    expect(budget.callsUsed()).toBe(attempts);
    expect(sleep).toHaveBeenCalledTimes(attempts - 1);
    expect(budget.lastFailure()).toContain("embedding model gemini-embedding-001");
  }
});

it("per-minute 429 with a short retry-after waits and retries; per-day or long waits still stop", async () => {
  const perMinute = () => new Response(JSON.stringify({ error: { message: "Rate limit reached on tokens per minute (TPM)" } }), { status: 429, headers: { "retry-after": "2" } });
  const transport = vi.fn().mockResolvedValueOnce(perMinute()).mockResolvedValueOnce(json({ ok: true }));
  const sleep = vi.fn(async () => {});
  const budget = guardedTransport(transport, 5, [], 5, sleep);
  const response = await budget.transport("https://api.groq.com/openai/v1/chat/completions", { body: JSON.stringify({ model: "openai/gpt-oss-120b" }) });
  expect(response.ok).toBe(true);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(3000);
  expect(budget.callsUsed()).toBe(2);
  expect(budget.stopReason()).toBeNull();
  expect(budget.callLogs().map(log => log.status)).toEqual(["rate-limited (per-minute), waited", "success"]);

  for (const [message, retryAfter] of [["tokens per day (TPD)", "2"], ["tokens per minute (TPM)", "120"], ["tokens per minute (TPM)", null]] as const) {
    const blocked = vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} }));
    const stopped = guardedTransport(blocked, 5, [], 5, async () => {});
    await expect(stopped.transport("https://api.groq.com/openai/v1/chat/completions", { body: "{}" })).rejects.toThrow("FREE_TIER_EXHAUSTED");
    expect(blocked).toHaveBeenCalledTimes(1);
  }

  const always = vi.fn(async () => perMinute());
  const capped = guardedTransport(always, 10, [], 5, async () => {});
  await expect(capped.transport("https://api.groq.com/openai/v1/chat/completions", { body: "{}" })).rejects.toThrow("FREE_TIER_EXHAUSTED");
  expect(always).toHaveBeenCalledTimes(4);
});

it("retry cannot exceed the hard call cap", async () => {
  const transport = vi.fn(async () => json({}, 503));
  const budget = guardedTransport(transport, 1, [], 5, async () => {});
  await expect(budget.transport("https://fixture.invalid", {})).rejects.toThrow("REQUEST_CAP_REACHED");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(budget.callsUsed()).toBe(1);
});

it("second run with same chunks makes 0 embedding calls during ingestion", async () => {
  const first = fixture("cache-reuse");
  await main([first.url], first.dependencies);
  expect(vi.mocked(first.transport).mock.calls.filter(([url]) => url.includes(":embedContent"))).toHaveLength(1);
  const second = fixture("cache-reuse");
  await main([second.url], { ...second.dependencies, embeddingCacheDirectory: first.dependencies.embeddingCacheDirectory });
  expect(vi.mocked(second.transport).mock.calls.filter(([url]) => url.includes(":embedContent"))).toHaveLength(0);
  expect(second.output).toContain("chunks: 1");
  expect(second.output).toContain("questions: 7");
});

it("primary timeout selects a labelled text fallback for questions and answers", async () => {
  for (const kind of ["questions", "answer"] as const) {
    const transport = vi.fn(async (url: string) => url.includes("gemini-primary:")
      ? new Promise<Response>(() => {}) : gemini(kind === "questions" ? [] : { text: "Fixture answer", citedChunkIds: [] }));
    const budget = guardedTransport(transport, 3, [], 5, async () => {});
    const providers = evaluationProviders({ ...env, GEMINI_TEXT_MODEL: "gemini-primary", GEMINI_TEXT_FALLBACK_MODELS: " gemini-backup " }, budget.transport, 100);
    if (kind === "questions") {
      await providers.questions.generate([]);
      expect(providers.questions.generatedModel).toBe("gemini-backup");
    } else {
      const gateway = new ModelGateway({ primary: { provider: "gemini", model: providers.answer.model, family: "gemini", adapter: providers.answer }, retry: false, totalTimeoutMs: 1000, attemptTimeoutMs: 1000 });
      const result = await gateway.generate({ businessId: "fixture", question: "Fixture?", sources: [] });
      expect(result.ok).toBe(true);
      expect(result.logs.at(-1)?.model).toBe("gemini-backup");
    }
    expect(budget.callsUsed()).toBe(3);
    expect(budget.callLogs().map(log => [log.model, log.status])).toEqual([["gemini-primary", "timeout"], ["gemini-primary", "timeout"], ["gemini-backup", "success"]]);
  }
});
it("text fallbacks never follow 429, quota, 400, malformed replies or arbitrary exceptions", async () => {
  for (const [status, body] of [[429, {}], [503, { error: "quota exceeded" }], [400, {}], [200, {}]] as const) {
    const transport = vi.fn(async () => json(body, status));
    const budget = guardedTransport(transport, 10, [], 5, async () => {});
    const provider = new GeminiQuestions(GEMINI, budget.transport, "gemini-primary", 100, ["gemini-backup"]);
    await expect(provider.generate([])).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  }
  const transport = vi.fn(async () => { throw new Error("fixture transport error"); });
  const provider = new GeminiAnswer(GEMINI, guardedTransport(transport, 10, []).transport, "gemini-primary", 100, ["gemini-backup"]);
  await expect(provider.generate({ businessId: "fixture", question: "?", sources: [] })).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
});
it("ordered 5xx text fallbacks count against max-calls and stop at the cap", async () => {
  for (const cap of [2, 3, 5]) {
    const transport = vi.fn(async (url: string) => url.includes("gemini-last:") ? gemini([]) : json({}, 503));
    const budget = guardedTransport(transport, cap, [], 5, async () => {});
    const provider = new GeminiQuestions(GEMINI, budget.transport, "gemini-primary", 100, ["gemini-backup", "gemini-last"]);
    if (cap === 5) { await provider.generate([]); expect(provider.generatedModel).toBe("gemini-last"); }
    else { await expect(provider.generate([])).rejects.toThrow(); expect(budget.stopReason()).toBe("REQUEST_CAP_REACHED"); }
    expect(transport).toHaveBeenCalledTimes(cap);
    expect(budget.callsUsed()).toBe(cap);
    expect(budget.callLogs().map(log => log.model)).toEqual(["gemini-primary", "gemini-primary", "gemini-backup", "gemini-backup", "gemini-last"].slice(0, cap));
  }
});
it("fake full run records fallback question and answer models in both report copies", async () => {
  const f = fixture("fallback-report");
  const transport: HttpTransport = vi.fn(async (url, init) => url.includes("gemini-primary:generateContent") ? json({}, 503) : f.transport(url, init));
  await main([f.url, "--approve-generated"], { ...f.dependencies, transport,
    env: { ...env, GEMINI_TEXT_MODEL: "gemini-primary", GEMINI_TEXT_FALLBACK_MODELS: "gemini-backup" } });
  const report = (await latestReport(db, f.businessId))!;
  expect(report.results.filter(r => r.question.kind === "source").every(r => r.questionModel === "gemini-backup")).toBe(true);
  expect(report.results.some(r => r.answerModel === "gemini-backup")).toBe(true);
  expect(report.results.filter(r => r.question.kind !== "source").every(r => r.questionModel === null)).toBe(true);
  for (const path of [outputPath("reports/private", report.id + ".json"), outputPath("data/eval-reports", report.id + ".json")]) {
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.results.some((r: { answerModel: string }) => r.answerModel === "gemini-backup")).toBe(true);
    expect(saved.results.some((r: { questionModel: string }) => r.questionModel === "gemini-backup")).toBe(true);
  }
  expect(f.output.some(line => line.includes("generation model gemini-backup: success"))).toBe(true);
});
