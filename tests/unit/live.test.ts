import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { outputPath } from "../../src/lib/output-path";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { evalKeysFromFile, guardedTransport, main } from "../../scripts/live";
import { latestReport } from "../../src/lib/eval/runner";
import { questionRepository } from "../../src/lib/eval/questions";
import { stableId } from "../../src/lib/chunk";
import type { HttpTransport } from "../../src/lib/models/providers";

const GEMINI = "synthetic-live-gemini-marker", GROQ = "synthetic-live-groq-marker";
const env = { LIVE_OK: "yes", GEMINI_EVAL_API_KEY: GEMINI, GROQ_EVAL_API_KEY: GROQ };
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
  return { url, output, transport, dependencies: { env, db, transport, crawlOptions, readEnv: async () => "", output: (line: string) => output.push(line), sleep: async () => {} },
    businessId: stableId(`${new URL(url).origin}|gemini-embedding-001`) };
}
it("refuses without LIVE_OK before env-file access or any transport", async () => {
  const readEnv = vi.fn(), transport = vi.fn();
  await expect(main(["https://fixture.example/"], { env: {}, readEnv, transport })).rejects.toThrow("LIVE_OK=yes");
  expect(readEnv).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
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
  await expect(timeout.transport("https://fixture.invalid", {})).rejects.toThrow("PROVIDER_REQUEST_FAILED");
});
