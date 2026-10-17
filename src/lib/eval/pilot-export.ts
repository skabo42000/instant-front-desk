import "server-only";
import { benchmarkHash, reviewProvenance, validateBenchmark, type Benchmark } from "./benchmark";

// Produce a reviewable import, never connect to or mutate an external database.
export function pilotSnapshotSql(b: Benchmark, draft = false): string {
  validateBenchmark(b, !draft);
  const literal = (value: string | number | null): string => {
    if (value === null) return "NULL";
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Invalid number"); return String(value); }
    if (value.includes("\0")) throw new Error("Invalid SQL text");
    return `'${value.replace(/'/g,"''")}'`;
  };
  const insert = (table: string, columns: string, values: (string | number | null)[]) => `INSERT INTO ${table} (${columns}) VALUES (${values.map(literal).join(",")});`;
  const business = b.snapshot.business;
  const statements = [`-- Owned-site snapshot. Benchmark SHA-256: ${benchmarkHash(b)}`, "BEGIN;"];
  if (draft || !reviewProvenance(b).humanReviewed) statements.push("DO $$ BEGIN RAISE EXCEPTION 'DRAFT_REQUIRES_HUMAN_REVIEW'; END $$;");
  statements.push(insert("businesses", "business_id,id,slug,name,source_url,contact_url,phone,embedding_model,embedding_dimensions",
    [business.businessId,business.businessId,business.slug,business.name,business.sourceUrl,business.contactUrl,business.phone,business.embeddingModel,business.embeddingDimensions]));
  for (const id of new Set(b.snapshot.pages.map(p=>p.crawlRunId))) statements.push(insert("crawl_runs","business_id,id,status",[business.businessId,id,"completed"]));
  for (const p of b.snapshot.pages) statements.push(insert("pages","business_id,id,crawl_run_id,url,title,clean_text,content_hash",[business.businessId,p.id,p.crawlRunId,p.url,p.title,p.cleanText,p.contentHash]));
  for (const c of b.snapshot.chunks) statements.push(insert("chunks","business_id,id,page_id,ordinal,heading,text,embedding,embedding_model,content_hash,embedding_dimensions",
    [business.businessId,c.id,c.pageId,c.ordinal,c.heading,c.text,`[${c.embedding.join(",")}]`,c.embeddingModel,c.contentHash,business.embeddingDimensions]));
  return statements.concat("COMMIT;", "").join("\n");
}
