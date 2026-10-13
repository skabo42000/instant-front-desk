import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { answer, ANSWER_PROMPT_VERSION, type AnswerResult, type RetrievedChunk } from "../answer";
import { businessRepository } from "../db/repository";
import { retrieve } from "../retrieve";
import { assertIndependentJudge, ModelGateway, type JudgeConfig } from "../models/gateway";
import type { EmbeddingAdapter } from "../models/embeddings";
import { questionRepository, type Question } from "./questions";
import { outputPath } from "../output-path";

export const JUDGE_PROMPT_VERSION = "grounding-judge-v4";
export interface Verdict { pass: boolean; reason: string }
export interface Judge extends JudgeConfig {
  judge(question: Question, result: AnswerResult, evidence: readonly RetrievedChunk[]): Promise<Verdict>;
}
export class FakeJudge implements Judge {
  readonly provider = "fake";
  readonly model = "scripted-judge-v1";
  readonly family = "fake-judge";
  private index = 0;
  constructor(private readonly verdicts: readonly (Verdict | Error)[]) {}
  async judge(): Promise<Verdict> {
    const verdict = this.verdicts[this.index++];
    if (!verdict || verdict instanceof Error) throw new Error("Judge execution failed");
    return structuredClone(verdict);
  }
}
export interface EvalResult {
  question: Question;
  questionModel?: string | null;
  answerModel?: string | null;
  answer: AnswerResult | null;
  verdict: Verdict | null;
  error: string | null;
}
export interface EvalReport {
  id: string; businessId: string; questionVersion: number; crawlRunId: string; createdAt: string;
  answerModel: string; judgeModel: string; judgeFamily: string;
  answerPromptVersion: string; judgePromptVersion: string;
  results: EvalResult[];
}
export function scoreReport(report: EvalReport) {
  const failures = report.results.filter(r => r.error !== null || r.verdict?.pass !== true);
  return { passed: report.results.length - failures.length, total: report.results.length, failures };
}
export async function runEvaluation(db: PGlite, businessId: string, version: number, options: {
  crawlRunId: string; judge: Judge; gateway?: ModelGateway; embeddings?: EmbeddingAdapter;
  answerModel?: string;
  questionModel?: string;
  stopReason?: () => string | null;
  // Called before every question except the first (live runs wait a few seconds here).
  pause?: () => Promise<void>;
  sanitizeResult?: (result: EvalResult) => EvalResult;
  // Injection retains the answer engine boundary while allowing fixed offline fixtures.
  answerQuestion?: (question: string, chunks: readonly RetrievedChunk[]) => Promise<AnswerResult>;
}): Promise<EvalReport> {
  const list = await questionRepository(db, businessId).forRun(version);
  const repo = businessRepository(db, businessId);
  if (!await repo.getCrawlRun(options.crawlRunId)) throw new Error("Crawl run not found for business");
  const report: EvalReport = { id: randomUUID(), businessId, questionVersion: version,
    crawlRunId: options.crawlRunId, createdAt: new Date().toISOString(),
    answerModel: options.answerModel ?? "fake/scripted", judgeModel: options.judge.model,
    judgeFamily: options.judge.family, answerPromptVersion: ANSWER_PROMPT_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION, results: [] };
  await db.query(`INSERT INTO eval_runs (business_id,id,question_version,crawl_run_id,answer_model,judge_model,prompt_version,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'running')`, [businessId,report.id,version,options.crawlRunId,
    report.answerModel,report.judgeModel,report.answerPromptVersion]);
  let stopped = false;
  for (const [index, question] of list.questions.entries()) {
    let entry: EvalResult = { question, answer: null, verdict: null, error: null };
    if (index > 0 && options.pause && !stopped && !options.stopReason?.()) await options.pause();
    if (options.stopReason?.()) entry.error = options.stopReason()!;
    else if (stopped) entry.error = "FREE_TIER_STOPPED";
    else try {
      const retrieved = await retrieve(question.question, repo, { adapter: options.embeddings });
      const evidence = retrieved.chunks;
      entry.answer = await (options.answerQuestion ?? ((q, chunks) => answer(q, chunks, options.gateway, retrieved.contactChunks)))(question.question, evidence);
      const logs = entry.answer.logs;
      if (options.stopReason?.()) entry.error = options.stopReason()!;
      else if (logs.some(log => log.errorCode === "FREE_TIER_EXHAUSTED")) {
        stopped = true;
        entry.error = "FREE_TIER_EXHAUSTED";
      } else if (logs.length && logs.at(-1)?.status !== "success") entry.error = "ANSWER_EXECUTION_ERROR";
      else {
        if (logs.length && !entry.answer.answerFamily) throw new Error("Missing answer family");
        if (entry.answer.answerFamily) assertIndependentJudge(entry.answer.answerFamily, options.judge);
        // The judge also sees the sections the question was written from, so a "not found" reply
        // cannot pass just because search missed the right section.
        const reference = (await Promise.all(question.evidenceChunkIds.map(id => repo.getChunk(id))))
          .filter(chunk => chunk !== null && !evidence.some(found => found.id === chunk.id))
          .map(chunk => ({ id: chunk!.id, pageUrl: chunk!.pageUrl, heading: chunk!.heading, text: chunk!.text }));
        const judgeEvidence = [...new Map([...evidence, ...reference, ...retrieved.contactChunks]
          .map(chunk => [chunk.id, chunk])).values()];
        const verdict = await options.judge.judge(question, entry.answer, judgeEvidence);
        if (typeof verdict.pass !== "boolean" || typeof verdict.reason !== "string" || !verdict.reason.trim() || verdict.reason.length > 4000) {
          throw new Error("Malformed judge reply");
        }
        entry.verdict = verdict;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "FreeTierExhausted") {
        stopped = true; entry.error = "FREE_TIER_EXHAUSTED";
      // The live guard may have stopped mid-question (e.g. the judge hit a limit); name that, not a generic error.
      } else entry.error = options.stopReason?.() ?? "EVALUATION_EXECUTION_ERROR";
      // Never store raw exceptions; provider messages may contain credentials.
    }
    entry.questionModel = question.kind === "source" ? options.questionModel ?? null : null;
    entry.answerModel = entry.answer?.logs.filter(log => log.status === "success").at(-1)?.model ?? null;
    if (options.sanitizeResult) entry = options.sanitizeResult(entry);
    report.results.push(entry);
    await db.transaction(async tx => {
      const resultId = randomUUID();
      await tx.query(`INSERT INTO eval_results (business_id,id,eval_run_id,question_id,answer,judge_verdict,judge_reason,error_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [businessId,resultId,report.id,question.id,entry.answer?.text ?? "",
        entry.verdict ? (entry.verdict.pass ? "pass" : "fail") : null,entry.verdict?.reason ?? null,entry.error]);
      for (const citation of entry.answer?.citations ?? []) await tx.query(`INSERT INTO result_citations
        (business_id,id,result_id,chunk_id) VALUES ($1,$2,$3,$4)`, [businessId,randomUUID(),resultId,citation.id]);
    });
  }
  const usedModels = [...new Set(report.results.flatMap(r => r.answer?.logs.filter(log => log.status === "success")
    .map(log => `${log.provider}/${log.model}`) ?? []))];
  report.answerModel = usedModels.length ? usedModels.join(", ") : options.answerModel ?? "none (deterministic policy or execution error)";
  await db.query(`UPDATE eval_runs SET status=$3,report=$4::jsonb,answer_model=$5 WHERE business_id=$1 AND id=$2`,
    [businessId,report.id,report.results.some(r => r.error) ? "completed_with_errors" : "completed",JSON.stringify(report),report.answerModel]);
  await exportReport(report);
  return report;
}
export async function exportReport(report: EvalReport): Promise<string> {
  const directory = outputPath("data/eval-reports");
  await mkdir(directory, { recursive: true });
  const filename = resolve(directory, `${report.id}.json`);
  await writeFile(filename, JSON.stringify({ ...report, score: scoreReport(report) }, null, 2), { mode: 0o600 });
  return filename;
}
export async function latestReport(db: PGlite, businessId: string): Promise<EvalReport | null> {
  return (await db.query<{ report: EvalReport }>(`SELECT report FROM eval_runs WHERE business_id=$1
    AND report IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1`, [businessId])).rows[0]?.report ?? null;
}
