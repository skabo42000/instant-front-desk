import "server-only";
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { businessRepository, type StoredBusiness, type PageInput, type ChunkInput } from "../db/repository";
import { questionRepository, type Question } from "./questions";

// Content hashes identify an immutable test set, independently of database approval flags.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export interface Snapshot {
  business: StoredBusiness;
  pages: PageInput[];
  chunks: ChunkInput[];
}
export interface BenchmarkCase extends Question {
  requiredFacts: string[];
  // Each group supplies one required fact; any annotated alternative is sufficient.
  evidenceGroups?: string[][];
  reviewNotes?: string;
  decision: "pending" | "include" | "exclude";
  exclusionReason: string;
}
export interface Benchmark {
  schema: 1;
  createdAt: string;
  snapshotHash: string;
  draftHash: string;
  snapshot: Snapshot;
  cases: BenchmarkCase[];
  review: null | { method: "human" | "ai"; reviewer: string; reviewedAt: string; attestation: true; draftHash: string; notesHash?: string };
}
export function reviewProvenance(b: Benchmark) {
  const method = b.review?.method ?? null;
  return { reviewMethod: method, humanReviewed: method === "human", provisional: method !== "human" };
}
export const draftContent = (benchmark: Benchmark) => ({ snapshotHash: benchmark.snapshotHash,
  cases: benchmark.cases.map(({ requiredFacts: _facts, evidenceGroups: _groups, reviewNotes: _notes, decision: _decision, exclusionReason: _reason, ...q }) => q) });
export const benchmarkHash = (benchmark: Benchmark) => fingerprint({ snapshotHash: benchmark.snapshotHash,
  cases: benchmark.cases, review: benchmark.review });

export async function exportBenchmark(db: PGlite, businessId: string, version: number): Promise<Benchmark> {
  const business = await businessRepository(db, businessId).getBusiness();
  if (!business) throw new Error("Benchmark business missing");
  const list = await questionRepository(db, businessId).get(version);
  const pages = (await db.query<PageInput>(`SELECT id,crawl_run_id AS "crawlRunId",url,title,
    clean_text AS "cleanText",content_hash AS "contentHash" FROM pages WHERE business_id=$1 ORDER BY url,id`, [businessId])).rows;
  const chunks = (await db.query<ChunkInput & { vector: string }>(`SELECT id,page_id AS "pageId",ordinal,heading,text,
    embedding::text AS vector,embedding_model AS "embeddingModel",embedding_dimensions AS "embeddingDimensions",
    content_hash AS "contentHash" FROM chunks WHERE business_id=$1 ORDER BY page_id,ordinal,id`, [businessId])).rows
    .map(({ vector, ...row }) => ({ ...row, embedding: JSON.parse(vector) as number[] }));
  const snapshot = { business, pages, chunks };
  const benchmark: Benchmark = { schema: 1, createdAt: new Date().toISOString(), snapshot,
    snapshotHash: fingerprint(snapshot), draftHash: "", review: null,
    cases: list.questions.map(q => ({ ...q, requiredFacts: [], decision: "pending", exclusionReason: "" })) };
  benchmark.draftHash = fingerprint(draftContent(benchmark));
  validateBenchmark(benchmark, false);
  return benchmark;
}

export function validateBenchmark(b: Benchmark, requireReview = true): void {
  if (b.schema !== 1 || fingerprint(b.snapshot) !== b.snapshotHash || !/^[a-f0-9]{64}$/.test(b.draftHash)) throw new Error("Snapshot integrity failed");
  const { business, pages, chunks } = b.snapshot;
  businessRepository({} as PGlite, business.businessId);
  const pageIds = new Set(pages.map(p => p.id));
  const chunkIds = new Set(chunks.map(c => c.id));
  if (!pages.length || pages.length > 15 || !chunks.length || chunks.length > 500 || pageIds.size !== pages.length || chunkIds.size !== chunks.length) throw new Error("Invalid snapshot size or duplicate IDs");
  const origin = new URL(business.sourceUrl).origin;
  if (pages.some(p => new URL(p.url).origin !== origin || !/^https?:$/.test(new URL(p.url).protocol))) throw new Error("Foreign source origin");
  if (business.embeddingDimensions !== 768 || chunks.some(c => !pageIds.has(c.pageId) || c.embeddingModel !== business.embeddingModel ||
    c.embedding.length !== 768 || !c.embedding.every(Number.isFinite))) throw new Error("Invalid snapshot embedding space");
  if (!b.cases.length || b.cases.length > 100 || new Set(b.cases.map(q => q.id)).size !== b.cases.length) throw new Error("Invalid case IDs/count");
  for (const q of b.cases) {
    if (!q.question.trim() || q.question.length > 2000 || !q.expectedBehavior.trim() || q.expectedBehavior.length > 4000 || q.validationErrors.length ||
      q.evidenceChunkIds.some(id => !chunkIds.has(id)) || new Set(q.evidenceChunkIds).size !== q.evidenceChunkIds.length ||
      !Array.isArray(q.requiredFacts) || q.requiredFacts.some(f => typeof f !== "string" || !f.trim() || f.length > 1000) ||
      !["pending", "include", "exclude"].includes(q.decision)) throw new Error("Invalid question or foreign evidence");
    if (q.evidenceGroups !== undefined && (!Array.isArray(q.evidenceGroups) ||
      q.evidenceGroups.some(group => !Array.isArray(group) || !group.length || new Set(group).size !== group.length || group.some(id => !q.evidenceChunkIds.includes(id))) ||
      (q.kind === "source" && q.evidenceGroups.length !== q.requiredFacts.length) ||
      (q.kind !== "source" && q.evidenceGroups.length > 0))) throw new Error("Invalid fact evidence groups");
    if (requireReview && (q.decision === "pending" || (q.decision === "exclude" && !q.exclusionReason.trim()) ||
      (q.decision === "include" && q.kind === "source" && (!q.requiredFacts.length || !q.evidenceChunkIds.length)))) throw new Error("Every case needs explicit review, source cases need required facts and evidence");
  }
  if (requireReview && (!b.cases.some(q => q.decision === "include" && q.kind === "source") || !b.review || b.review.attestation !== true ||
    !["human", "ai"].includes(b.review.method) || b.review.draftHash !== b.draftHash || !b.review.reviewer.trim() ||
    !Number.isFinite(Date.parse(b.review.reviewedAt)))) throw new Error("Explicit human or AI review provenance required");
}

// An import can edit labels and questions, but cannot silently swap source snapshots or case IDs.
export function importReview(draft: Benchmark, reviewed: Benchmark): Benchmark {
  validateBenchmark(draft, false);
  validateBenchmark(reviewed);
  if (fingerprint(draftContent(draft)) !== draft.draftHash || reviewed.draftHash !== draft.draftHash ||
    reviewed.snapshotHash !== draft.snapshotHash || canonical(reviewed.cases.map(q => [q.id, q.kind])) !== canonical(draft.cases.map(q => [q.id, q.kind]))) {
    throw new Error("Review does not match this draft");
  }
  return reviewed;
}

export async function loadSnapshot(db: PGlite, b: Benchmark): Promise<void> {
  validateBenchmark(b, false);
  const repo = businessRepository(db, b.snapshot.business.businessId);
  await repo.createBusiness(b.snapshot.business);
  for (const id of new Set(b.snapshot.pages.map(p => p.crawlRunId))) await repo.createCrawlRun(id, "completed");
  for (const page of b.snapshot.pages) await repo.createPage(page);
  for (const chunk of b.snapshot.chunks) await repo.createChunk(chunk);
}
