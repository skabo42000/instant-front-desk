import "server-only";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

// Local schema choice, not a claim about an unverified provider's default.
export const EMBEDDING_DIMENSIONS = 768;

export function localDatabasePath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  let directory = env.IFD_DATABASE_DIR;
  if (directory === undefined) {
    // CLI commands need the same local folder as Next, without loading keys or authorization flags.
    try {
      const match = /^\s*(?:export\s+)?IFD_DATABASE_DIR\s*=\s*(.*?)\s*$/m.exec(readFileSync(".env.local", "utf8"));
      const value = match?.[1] ?? "";
      directory = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read local database settings.");
    }
  }
  return path.resolve(directory || "data/instant-front-desk");
}

export async function migrateDatabase(db: PGlite): Promise<void> {
  const sql = await readFile(path.join(process.cwd(), "db/001_initial.sql"), "utf8");
  await db.exec(sql);
  await db.exec(await readFile(path.join(process.cwd(), "db/002_embedding_dimensions.sql"), "utf8"));
  await db.exec(await readFile(path.join(process.cwd(), "db/003_question_lists.sql"), "utf8"));
  await db.exec(await readFile(path.join(process.cwd(), "db/004_eval_reports.sql"), "utf8"));
  await db.exec(await readFile(path.join(process.cwd(), "db/005_pilot_controls.sql"), "utf8"));
  await db.exec(await readFile(path.join(process.cwd(), "db/006_pilot_reads.sql"), "utf8"));
  await db.exec(await readFile(path.join(process.cwd(), "db/007_pilot_permissions.sql"), "utf8"));
  await db.exec(await readFile(path.join(process.cwd(), "db/008_budget_stop.sql"), "utf8"));
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
