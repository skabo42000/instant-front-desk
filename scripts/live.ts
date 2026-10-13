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
import { evaluationProviders, ProviderError, type HttpTransport } from "../src/lib/models/providers";
import { assertIndependentJudge, ModelGateway } from "../src/lib/models/gateway";
import { outputPath } from "../src/lib/output-path";
import type { EmbeddingAdapter } from "../src/lib/models/embeddings";
import { cachedEmbeddings } from "../src/lib/models/embedding-cache";

const USAGE = "Usage: npm run live -- <https URL> [--max-calls N] [--pause-ms N] [--approve-generated]";
// Stays under the inferred Gemini embedding limit of 100 per minute, with margin.
const EMBEDDINGS_PER_MINUTE = 80;
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
export function guardedTransport(transport: HttpTransport, maxCalls: number, keys: readonly string[], timeoutMs = 5000,
  sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms))) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error(USAGE);
  let calls = 0;
  const callLogs: { call: number; service: string; kind: string; model: string; status: string }[] = [];
  let stop: string | null = null;
  let limit: LimitDetail | null = null;
  // Last failed call as "service HTTP 404" or "service timeout": a fixed label, no provider text.
  let lastFailure: string | null = null;
  const hostLabel = (url: string) => {
    try { const host = new URL(url).hostname; return host.endsWith("groq.com") ? "groq" : host.endsWith("googleapis.com") ? "gemini" : "website"; }
    catch { return "unknown"; }
  };
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
    let model = "unknown";
    let kind = "unknown";
    try {
      const endpoint = new URL(url).pathname;
      const match = /\/models\/([a-zA-Z0-9._-]+):(embedContent|generateContent)$/.exec(endpoint);
      if (match) { model = match[1]; kind = match[2] === "embedContent" ? "embedding" : "generation"; }
      else if (endpoint.endsWith("/chat/completions")) {
        kind = "generation";
        const supplied = JSON.parse(String(init.body)).model;
        if (typeof supplied === "string" && /^[a-zA-Z0-9/._-]{1,100}$/.test(supplied)) model = supplied;
      }
    } catch { /* Log fixed labels only for unknown requests. */ }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stop) throw new Error(stop);
      if (calls >= maxCalls) { stop = "REQUEST_CAP_REACHED"; throw new Error(stop); }
      if (init.signal?.aborted) throw new Error("PROVIDER_REQUEST_FAILED");
      calls++;
      const call = calls;
      const label = `${hostLabel(url)} call #${call} ${kind} model ${model}`;
      const log = { call, service: hostLabel(url), kind, model, status: "error" };
      callLogs.push(log);
      let retryable = false;
      let failedStatus: number | undefined;
      const controller = new AbortController();
      const abort = () => controller.abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (init.signal?.aborted) throw new Error("REQUEST_TIMEOUT");
        const response = await Promise.race([
          (async () => {
            const response = await transport(url, { ...init, signal: controller.signal, redirect: "error" });
            const raw = await response.text();
            if (!response.ok) lastFailure = `${label} HTTP ${response.status}`;
            if (response.status === 429) { recordLimit(url, raw, response.headers.get("retry-after")); throw new Error(stop!); }
            let decoded: unknown;
            try { decoded = JSON.parse(raw); } catch { /* Adapter rejects malformed JSON. */ }
            const hasError = decoded && typeof decoded === "object" && "error" in decoded;
            if ((!response.ok || hasError) && /quota|resource_exhausted|rate.?limit|free.?tier/i.test(raw)) {
              recordLimit(url, raw, response.headers.get("retry-after")); throw new Error(stop!);
            }
            // Check both keys, including escaped JSON, before any model data is stored.
            if (keys.some(key => key && (raw.includes(key) || JSON.stringify(decoded)?.includes(key)))) throw new Error("SENSITIVE_REPLY");
            if (response.status >= 500 && response.status <= 599) {
              failedStatus = response.status;
              retryable = true;
              throw new Error("RETRYABLE_HTTP_ERROR");
            }
            return new Response(raw, { status: response.status, headers: response.headers });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("REQUEST_TIMEOUT")); }, timeoutMs);
            controller.signal.addEventListener("abort", () => reject(new Error("REQUEST_TIMEOUT")), { once: true });
          }),
        ]);
        log.status = response.ok ? "success" : `HTTP ${response.status}`;
        return response;
      } catch (error) {
        if (error instanceof Error && error.message === "REQUEST_TIMEOUT") {
          lastFailure = `${label} timeout after ${timeoutMs} ms`;
          retryable = !init.signal?.aborted;
        }
        log.status = failedStatus ? `HTTP ${failedStatus}` : error instanceof Error && error.message === "REQUEST_TIMEOUT" ? "timeout" : stop ?? "error";
        if (stop || !retryable || attempt === 1) {
          if (!stop && retryable) throw new ProviderError(failedStatus ? "HTTP_ERROR" : "TIMEOUT", failedStatus);
          throw new Error(stop ?? "PROVIDER_REQUEST_FAILED");
        }
      }
      finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
      // Only transient failures get one retry; the next iteration checks and counts the budget.
      await sleep(1000);
    }
    throw new Error("PROVIDER_REQUEST_FAILED");
  };
  return { transport: guarded, callLogs: () => structuredClone(callLogs), callsUsed: () => calls, stopReason: () => stop, limitDetail: () => limit, lastFailure: () => lastFailure,
    stopForQuota: () => { stop = "FREE_TIER_EXHAUSTED"; } };
}
export interface LimitDetail {
  service: "gemini" | "groq" | "other";
  window: "per-minute" | "per-day" | "unknown";
  kind: "tokens" | "requests" | "unknown";
  retryAfterSeconds: number | null;
}
// Embedding calls (one per chunk at ingest, one per question) arrive in a burst. The 2026-10-12
// synqlogic.com run failed on Gemini embedding call 100 inside a minute (limit inferred, not
// documented here), so wait before a call that would exceed perMinute in any rolling 60 s window.
// The wait happens before the adapter starts its own timeout.
export function pacedEmbeddings(adapter: EmbeddingAdapter, perMinute: number, sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now): EmbeddingAdapter {
  const recent: number[] = [];
  const expire = () => { while (recent.length && now() - recent[0] >= 60_000) recent.shift(); };
  return {
    model: adapter.model, dimensions: adapter.dimensions,
    async embed(text: string) {
      expire();
      if (recent.length >= perMinute) { await sleep(recent[0] + 60_000 - now() + 1000); expire(); }
      recent.push(now());
      return adapter.embed(text);
    },
  };
}
const describeLimit =(detail: LimitDetail | null) => detail
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
  embeddingCacheDirectory?: string;
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
  for (const name of ["GEMINI_TEXT_MODEL", "GEMINI_TEXT_FALLBACK_MODELS", "GEMINI_ANSWER_MODEL", "GEMINI_QUESTION_MODEL", "GROQ_MODEL"]) settings[name] = env[name];
  const keys = KEY_NAMES.map(name => settings[name] ?? "");
  const print = (line: string) => (dependencies.output ?? console.log)(redact(line, keys));
  // Outer safety timeout per call; each model step also has its own, shorter limit.
  const budget = guardedTransport(dependencies.transport ?? ((input, init) => fetch(input, init)), maxCalls, keys, 30000, sleep);
  let db: PGlite | undefined;
  try {
    if (redact(url.href, keys) !== url.href) throw new Error("Sensitive URL");
    if (Object.values(settings).some(value => value && !keys.includes(value) && redact(value, keys) !== value)) throw new Error("Sensitive model setting");
    // Two 30 s attempts plus backoff must fit inside the adapter and gateway deadlines.
    const providers = evaluationProviders(settings, budget.transport, 65000);
    const judge = dependencies.judge ?? providers.judge;
    assertIndependentJudge(providers.answer.family, judge);
    const embeddings = pacedEmbeddings(providers.embeddings, EMBEDDINGS_PER_MINUTE, sleep);
    db = dependencies.db ?? await openDatabase(resolve("data/instant-front-desk"));
    // Separate real vector space from businesses previously created with fake embeddings.
    const businessId = stableId(`${url.origin}|${providers.embeddings.model}`);
    const repo = businessRepository(db, businessId);
    if (!await repo.getBusiness()) await repo.createBusiness({ slug: `live-${businessId}`, name: url.hostname,
      sourceUrl: url.origin, phone: null, contactUrl: null, embeddingModel: providers.embeddings.model });
    const ingestionEmbeddings = cachedEmbeddings(embeddings,
      dependencies.embeddingCacheDirectory ?? outputPath("data/embedding-cache"));
    const snapshot = await ingest(url.href, repo, { adapter: ingestionEmbeddings, crawlOptions: {
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
    const textDeadline = 65000 * (1 + (settings.GEMINI_TEXT_FALLBACK_MODELS ?? "").split(",").filter(name => name.trim()).length);
    const gateway = new ModelGateway({ primary: { provider: "gemini", model: providers.answer.model,
      family: providers.answer.family, adapter: providers.answer }, retry: false, attemptTimeoutMs: textDeadline, totalTimeoutMs: textDeadline });
    const report = await runEvaluation(db, businessId, approved.version, { crawlRunId: crawlRun.id, judge, gateway,
      embeddings, answerModel: providers.answer.model, questionModel: providers.questions.generatedModel ?? undefined, stopReason: budget.stopReason, pause: () => sleep(pauseMs),
      sanitizeResult: entry => JSON.parse(redact(JSON.stringify(entry), keys)) });
    const score = scoreReport(report);
    await mkdir(outputPath("reports/private"), { recursive: true });
    await writeFile(outputPath("reports/private", `${report.id}.json`), redact(JSON.stringify({ ...report, score, callsUsed: budget.callsUsed(), callLogs: budget.callLogs(), limit: budget.limitDetail() }, null, 2), keys), { mode: 0o600 });
    print(`score: ${score.passed}/${score.total}`);
    for (const failure of score.failures) print(`failure: ${failure.question.question} — ${(failure.error ?? failure.verdict?.reason ?? "missing verdict").slice(0, 200)}`);
    print(`execution errors: ${report.results.filter(r => r.error).length}`);
    if (budget.stopReason()) { print(budget.stopReason() === "FREE_TIER_EXHAUSTED" ? describeLimit(budget.limitDetail()) : "request cap reached"); process.exitCode = 1; }
  } catch (error) {
    // Show only a fixed error code (e.g. TIMEOUT, MALFORMED), never a raw message that could hold data.
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
      : error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "UNKNOWN";
    print(budget.stopReason() === "FREE_TIER_EXHAUSTED" ? describeLimit(budget.limitDetail()) : budget.stopReason() === "REQUEST_CAP_REACHED" ? "request cap reached" : `Live execution failed (${/^[A-Z_]{3,40}$/.test(code) ? code : "UNKNOWN"}); no successful evaluation completed.`);
    // Local debugging only: the message is printed with both keys redacted, never saved to a report.
    if (env.LIVE_DEBUG === "yes" && error instanceof Error) print(`debug: ${error.name}: ${error.message.slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    for (const log of budget.callLogs()) print(`${log.service} call #${log.call} ${log.kind} model ${log.model}: ${log.status}`);
    print(`calls used: ${budget.callsUsed()}`);
    if (budget.lastFailure()) print(`last failed call: ${budget.lastFailure()}`);
    if (db && !dependencies.db) await db.close();
  }
}
