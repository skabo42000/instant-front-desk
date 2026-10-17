import "server-only";
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { RateLimitStore, RateLimitEntry } from "./rate-limit-store";
import { LocalProviderStop } from "./provider-stop";

export type Rpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
export interface ProviderBudget { reserve(maxCalls: number): Promise<boolean>; stop(): Promise<void> }
export function createSupabaseRpc(env: Readonly<Record<string, string | undefined>>, transport: typeof fetch = fetch): Rpc {
  const url = new URL(env.SUPABASE_URL ?? "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash || !key || key.length < 20) throw new Error("Invalid shared database configuration");
  return async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    if (!/^ifd_[a-z_]+$/.test(name)) throw new Error("Invalid RPC name");
    try {
      const response = await transport(new URL(`/rest/v1/rpc/${name}`, url), { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(5000), headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(args) });
      if (!response.ok) throw new Error("RPC_FAILED");
      if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("RPC_FAILED");
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new Error("RPC_FAILED"); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(parts).toString("utf8");
      if (text.includes(key)) throw new Error("RPC_FAILED");
      const data = text.length === 0 ? null : JSON.parse(text);
      if (JSON.stringify(data)?.includes(key)) throw new Error("RPC_FAILED");
      return data as T;
    } catch { throw new Error("Shared database unavailable"); }
  };
}
export function databaseRpc(db: PGlite): Rpc {
  return async <T>(name: string, args: Record<string, unknown>) => {
    const queries: Record<string, [string, unknown[]]> = {
      ifd_consume_rate: ["SELECT ifd_consume_rate($1::jsonb,$2) AS value", [JSON.stringify(args.entries), args.window_ms]],
      ifd_reserve_call: ["SELECT ifd_reserve_call($1) AS value", [args.max_calls]],
      ifd_stop_calls: ["SELECT ifd_stop_calls() AS value", []],
    };
    const query = queries[name]; if (!query) throw new Error("Unknown local RPC");
    return (await db.query<{ value: T }>(query[0], query[1])).rows[0].value;
  };
}
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly rpc: Rpc) {}
  async consume(entries: RateLimitEntry[], windowMs: number): Promise<boolean> {
    if (!entries.length || entries.length > 10 || !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 3600000 ||
      entries.some(e => !e.key || e.key.length > 200 || !Number.isInteger(e.limit) || e.limit < 1 || e.limit > 10000) ||
      new Set(entries.map(e => e.key)).size !== entries.length) throw new Error("Invalid rate limit input");
    const hashed = entries.map(e => {
      const businessId = /^business:([0-9a-f-]{36})$/i.exec(e.key)?.[1] ?? null;
      return { key: createHash("sha256").update(e.key).digest("hex"), businessId, limit: e.limit };
    });
    const result = await this.rpc<boolean>("ifd_consume_rate", { entries: hashed, window_ms: windowMs });
    if (typeof result !== "boolean") throw new Error("Invalid rate store response");
    return result;
  }
}
export class PostgresProviderBudget implements ProviderBudget {
  private stopped = false;
  constructor(private readonly rpc: Rpc, private readonly localStop: LocalProviderStop) {}
  async reserve(maxCalls: number): Promise<boolean> {
    if (this.stopped || this.localStop.exists()) {
      this.stopped = true;
      await this.rpc("ifd_stop_calls", {});
      return false;
    }
    const result = await this.rpc<boolean>("ifd_reserve_call", { max_calls: maxCalls });
    if (typeof result !== "boolean") throw new Error("Invalid budget response");
    return result;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    // Write before awaiting the DB; even a fresh process can replay a failed stop.
    let localFailed = false;
    try { this.localStop.mark(); } catch { localFailed = true; }
    await this.rpc("ifd_stop_calls", {});
    if (localFailed) throw Error("Local provider stop unavailable");
  }
}
