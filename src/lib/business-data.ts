import "server-only";
import type { PGlite } from "@electric-sql/pglite";
import type { Repository } from "./retrieve";
import { businessRepository, type StoredBusiness, type SearchHit } from "./db/repository";
import { findBusiness, getLocalDatabase, listBusinesses } from "./local-businesses";
import { latestReport, type EvalReport } from "./eval/runner";
import { createSupabaseRpc, type Rpc } from "./shared-controls";

export interface BusinessData {
  list(): Promise<StoredBusiness[] | Awaited<ReturnType<typeof listBusinesses>>>;
  find(slug: string): Promise<StoredBusiness | null>;
  repository(businessId: string): Repository;
  report(businessId: string): Promise<EvalReport | null>;
}
export function localBusinessData(getDb: () => Promise<PGlite>): BusinessData {
  return { list: async () => listBusinesses(await getDb()), find: async slug => findBusiness(await getDb(), slug),
    repository(id) {
      businessRepository({} as PGlite, id);
      const repo = async () => businessRepository(await getDb(), id);
      return { getBusiness: async () => (await repo()).getBusiness(), listPageTexts: async () => (await repo()).listPageTexts(),
        searchChunks: async (...args) => (await repo()).searchChunks(...args),
        searchChunksByPattern: async (...args) => (await repo()).searchChunksByPattern(...args),
        searchChunksByHeading: async (...args) => (await repo()).searchChunksByHeading(...args),
        listHomepageSummary: async (...args) => (await repo()).listHomepageSummary(...args) };
    }, report: async id => latestReport(await getDb(), id) };
}
export function remoteBusinessData(rpc: Rpc, allowed: readonly string[]): BusinessData {
  if (!allowed.length || allowed.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("Pilot business allowlist required");
  const allow = (id: string) => { if (!allowed.includes(id)) throw new Error("Business outside pilot"); };
  const read = <T>(scope: string | null, operation: string, args: Record<string, unknown> = {}) => rpc<T>("ifd_read", { scope, operation, ...args });
  return {
    list: async () => (await read<StoredBusiness[]>(null, "list")).filter(b => allowed.includes(b.businessId)),
    find: async slug => (await read<StoredBusiness[]>(null, "find", { slug_value: slug })).find(b => allowed.includes(b.businessId)) ?? null,
    report: async id => { allow(id); return read<EvalReport | null>(id, "report"); },
    repository(id) {
      allow(id);
      const search = (operation: string, model: string, pattern: string | null, limit: number, vector?: readonly number[]) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > (operation === "vector" ? 100 : 20)) throw new Error("Invalid search limit");
        if (vector && (vector.length !== 768 || !vector.every(Number.isFinite))) throw new Error("Invalid query vector");
        return read<SearchHit[]>(id, operation, { model_value: model, pattern_value: pattern, result_limit: limit,
          query_vector: vector ? `[${vector.join(",")}]` : null });
      };
      return { getBusiness: async () => (await read<StoredBusiness[]>(id, "business"))[0] ?? null,
        listPageTexts: () => read<{ pageUrl: string; text: string }[]>(id, "pages"),
        searchChunks: (vector, model, limit = 5) => search("vector", model, null, limit, vector),
        searchChunksByPattern: (pattern, model, limit = 3) => search("pattern", model, pattern, limit),
        searchChunksByHeading: (pattern, model, limit = 8) => search("heading", model, pattern, limit),
        listHomepageSummary: model => search("overview", model, null, 3) };
    },
  };
}
let data: BusinessData | undefined;
export function getBusinessData(): BusinessData {
  if (data) return data;
  if (process.env.IFD_DATA_STORE === "supabase") return data = remoteBusinessData(createSupabaseRpc(process.env),
    (process.env.PILOT_BUSINESS_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean));
  if (process.env.IFD_PILOT_MODE === "yes" || (process.env.IFD_DATA_STORE && process.env.IFD_DATA_STORE !== "local")) throw new Error("Persistent pilot data store required");
  return data = localBusinessData(getLocalDatabase);
}
