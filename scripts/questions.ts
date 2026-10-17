import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { localDatabasePath, openDatabase } from "../src/lib/db/client";
import { questionRepository } from "../src/lib/eval/questions";

export const USAGE = "Usage: npm run questions -- <business-uuid> generate|list|show <version>|approve <version>|edit <version> <question-uuid> <replacement.json>";
export async function execute(db: PGlite, args: readonly string[]): Promise<unknown> {
  const [businessId, action, version, questionId, filename] = args;
  const repo = questionRepository(db, businessId ?? "");
  if (action === "generate" && args.length === 2) return repo.generate();
  if (action === "list" && args.length === 2) return repo.list();
  if (action === "show" && args.length === 3) return repo.get(Number(version));
  if (action === "approve" && args.length === 3) return repo.approve(Number(version));
  if (action === "edit" && args.length === 5) {
    const replacement: unknown = JSON.parse(await readFile(filename, "utf8"));
    return repo.edit(Number(version), questionId, replacement);
  }
  throw new Error(USAGE);
}
export async function main(args: readonly string[]): Promise<void> {
  if (args.length < 2) throw new Error(USAGE);
  const db = await openDatabase(localDatabasePath());
  try { console.log(JSON.stringify(await execute(db, args), null, 2)); }
  finally { await db.close(); }
}
