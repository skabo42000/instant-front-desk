import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase, localDatabasePath } from "../src/lib/db/client";
import { businessRepository } from "../src/lib/db/repository";
import { benchmarkHash, exportBenchmark, fingerprint, importReview, loadSnapshot, reviewProvenance, validateBenchmark, type Benchmark } from "../src/lib/eval/benchmark";
import { reviewPage } from "../src/lib/eval/review-page";
import { bm25Rerank, retrievalMetrics } from "../src/lib/eval/retrieval-metrics";
import { answer, prepareAnswerEvidence, ANSWER_PROMPT_VERSION } from "../src/lib/answer";
import { retrieve, RETRIEVAL_VERSION } from "../src/lib/retrieve";
import { GeminiEmbeddings } from "../src/lib/models/providers";
import { FakeEmbeddings } from "../src/lib/models/embeddings";
import { evalKeysFromFile, guardedTransport } from "./live";
import { evaluationProviders } from "../src/lib/models/providers";
import { ModelGateway } from "../src/lib/models/gateway";
import { compareBenchmarkReports, evaluateBenchmark, GroqQualityJudge, QUALITY_JUDGE_VERSION, scoreBenchmarkReport, type BenchmarkReport } from "../src/lib/eval/benchmark-runner";
import { pilotSnapshotSql } from "../src/lib/eval/pilot-export";
import { applyAiReview, type AiReviewNotes } from "../src/lib/eval/ai-review";
import { acceptedInputs } from "../src/lib/eval/accepted-inputs";

async function json<T>(filename: string): Promise<T> { return JSON.parse(await readFile(filename, "utf8")) as T; }
async function save(filename: string, value: unknown) {
  await mkdir(dirname(resolve(filename)), { recursive: true });
  await writeFile(filename, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
}
async function requireNewOutput(filename: string) {
  try { await access(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Choose a fresh output filename before making any provider calls");
}
interface QueryCache { schema: 1; snapshotHash: string; model: string; queries: Record<string, number[]> }
interface RetrievalCaseResult {
  id: string; question: string; kind: string; gold: string[]; hybridMs: number; rerankMs: number;
  hybridPool: ReturnType<typeof retrievalMetrics>; hybridAt8: ReturnType<typeof retrievalMetrics>;
  bm25At8: ReturnType<typeof retrievalMetrics>; effectiveEvidence: ReturnType<typeof retrievalMetrics>;
  hybridIds: string[]; rerankedIds: string[];
}
export async function main(args: string[]): Promise<void> {
  const [command, file, ...rest] = args;
  if (command === "export") {
    if (!file || !rest[0] || !rest[1]) throw new Error("export BUSINESS_ID VERSION DIRECTORY");
    const db = await openDatabase(localDatabasePath());
    try {
      const b = await exportBenchmark(db, file, Number(rest[0]));
      const directory = resolve(rest[1]);
      await save(resolve(directory, "draft.json"), b);
      await writeFile(resolve(directory, "review.html"), reviewPage([b]), { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ draft: resolve(directory, "draft.json"), review: resolve(directory, "review.html"), cases: b.cases.length, snapshotHash: b.snapshotHash, humanReviewed: false }));
    } finally { await db.close(); }
  } else if (command === "review-page") {
    if (!file || !rest.length) throw new Error("review-page OUTPUT_HTML DRAFT...");
    const bundles = await Promise.all(rest.map(path => json<Benchmark>(path)));
    bundles.forEach(b => validateBenchmark(b, false));
    await writeFile(file, reviewPage(bundles), { mode: 0o600, flag: "wx" });
    console.log(`Review page: ${resolve(file)}`);
  } else if (command === "import-review") {
    if (!file || !rest[0] || !rest[1]) throw new Error("import-review DRAFT REVIEWED OUTPUT");
    const b = importReview(await json<Benchmark>(file), await json<Benchmark>(rest[0]));
    await save(rest[1], b);
    console.log(JSON.stringify({ benchmarkHash: benchmarkHash(b), ...reviewProvenance(b), included: b.cases.filter(q => q.decision === "include").length, excluded: b.cases.filter(q => q.decision === "exclude").map(q => ({ id: q.id, reason: q.exclusionReason })) }));
  } else if (command === "apply-ai-review") {
    if (!file || !rest[0] || !rest[1]) throw new Error("apply-ai-review DRAFT NOTES OUTPUT");
    const b = applyAiReview(await json<Benchmark>(file), await json<AiReviewNotes>(rest[0]));
    await save(rest[1],b);
    console.log(JSON.stringify({ file:resolve(rest[1]),benchmarkHash:benchmarkHash(b),...reviewProvenance(b),cases:b.cases.length }));
  } else if (command === "prepare-accepted") {
    if (!file || !rest[0] || !rest[1] || !rest[2]) throw new Error("prepare-accepted AI_BUNDLE PRIOR_QUERIES OUTPUT_BUNDLE OUTPUT_QUERIES");
    await requireNewOutput(rest[1]);
    await requireNewOutput(rest[2]);
    const prepared = acceptedInputs(await json<Benchmark>(file), await json<QueryCache>(rest[0]));
    // Never publish an incomplete cache as ready for a zero-embedding answer run.
    if (prepared.needsEmbedding.length) {
      console.log(JSON.stringify({ needsEmbedding: prepared.needsEmbedding }));
      throw new Error("Changed or missing query vectors require a separately authorized embedding run");
    }
    await save(rest[1], prepared.bundle);
    await save(rest[2], prepared.cache);
    console.log(JSON.stringify({ benchmarkHash: benchmarkHash(prepared.bundle), ...reviewProvenance(prepared.bundle),
      cases: prepared.bundle.cases.length, cached: Object.keys(prepared.cache.queries).length, needsEmbedding: [] }));
  } else if (command === "plan-answer") {
    if (!file || !rest[0] || !rest[1]) throw new Error("plan-answer AI_BUNDLE QUERY_CACHE OUTPUT");
    await requireNewOutput(rest[1]);
    const b = await json<Benchmark>(file);
    const cache = await json<QueryCache>(rest[0]);
    const prepared = acceptedInputs(b, cache);
    if (prepared.needsEmbedding.length) throw new Error("Plan requires every query cached");
    const db = await openDatabase();
    try {
      await loadSnapshot(db, b);
      const repo = businessRepository(db, b.snapshot.business.businessId);
      const embeddings = { model: cache.model, dimensions: 768, async embed(text: string) { return cache.queries[fingerprint(text)]; } };
      const cases = [];
      for (const q of b.cases.filter(q => q.decision === "include")) {
        const found = await retrieve(q.question, repo, { adapter: embeddings });
        let calls = 0;
        // Empty synthetic replies exercise the actual pre-model refusal path, not answer quality.
        const gateway = new ModelGateway({ retry: false, primary: { provider: "fake", model: "offline-plan", family: "fake",
          adapter: { async generate() { calls++; return { text: "", citedChunkIds: [] }; } } } });
        const result = await answer(q.question, found.chunks, gateway, found.contactChunks);
        cases.push({ id: q.id, kind: q.kind, question: q.question, answerCalls: calls,
          deterministicRefusal: calls ? null : result.refusalReason });
      }
      const answerCalls = cases.reduce((sum, q) => sum + q.answerCalls, 0);
      const judgeCalls = cases.length;
      const plan = { schema: 1, offline: true, qualityMeasured: false, benchmarkHash: benchmarkHash(b), snapshotHash: b.snapshotHash,
        queryCacheHash: fingerprint(cache), ...reviewProvenance(b), answerPromptVersion: ANSWER_PROMPT_VERSION,
        judgePromptVersion: QUALITY_JUDGE_VERSION, embeddingModel: cache.model, needsEmbedding: [],
        expectedCalls: { answers: answerCalls, judges: judgeCalls, embeddings: 0, total: answerCalls + judgeCalls },
        // Two primary gateway routes, then Groq fallback. Fallback cannot receive a same-family judge.
        worstCase: { withoutRateWaits: 4 * answerCalls + 2 * judgeCalls,
          withRateWaits: 10 * answerCalls + 5 * judgeCalls, enforcedPerProcessCap: 100 }, cases };
      await save(rest[1], plan);
      console.log(JSON.stringify({ report: resolve(rest[1]), ...plan.expectedCalls, worstCase: plan.worstCase, ...reviewProvenance(b) }));
    } finally { await db.close(); }
  } else if (command === "cache-queries") {
    if (!file || !rest[0] || process.env.LIVE_OK !== "yes" || process.env.FREE_TIER_CONFIRMED !== "yes") throw new Error("Free-only authorization required");
    await requireNewOutput(rest[0]);
    const b = await json<Benchmark>(file); validateBenchmark(b, false);
    const keys = evalKeysFromFile(await readFile(".env.local", "utf8"));
    const key = process.env.GEMINI_EVAL_API_KEY || keys.GEMINI_EVAL_API_KEY;
    if (!key) throw new Error("Isolated evaluation key required");
    const cache: QueryCache = { schema: 1, snapshotHash: b.snapshotHash, model: b.snapshot.business.embeddingModel, queries: {} };
    if (rest[1]) {
      const prior = await json<QueryCache>(rest[1]);
      if (prior.model !== cache.model || prior.snapshotHash !== cache.snapshotHash) throw new Error("Prior query cache mismatch");
      for (const q of b.cases) {
        const vector = prior.queries[fingerprint(q.question)];
        if (vector?.length === 768 && vector.every(Number.isFinite)) cache.queries[fingerprint(q.question)] = vector;
      }
    }
    const adapter = new GeminiEmbeddings(key, guardedTransport(fetch, 100, [key], 15000).transport, cache.model, 16000);
    // Checkpoints remain useful after a free-tier stop. They do not change the benchmark.
    try {
      for (const q of b.cases) {
        if (cache.queries[fingerprint(q.question)]) continue;
        cache.queries[fingerprint(q.question)] = [...await adapter.embed(q.question)];
        await new Promise(r => setTimeout(r, 850));
      }
    } finally { await save(rest[0], cache); }
    console.log(JSON.stringify({ cached: Object.keys(cache.queries).length, model: cache.model }));
  } else if (command === "retrieval") {
    if (!file || !rest[0] || !rest[1]) throw new Error("retrieval BENCHMARK QUERY_CACHE OUTPUT [--draft]");
    const b = await json<Benchmark>(file); const draft = rest.includes("--draft"); validateBenchmark(b, !draft);
    const cache = await json<QueryCache>(rest[0]);
    if (cache.schema !== 1 || cache.snapshotHash !== b.snapshotHash || cache.model !== b.snapshot.business.embeddingModel) throw new Error("Query cache mismatch");
    const db = await openDatabase();
    try {
      await loadSnapshot(db, b);
      const adapter = { model: cache.model, dimensions: 768, async embed(text: string) {
        const vector = cache.queries[fingerprint(text)];
        if (!vector || vector.length !== 768 || !vector.every(Number.isFinite)) throw new Error("Query missing from cache");
        return vector;
      } };
      const results: RetrievalCaseResult[] = [];
      for (const q of b.cases.filter(q => draft || q.decision === "include")) {
        const started = performance.now();
        const retrieved = await retrieve(q.question, businessRepository(db, b.snapshot.business.businessId), { adapter });
        const hybridMs = performance.now() - started;
        const rerankStart = performance.now(); const reranked = bm25Rerank(q.question, retrieved.chunks); const rerankMs = performance.now() - rerankStart;
        results.push({ id: q.id, question: q.question, kind: q.kind, gold: q.evidenceChunkIds, hybridMs, rerankMs,
          hybridPool: retrievalMetrics(q.evidenceChunkIds, retrieved.chunks, q.evidenceGroups),
          hybridAt8: retrievalMetrics(q.evidenceChunkIds, retrieved.chunks.slice(0, 8), q.evidenceGroups),
          bm25At8: retrievalMetrics(q.evidenceChunkIds, reranked.slice(0, 8), q.evidenceGroups),
          effectiveEvidence: retrievalMetrics(q.evidenceChunkIds, prepareAnswerEvidence(q.question, retrieved.chunks), q.evidenceGroups),
          hybridIds: retrieved.chunks.map(c => c.id), rerankedIds: reranked.map(c => c.id) });
      }
      const labelled = results.filter(r => r.gold.length);
      const average = (get: (r: typeof results[number]) => number) => labelled.length ? labelled.reduce((n, r) => n + get(r), 0) / labelled.length : null;
      const percentile = (values: number[], p: number) => [...values].sort((a,c) => a-c)[Math.max(0, Math.ceil(values.length*p)-1)] ?? null;
      const report = { schema: 1, createdAt: new Date().toISOString(), benchmarkHash: benchmarkHash(b), snapshotHash: b.snapshotHash,
        queryCacheHash: fingerprint(cache), ...reviewProvenance(b), provisional: draft || reviewProvenance(b).provisional, answerPromptVersion: ANSWER_PROMPT_VERSION,
        relevanceDefinition: b.cases.some(q=>q.evidenceGroups!==undefined)?"fact-evidence-groups":"reference-id",
        retrievalVersion: RETRIEVAL_VERSION, rerankerVersion: "bm25-candidate-v1", sourceBudget: 8,
        implementationHash: fingerprint(await Promise.all(["src/lib/retrieve.ts", "src/lib/question-intents.ts", "src/lib/answer.ts", "src/lib/eval/retrieval-metrics.ts"].map(path=>readFile(path,"utf8")))),
        promotionRule: "Human-reviewed benchmark; >=5 percentage-point complete-evidence gain at 8; no answer/safety regression; <=100ms added p95. Answer comparison is required separately.",
        summary: { total: results.length, retrievalEligible: labelled.length, excluded: b.cases.filter(q => q.decision === "exclude").map(q => ({ id: q.id, reason: q.exclusionReason })),
          hybridPoolRecall: average(r => r.hybridPool.poolRecall!), hybridRecallAt1: average(r => r.hybridPool.recallAt1!),
          hybridRecallAt5: average(r => r.hybridPool.recallAt5!), hybridRecallAt8: average(r => r.hybridAt8.poolRecall!),
          hybridMRR: average(r => r.hybridPool.reciprocalRank!), hybridCompleteAt8: average(r => Number(r.hybridAt8.complete)),
          bm25RecallAt8: average(r => r.bm25At8.poolRecall!), bm25CompleteAt8: average(r => Number(r.bm25At8.complete)),
          effectivePoolRecall: average(r => r.effectiveEvidence.poolRecall!), hybridP95Ms: percentile(results.map(r => r.hybridMs), .95), rerankP95Ms: percentile(results.map(r => r.rerankMs), .95) }, results };
      await save(rest[1], report); console.log(JSON.stringify({ report: resolve(rest[1]), ...reviewProvenance(b), provisional:report.provisional, ...report.summary }));
    } finally { await db.close(); }
  } else if (command === "answer") {
    if (!file || !rest[0] || !rest[1] || process.env.LIVE_OK !== "yes" || process.env.FREE_TIER_CONFIRMED !== "yes") throw new Error("Free-only authorization required");
    await requireNewOutput(rest[1]);
    await requireNewOutput(`${rest[1]}.partial.json`);
    const b = await json<Benchmark>(file); const draft = rest.includes("--draft"); validateBenchmark(b, !draft);
    const cache = await json<QueryCache>(rest[0]);
    if (cache.schema !== 1 || cache.snapshotHash !== b.snapshotHash || cache.model !== b.snapshot.business.embeddingModel) throw new Error("Query cache mismatch");
    const keys = evalKeysFromFile(await readFile(".env.local", "utf8"));
    const env = { ...keys, ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined)) };
    const guard = guardedTransport(fetch, 100, [env.GEMINI_EVAL_API_KEY,env.GROQ_EVAL_API_KEY].filter((v): v is string => !!v), 20000);
    const providers = evaluationProviders(env, guard.transport, 21000);
    const db = await openDatabase();
    try {
      const report = await evaluateBenchmark(db, b, { draft, queryCacheHash: fingerprint(cache),
        variant: rest.includes("--bm25") ? "bm25" : "hybrid", sourceBudget: rest.includes("--top8") || rest.includes("--bm25") ? 8 : undefined,
        embeddings: { model: cache.model, dimensions: 768, async embed(text: string) {
          const vector = cache.queries[fingerprint(text)];
          if (!vector || vector.length !== 768 || !vector.every(Number.isFinite)) throw new Error("Query missing from cache"); return vector;
        } }, gateway: new ModelGateway({ primary: { provider: "gemini", model: providers.answer.model, family: providers.answer.family, adapter: providers.answer },
          fallback: { provider: "groq", model: providers.fallback.model, family: providers.fallback.family, adapter: providers.fallback }, attemptTimeoutMs: 22000, totalTimeoutMs: 65000 }),
        judge: new GroqQualityJudge(env.GROQ_EVAL_API_KEY ?? "", guard.transport, env.GROQ_MODEL, 21000),
        pause: () => new Promise(r => setTimeout(r, 3000)), stopReason: guard.stopReason,
        onProgress: async report => {
          await mkdir(dirname(resolve(rest[1])),{recursive:true});
          await writeFile(`${rest[1]}.partial.json`,JSON.stringify({...report,partial:true,providerAttempts:guard.callsUsed(),stopReason:guard.stopReason(),limitDetail:guard.limitDetail()},null,2),{mode:0o600});
          console.log(JSON.stringify({completed:report.results.length,total:b.cases.length,errors:report.results.filter(r=>r.error).length,providerAttempts:guard.callsUsed()}));
        } });
      const implementationHash = fingerprint(await Promise.all(["src/lib/retrieve.ts", "src/lib/question-intents.ts", "src/lib/answer.ts", "src/lib/eval/retrieval-metrics.ts"]
        .map(path => readFile(path,"utf8"))));
      await save(rest[1], { ...report, implementationHash, providerAttempts: guard.callsUsed(), summary: scoreBenchmarkReport(report),
        stopReason:guard.stopReason(),limitDetail:guard.limitDetail(),providerCallLogs:guard.callLogs() });
      await unlink(`${rest[1]}.partial.json`);
      console.log(JSON.stringify({ report: resolve(rest[1]), provisional: report.provisional, total: report.results.length,
        executionErrors: report.results.filter(r => r.error).length, providerAttempts: guard.callsUsed() }));
    } finally { await db.close(); }
  } else if (command === "compare") {
    if (!file || !rest[0] || !rest[1]) throw new Error("compare BEFORE AFTER OUTPUT");
    const result = compareBenchmarkReports(await json<BenchmarkReport>(file), await json<BenchmarkReport>(rest[0]));
    await save(rest[1], result); console.log(JSON.stringify(result));
  } else if (command === "pilot-export") {
    if (!file || !rest[0]) throw new Error("pilot-export BENCHMARK OUTPUT_SQL [--draft]");
    await writeFile(rest[0], pilotSnapshotSql(await json<Benchmark>(file), rest.includes("--draft")), {mode:0o600,flag:"wx"});
    console.log(JSON.stringify({file:resolve(rest[0]),draft:rest.includes("--draft"),applied:false}));
  } else if (command === "fake-cache") {
    if (!file || !rest[0]) throw new Error("fake-cache BENCHMARK OUTPUT");
    const b = await json<Benchmark>(file); validateBenchmark(b, false); const adapter = new FakeEmbeddings();
    if (b.snapshot.business.embeddingModel !== adapter.model) throw new Error("Fake embeddings cannot query real vectors");
    const queries: Record<string, number[]> = {};
    for (const q of b.cases) queries[fingerprint(q.question)] = await adapter.embed(q.question);
    await save(rest[0], { schema: 1, snapshotHash: b.snapshotHash, model: adapter.model, queries });
  } else throw new Error("Commands: export, review-page, import-review, apply-ai-review, prepare-accepted, plan-answer, cache-queries, retrieval, answer, compare, pilot-export, fake-cache");
}
