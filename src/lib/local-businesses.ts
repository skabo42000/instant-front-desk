import "server-only";
import type { PGlite } from "@electric-sql/pglite";
import { localDatabasePath, openDatabase } from "./db/client";
import { businessRepository } from "./db/repository";
import type { Business } from "./types";

const local = globalThis as typeof globalThis & { frontDeskDatabase?: Promise<PGlite> };
export function getLocalDatabase(): Promise<PGlite> {
  // Reuse one connection during reloads; run the CLI with the server stopped.
  return local.frontDeskDatabase ??= openDatabase(localDatabasePath());
}
export async function listBusinesses(db: PGlite): Promise<Business[]> {
  return (await db.query<Business>(`SELECT business_id AS "businessId", slug, name,
    source_url AS "sourceUrl" FROM businesses ORDER BY name, slug`)).rows;
}
export async function findBusiness(db: PGlite, slug: string) {
  const row = (await db.query<{ businessId: string }>(
    `SELECT business_id AS "businessId" FROM businesses WHERE slug = $1`, [slug])).rows[0];
  return row ? businessRepository(db, row.businessId).getBusiness() : null;
}
