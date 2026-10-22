import "server-only";
import { Pool } from "pg";
import type { Rpc } from "./shared-controls";
import { postgresConfiguration } from "./postgres-config";

export interface RpcConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export interface RpcPool { connect(): Promise<RpcConnection> }

export function restrictedPostgresPool(pool: RpcPool): RpcPool {
  return { connect: async () => {
    const client = await pool.connect();
    try {
      const result = await client.query(`SELECT current_user='ifd_app' AND r.rolcanlogin AND
        NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit) AND
        NOT EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid) AS allowed
        FROM pg_roles r WHERE r.rolname=current_user`);
      if (result.rows.length !== 1 || result.rows[0].allowed !== true) throw Error();
      return client;
    } catch { client.release(true); throw Error("Shared database unavailable"); }
  } };
}

// Export the boundary so deterministic tests and the real two-connection proof use the same code.
export function pooledPostgresRpc(pool: RpcPool, secrets: readonly string[] = [], timeoutMs = 5000): Rpc {
  return async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const queries = new Map<string, [string, unknown[]]>([
      ["ifd_consume_rate", ["SELECT public.ifd_consume_rate($1::jsonb,$2) AS value", [JSON.stringify(args.entries), args.window_ms]]],
      ["ifd_reserve_call", ["SELECT public.ifd_reserve_call($1) AS value", [args.max_calls]]],
      ["ifd_stop_calls", ["SELECT public.ifd_stop_calls() AS value", []]],
      ["ifd_read", ["SELECT public.ifd_read($1,$2,$3,$4,$5,$6::public.vector,$7) AS value",
        [args.scope ?? null, args.operation, args.slug_value ?? null, args.model_value ?? null,
          args.pattern_value ?? null, args.query_vector ?? null, args.result_limit ?? 8]]],
    ]);
    const query = queries.get(name);
    if (!query) throw Error("Invalid RPC name");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let connection: RpcConnection | undefined;
    try {
      const work = (async () => {
        const client = await pool.connect();
        if (expired) { client.release(true); throw Error(); }
        connection = client;
        const rows = (await client.query(...query)).rows;
        if (expired) throw Error();
        if (rows.length !== 1 || !("value" in rows[0])) throw Error();
        // node-postgres returns an empty string for SQL void; normalize like PostgREST.
        const value = name === "ifd_stop_calls" && rows[0].value === "" ? null : rows[0].value;
        const serialized = JSON.stringify(value);
        if (serialized === undefined || Buffer.byteLength(serialized) > 2_000_000 ||
          secrets.some(secret => secret && serialized.includes(secret))) throw Error();
        return value as T;
      })();
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(Error()); }, timeoutMs);
      })]);
    } catch {
      expired = true;
      throw Error("Shared database unavailable");
    } finally {
      clearTimeout(timer);
      connection?.release(expired);
    }
  };
}

const state = globalThis as typeof globalThis & { frontDeskPostgres?: { url: string; rpc: Rpc } };
export function createPostgresRpc(env: Readonly<Record<string, string | undefined>>): Rpc {
  const { connectionString, password } = postgresConfiguration(env);
  if (state.frontDeskPostgres) {
    if (state.frontDeskPostgres.url !== connectionString) throw Error("Postgres configuration changed; restart required");
    return state.frontDeskPostgres.rpc;
  }
  const pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3000, statement_timeout: 4000, query_timeout: 4500,
    application_name: "instant-front-desk", options: "-c search_path=public,pg_temp -c lock_timeout=3000" });
  // Idle-client errors must not print driver exceptions (which can contain connection details).
  pool.on("error", () => {});
  const rpc = pooledPostgresRpc(restrictedPostgresPool(pool), [connectionString, password]);
  state.frontDeskPostgres = { url: connectionString, rpc };
  return rpc;
}
