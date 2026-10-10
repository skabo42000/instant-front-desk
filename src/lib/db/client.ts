import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

// Local schema choice, not a claim about an unverified provider's default.
export const EMBEDDING_DIMENSIONS = 768;

export async function migrateDatabase(db: PGlite): Promise<void> {
  const sql = await readFile(path.join(process.cwd(), "db/001_initial.sql"), "utf8");
  await db.exec(sql);
  await db.exec(await readFile(path.join(process.cwd(), "db/002_embedding_dimensions.sql"), "utf8"));
}

// Omit dataDir for isolated in-memory tests; use an ignored data/ path locally.
export async function openDatabase(dataDir?: string): Promise<PGlite> {
  const db = new PGlite({ dataDir, extensions: { vector } });
  try {
    await migrateDatabase(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
