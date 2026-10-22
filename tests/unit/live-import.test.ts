import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../src/lib/db/client";
import { draftContent, fingerprint, type Benchmark } from "../../src/lib/eval/benchmark";
import { importSnapshots, validateOwnedSnapshots } from "../../scripts/live-import";

function fixture(host: string): Benchmark {
  const businessId = randomUUID(), pageId = randomUUID(), chunkId = randomUUID();
  const bundle: Benchmark = {
    schema: 1, createdAt: "2026-10-18T00:00:00Z", snapshotHash: "", draftHash: "",
    snapshot: {
      business: { businessId, slug: host.split(".")[0], name: "Synthetic owned-origin fixture", sourceUrl: `https://${host}/`,
        contactUrl: null, phone: null, embeddingModel: "gemini-embedding-001", embeddingDimensions: 768 },
      pages: [{ id: pageId, crawlRunId: randomUUID(), url: `https://${host}/`, title: "Fixture", cleanText: "Fixture hours are nine to five.", contentHash: "fixture" }],
      chunks: [{ id: chunkId, pageId, ordinal: 0, heading: "Hours", text: "Fixture hours are nine to five.", embedding: Array(768).fill(0.01), embeddingModel: "gemini-embedding-001", contentHash: "fixture" }],
    },
    cases: [{ id: randomUUID(), kind: "source", question: "What are the fixture hours?", expectedBehavior: "State fixture hours", evidenceChunkIds: [chunkId],
      validationErrors: [], requiredFacts: ["nine to five"], decision: "include", exclusionReason: "" }],
    review: null,
  };
  bundle.snapshotHash = fingerprint(bundle.snapshot);
  bundle.draftHash = fingerprint(draftContent(bundle));
  bundle.review = { method: "ai", reviewer: "Synthetic fixture only", reviewedAt: bundle.createdAt, attestation: true, draftHash: bundle.draftHash };
  return bundle;
}

let db: PGlite;
beforeAll(async () => { db = await openDatabase(); }, 30000);
afterAll(async () => { await db?.close(); });
const bundles = [fixture("synqlogic.com"), fixture("europeanbeautylounge.com")];

it("requires both exact owned origins, intact reviewed snapshots and the matching vector space", () => {
  expect(() => validateOwnedSnapshots(bundles)).not.toThrow();
  for (const bad of [[bundles[0]], [bundles[0], bundles[0]], [fixture("attacker.test"), bundles[1]]])
    expect(() => validateOwnedSnapshots(bad)).toThrow();
  const corrupt = structuredClone(bundles); corrupt[0].snapshot.chunks[0].text = "changed";
  expect(() => validateOwnedSnapshots(corrupt)).toThrow("integrity");
  const unreviewed = structuredClone(bundles); unreviewed[0].review = null;
  expect(() => validateOwnedSnapshots(unreviewed)).toThrow("review");
});

it("rolls back both businesses if the second insert fails", async () => {
  const broken = { query: async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("INSERT INTO businesses") && values?.[0] === bundles[1].snapshot.business.businessId) throw Error("simulated disk/constraint failure");
    return db.query<Record<string, unknown>>(sql, values);
  } };
  await expect(importSnapshots(broken, bundles)).rejects.toThrow("no partial corpus committed");
  expect((await db.query("SELECT * FROM businesses")).rows).toHaveLength(0);
  expect((await db.query("SELECT * FROM chunks")).rows).toHaveLength(0);
});

it("imports and verifies counts/vectors, repeats without duplicates, and retains budget/rate state", async () => {
  await db.query("SELECT ifd_reserve_call(60)");
  const first = await importSnapshots(db, bundles);
  expect(first).toEqual(bundles.map(bundle => ({ businessId: bundle.snapshot.business.businessId,
    pages: 1, chunks: 1, embeddings: 1, snapshotHash: bundle.snapshotHash, alreadyImported: false, review: "ai" })));
  expect((await importSnapshots(db, bundles)).every(count => count.alreadyImported === true)).toBe(true);
  expect((await db.query("SELECT * FROM chunks")).rows).toHaveLength(2);
  expect((await db.query<{ used: number }>("SELECT used FROM pilot_budget")).rows[0].used).toBe(1);
});

it("refuses a changed snapshot or a count mismatch without overwriting the saved corpus", async () => {
  const changed = structuredClone(bundles);
  changed[0].snapshot.chunks[0].text = "new fixture content";
  changed[0].snapshotHash = fingerprint(changed[0].snapshot);
  await expect(importSnapshots(db, changed)).rejects.toThrow("no partial corpus committed");
  await db.query("UPDATE ifd_imports SET snapshot_hash=$1 WHERE business_id=$2", [bundles[0].snapshotHash, bundles[0].snapshot.business.businessId]);
  await db.query("DELETE FROM chunks WHERE business_id=$1", [bundles[0].snapshot.business.businessId]);
  await expect(importSnapshots(db, bundles)).rejects.toThrow("no partial corpus committed");
});
