import { localDatabasePath, openDatabase } from "../src/lib/db/client";

// Local database only. Stop the web server first; no model keys or network calls.
export async function main() {
  const db = await openDatabase(localDatabasePath());
  try {
    const result = await db.query(`SELECT b.business_id AS "businessId", b.name, b.slug,
      b.source_url AS "sourceUrl", b.embedding_model AS "embeddingModel",
      (SELECT count(*)::int FROM chunks c WHERE c.business_id=b.business_id) AS chunks,
      (SELECT max(version) FROM question_lists q WHERE q.business_id=b.business_id AND approved_at IS NOT NULL) AS "approvedVersion"
      FROM businesses b ORDER BY b.name,b.slug`);
    console.log(JSON.stringify(result.rows, null, 2));
  } finally { await db.close(); }
}
