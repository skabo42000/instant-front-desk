import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { validateBenchmark, loadSnapshot, type Benchmark } from "../src/lib/eval/benchmark";
import { adminClient, databaseRunning } from "./live-db";
import { saveLocalSettings } from "./live-settings";
import type { SqlClient } from "./shared-local";

export const DEFAULT_SNAPSHOTS = ["synq", "salon"].map(site => join("data/benchmarks/2026-10-15", site, "ai-reviewed.json"));
export function validateOwnedSnapshots(bundles: Benchmark[]) {
  if (bundles.length !== 2) throw Error("Exactly two owned-site snapshots required");
  const origins = new Set<string>();
  for (const bundle of bundles) {
    validateBenchmark(bundle);
    const business = bundle.snapshot.business;
    const url = new URL(business.sourceUrl);
    const host = url.hostname.replace(/^www\./, "");
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !["synqlogic.com", "europeanbeautylounge.com"].includes(host) || origins.has(host) ||
      business.embeddingModel !== "gemini-embedding-001") throw Error("Only the two owned real-embedding corpora can be imported");
    origins.add(host);
  }
  if (new Set(bundles.map(b => b.snapshot.business.businessId)).size !== 2) throw Error("Duplicate business IDs");
}

export async function importSnapshots(client: SqlClient, bundles: Benchmark[]) {
  validateOwnedSnapshots(bundles);
  const counts: Record<string, unknown>[] = [];
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE IF NOT EXISTS ifd_imports(business_id uuid PRIMARY KEY REFERENCES businesses(business_id),snapshot_hash text NOT NULL)");
    for (const bundle of bundles) {
      const id = bundle.snapshot.business.businessId;
      const old = (await client.query("SELECT snapshot_hash FROM ifd_imports WHERE business_id=$1", [id])).rows[0];
      if (old && old.snapshot_hash !== bundle.snapshotHash) throw Error("Imported snapshot differs; never overwrite a live corpus");
      if (!old) {
        await loadSnapshot(client as unknown as PGlite, bundle);
        await client.query("INSERT INTO ifd_imports VALUES ($1,$2)", [id, bundle.snapshotHash]);
      }
      const count = (await client.query(`SELECT
        (SELECT count(*)::int FROM pages WHERE business_id=$1) AS pages,
        (SELECT count(*)::int FROM chunks WHERE business_id=$1) AS chunks,
        (SELECT count(*)::int FROM chunks WHERE business_id=$1 AND vector_dims(embedding)=768 AND embedding_model='gemini-embedding-001') AS embeddings`, [id])).rows[0];
      if (count.pages !== bundle.snapshot.pages.length || count.chunks !== bundle.snapshot.chunks.length || count.embeddings !== count.chunks) throw Error("Import count mismatch");
      counts.push({ businessId: id, ...count, snapshotHash: bundle.snapshotHash, alreadyImported: !!old, review: bundle.review?.method });
    }
    if (Number((await client.query("SELECT count(*) AS count FROM businesses")).rows[0].count) !== 2) throw Error("Live database must contain only the two owned businesses");
    await client.query("COMMIT");
  } catch { await client.query("ROLLBACK"); throw Error("Owned-site import failed; no partial corpus committed"); }
  return counts;
}

export async function importOwnedBusinesses(args: string[]) {
  const files = args.length === 0 ? DEFAULT_SNAPSHOTS : args[0] === "--snapshots" && args.length === 3 ? args.slice(1) : [];
  if (files.length !== 2) throw Error("Usage: npm run live-db -- import [--snapshots SYNQ_JSON SALON_JSON]");
  const bundles: Benchmark[] = await Promise.all(files.map(async file => JSON.parse(await readFile(file, "utf8"))));
  validateOwnedSnapshots(bundles);
  if (!await databaseRunning()) throw Error("Start the live database before importing");
  const db = await adminClient();
  let counts: Record<string, unknown>[];
  try { counts = await importSnapshots(db.client, bundles); }
  finally { await db.close(); }
  // These are source IDs, never a statement of human calibration or release acceptance.
  await saveLocalSettings({ PILOT_BUSINESS_IDS: bundles.map(b => b.snapshot.business.businessId).join(",") });
  console.log(JSON.stringify({ imported: counts, providerCalls: 0, releaseAccepted: false }));
}
