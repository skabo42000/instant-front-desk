import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../src/lib/db/client";
import { businessRepository } from "../src/lib/db/repository";
import { stableId } from "../src/lib/chunk";
import { parsePublicUrl } from "../src/lib/crawl/url-policy";
import type { CrawlOptions } from "../src/lib/crawl/crawl";
import { nodeTransport } from "../src/lib/crawl/safe-fetch";
import { ingest } from "../src/lib/ingest";
import { questionRepository } from "../src/lib/eval/questions";
import { runEvaluation, scoreReport, type Judge } from "../src/lib/eval/runner";
import { evaluationProviders, type HttpTransport } from "../src/lib/models/providers";
import { assertIndependentJudge, ModelGateway } from "../src/lib/models/gateway";
import { outputPath } from "../src/lib/output-path";

const USAGE = "Usage: npm run live -- <https URL> [--max-calls N] [--pause-ms N] [--approve-generated]";
const KEY_NAMES = ["GEMINI_EVAL_API_KEY", "GROQ_EVAL_API_KEY"] as const;
type Env = Readonly<Record<string, string | undefined>>;

// Parse only isolated eval keys. File settings cannot authorize LIVE_OK or change models.
export function evalKeysFromFile(contents: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(GEMINI_EVAL_API_KEY|GROQ_EVAL_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2];
    keys[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, "");
  }
  return keys;
}
export function redact(value: string, keys: readonly string[]): string {
  for (const key of keys) if (key) value = value.split(key).join("[redacted]");
  return value;
}
export function guardedTransport(transport: HttpTransport, maxCalls: number, keys: readonly string[], timeoutMs = 5000) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error(USAGE);
  let calls = 0;
  let stop: string | null = null;
  let limit: LimitDetail | null = null;
  // Keep only a short label (which service, which window), never the provider's raw message.
  const recordLimit = (url: string, raw: string, retryAfter: string | null) => {
    const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
    const window = /per.?day|\b(?:RPD|TPD)\b|daily/i.test(raw) ? "per-day"
      : /per.?minute|\b(?:RPM|TPM)\b/i.test(raw) ? "per-minute" : "unknown";
    limit = { service: host.endsWith("groq.com") ? "groq" : host.endsWith("googleapis.com") ? "gemini" : "other",
      window, kind: /token/i.test(raw) ? "tokens" : /request/i.test(raw) ? "requests" : "unknown",
      retryAfterSeconds: retryAfter && /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) : null };
    stop = "FREE_TIER_EXHAUSTED";
  };
  const guarded: HttpTransport = async (url, init) => {
    if (stop) throw new Error(stop);
    if (calls >= maxCalls) { stop = "REQUEST_CAP_REACHED"; throw new Error(stop); }
    calls++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (init.signal?.aborted) throw new Error("REQUEST_TIMEOUT");
      return await Promise.race([
        (async () => {
          const response = await transport(url, { ...init, signal: controller.signal, redirect: "error" });
          const raw = await response.text();
          if (response.status === 429) { recordLimit(url, raw, response.headers.get("retry-after")); throw new Error(stop!); }
          let decoded: unknown;
          try { decoded = JSON.parse(raw); } catch { /* Adapter rejects malformed JSON. */ }
          const hasError = decoded && typeof decoded === "object" && "error" in decoded;
          if ((!response.ok || hasError) && /quota|resource_exhausted|rate.?limit|free.?tier/i.test(raw)) {
            recordLimit(url, raw, response.headers.get("retry-after")); throw new Error(stop!);
          }
          // Check both keys, including escaped JSON, before any model data is stored.
          if (keys.some(key => key && (raw.includes(key) || JSON.stringify(decoded)?.includes(key)))) throw new Error("SENSITIVE_REPLY");
          return new Response(raw, { status: response.status, headers: response.headers });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("REQUEST_TIMEOUT")); }, timeoutMs);
          controller.signal.addEventListener("abort", () => reject(new Error("REQUEST_TIMEOUT")), { once: true });
        }),
      ]);
    } catch { throw new Error(stop ?? "PROVIDER_REQUEST_FAILED"); }
    finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
  };
  return { transport: guarded, callsUsed: () => calls, stopReason: () => stop, limitDetail: () => limit,
    stopForQuota: () => { stop = "FREE_TIER_EXHAUSTED"; } };
}
export interface LimitDetail {
  service: "gemini" | "groq" | "other";
  window: "per-minute" | "per-day" | "unknown";
  kind: "tokens" | "requests" | "unknown";
  retryAfterSeconds: number | null;
}
const describeLimit = (detail: LimitDetail | null) => detail
  ? `free-tier limit reached: ${detail.service}, ${detail.window}, ${detail.kind}${detail.retryAfterSeconds !== null ? `, retry after ${detail.retryAfterSeconds}s` : ""}`
  : "free-tier limit reached";
export interface LiveDependencies {
  env?: Env;
  readEnv?: () => Promise<string>;
  transport?: HttpTransport;
  crawlOptions?: CrawlOptions;
  db?: PGlite;
  judge?: Judge;
  output?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}
export async function main(args: readonly string[], dependencies: LiveDependencies = {}): Promise<void> {
  const env = dependencies.env ?? process.env;
  // Refuse before reading credentials, opening the database, or using any transport.
  if (env.LIVE_OK !== "yes") throw new Error("Set LIVE_OK=yes for an explicitly authorized live session.");
  const url = parsePublicUrl(args[0] ?? "");
  if (url.protocol !== "https:") throw new Error(USAGE);
  // A short pause between questions keeps free per-minute limits from stopping the run.
  let maxCalls = 120, pauseMs = 3000, approve = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--approve-generated" && !approve) approve = true;
    else if (args[i] === "--max-calls") maxCalls = Number(args[++i]);
    else if (args[i] === "--pause-ms") pauseMs = Number(args[++i]);
    else throw new Error(USAGE);
  }
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error(USAGE);
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 0 || pauseMs > 60000) throw new Error(USAGE);
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  let file = "";
  try { file = await (dependencies.readEnv ?? (() => readFile(resolve(".env.local"), "utf8")))(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot load local evaluation settings."); }
  const settings: Record<string, string | undefined> = evalKeysFromFile(file);
  for (const name of KEY_NAMES) if (env[name]) settings[name] = env[name];
  for (const name of ["GEMINI_ANSWER_MODEL", "GEMINI_QUESTION_MODEL", "GROQ_MODEL"]) settings[name] = env[name];
  const keys = KEY_NAMES.map(name => settings[name] ?? "");
  const print = (line: string) => (dependencies.output ?? console.log)(redact(line, keys));
  const budget = guardedTransport(dependencies.transport ?? ((input, init) => fetch(input, init)), maxCalls, keys);
  let db: PGlite | undefined;
  try {
    if (redact(url.href, keys) !== url.href) throw new Error("Sensitive URL");
    if (Object.values(settings).some(value => value && !keys.includes(value) && redact(value, keys) !== value)) throw new Error("Sensitive model setting");
    const providers = evaluationProviders(settings, budget.transport);
    const judge = dependencies.judge ?? providers.judge;
    assertIndependentJudge(providers.answer.family, judge);
    db = dependencies.db ?? await openDatabase(resolve("data/instant-front-desk"));
    // Separate real vector space from businesses previously created with fake embeddings.
    const businessId = stableId(`${url.origin}|${providers.embeddings.model}`);
    const repo = businessRepository(db, businessId);
    if (!await repo.getBusiness()) await repo.createBusiness({ slug: `live-${businessId}`, name: url.hostname,
      sourceUrl: url.origin, phone: null, contactUrl: null, embeddingModel: providers.embeddings.model });
    const snapshot = await ingest(url.href, repo, { adapter: providers.embeddings, crawlOptions: {
      ...dependencies.crawlOptions,
      transport: async request => {
        if (budget.stopReason()) throw new Error("Live run stopped");
        const response = await (dependencies.crawlOptions?.transport ?? nodeTransport)(request);
        if (response.status === 429) {
          response.destroy(); budget.stopForQuota(); throw new Error("Live run stopped");
        }
        return response;
      },
    } });
    print(`pages crawled: ${snapshot.pages}`);
    print(`chunks: ${snapshot.chunks}`);
    const questions = questionRepository(db, businessId);
    const generated = await questions.generate(providers.questions);
    print(`questions: ${generated.questions.length}`);
    for (const question of generated.questions.filter(q => q.validationErrors.length)) {
      print(`flagged: ${question.question} — ${question.validationErrors.join(", ")}`);
    }
    if (!approve) {
      print(`Review via npm run questions -- ${businessId} show ${generated.version}; evaluation stopped. Use --approve-generated only after deciding to approve generated unflagged questions.`);
      return;
    }
    const approved = await questions.approveUnflagged(generated.version);
    const crawlRun = (await db.query<{ id: string }>("SELECT id FROM crawl_runs WHERE business_id=$1 AND status='completed' ORDER BY finished_at DESC LIMIT 1", [businessId])).rows[0];
    const gateway = new ModelGateway({ primary: { provider: "gemini", model: providers.answer.model,
      family: providers.answer.family, adapter: providers.answer }, retry: false, attemptTimeoutMs: 5000, totalTimeoutMs: 5000 });
    const report = await runEvaluation(db, businessId, approved.version, { crawlRunId: crawlRun.id, judge, gateway,
      embeddings: providers.embeddings, answerModel: providers.answer.model, stopReason: budget.stopReason, pause: () => sleep(pauseMs),
      sanitizeResult: entry => JSON.parse(redact(JSON.stringify(entry), keys)) });
    const score = scoreReport(report);
    await mkdir(outputPath("reports/private"), { recursive: true });
    await writeFile(outputPath("reports/private", `${report.id}.json`), redact(JSON.stringify({ ...report, score, callsUsed: budget.callsUsed(), limit: budget.limitDetail() }, null, 2), keys), { mode: 0o600 });
    print(`score: ${score.passed}/${score.total}`);
    for (const failure of score.failures) print(`failure: ${failure.question.question} — ${(failure.error ?? failure.verdict?.reason ?? "missing verdict").slice(0, 200)}`);
    print(`execution errors: ${report.results.filter(r => r.error).length}`);
    if (budget.stopReason()) { print(budget.stopReason() === "FREE_TIER_EXHAUSTED" ? describeLimit(budget.limitDetail()) : "request cap reached"); process.exitCode = 1; }
  } catch {
    print(budget.stopReason() === "FREE_TIER_EXHAUSTED" ? describeLimit(budget.limitDetail()) : budget.stopReason() === "REQUEST_CAP_REACHED" ? "request cap reached" : "Live execution failed; no successful evaluation completed.");
    process.exitCode = 1;
  } finally {
    print(`calls used: ${budget.callsUsed()}`);
    if (db && !dependencies.db) await db.close();
  }
}
