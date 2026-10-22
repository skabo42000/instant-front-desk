import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { seedChatDatabase } from "../helpers/chat-database";
import { pooledPostgresRpc, restrictedPostgresPool, type RpcConnection } from "../../src/lib/postgres-rpc";
import { postgresConfiguration } from "../../src/lib/postgres-config";
import { PostgresRateLimitStore, PostgresProviderBudget } from "../../src/lib/shared-controls";
import { remoteBusinessData } from "../../src/lib/business-data";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { createChatRuntime } from "../../src/lib/chat-runtime";
import { LocalProviderStop } from "../../src/lib/provider-stop";
import { APP_ROLE_SQL, applyMigrations, verifyAppRole } from "../../scripts/live-db";
import { pilotEnvironment } from "../../scripts/live-pilot";
import { pilotConfigurationIssues } from "../../src/lib/pilot-policy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const password = "fixture-password-which-is-not-a-real-secret";
const url = `postgresql://ifd_app:${password}@127.0.0.1:55432/ifd_live`;
const directory = mkdtempSync(join(tmpdir(), "ifd-pg-pilot-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("accepts only the dedicated loopback database and restricted app login, with generic configuration errors", () => {
  expect(postgresConfiguration({ IFD_DATABASE_URL: url }).password).toBe(password);
  for (const invalid of [url.replace("ifd_app", "postgres"), url.replace("127.0.0.1", "localhost"), url.replace("55432", "5432"),
    url.replace("ifd_live", "postgres"), `${url}?host=attacker.test`, `${url}#fragment`, "invalid-secret-url"]) {
    expect(() => postgresConfiguration({ IFD_DATABASE_URL: invalid })).toThrow("Invalid local Postgres configuration");
  }
});

it("uses four parameterized RPCs only and normalizes void", async () => {
  const query = vi.fn(async () => ({ rows: [{ value: true as unknown }] }));
  const release = vi.fn();
  const rpc = pooledPostgresRpc({ connect: async () => ({ query, release }) });
  expect(await rpc("ifd_consume_rate", { entries: [{ key: "hostile'" }], window_ms: 60000 })).toBe(true);
  expect(query).toHaveBeenCalledWith("SELECT public.ifd_consume_rate($1::jsonb,$2) AS value", ['[{"key":"hostile\u0027"}]', 60000]);
  await rpc("ifd_read", { scope: null, operation: "find", slug_value: "' OR true --" });
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("public.ifd_read"), [null, "find", "' OR true --", null, null, null, 8]);
  query.mockResolvedValueOnce({ rows: [{ value: "" }] });
  expect(await rpc("ifd_stop_calls", {})).toBeNull();
  for (const name of ["query", "constructor", "__proto__", "ifd_other", "ifd_read;DROP TABLE chunks"])
    await expect(rpc(name, {})).rejects.toThrow("Invalid RPC name");
  expect(release).toHaveBeenCalledTimes(3);
});

it("fails closed on connection/query failures, malformed replies, excessive replies and credential echoes", async () => {
  const cases = [async () => { throw Error(`driver exposed ${password}`); },
    async () => ({ rows: [] }), async () => ({ rows: [{ missing: true }] }),
    async () => ({ rows: [{ value: password }] }), async () => ({ rows: [{ value: "x".repeat(2_000_001) }] })];
  for (const query of cases) {
    const release = vi.fn();
    const rpc = pooledPostgresRpc({ connect: async () => ({ query, release }) }, [password]);
    await expect(rpc("ifd_reserve_call", { max_calls: 60 })).rejects.toThrow(/^Shared database unavailable$/);
    expect(release).toHaveBeenCalledWith(true);
  }
  const rpc = pooledPostgresRpc({ connect: async () => { throw Error(password); } });
  await expect(rpc("ifd_reserve_call", { max_calls: 60 })).rejects.toThrow(/^Shared database unavailable$/);
});

it("bounds query duration and destroys a timed-out connection", async () => {
  vi.useFakeTimers();
  try {
    const release = vi.fn();
    const rpc = pooledPostgresRpc({ connect: async () => ({ query: () => new Promise(() => {}), release }) }, [], 25);
    const result = expect(rpc("ifd_stop_calls", {})).rejects.toThrow(/^Shared database unavailable$/);
    await vi.advanceTimersByTimeAsync(25); await result;
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  } finally { vi.useRealTimers(); }
});

it("destroys connections arriving after the acquisition deadline without issuing a query", async () => {
  vi.useFakeTimers();
  try {
    const release = vi.fn(), query = vi.fn();
    let resolve!: (connection: RpcConnection) => void;
    const rpc = pooledPostgresRpc({ connect: () => new Promise(yes => { resolve = yes; }) }, [], 25);
    const result = expect(rpc("ifd_reserve_call", { max_calls: 60 })).rejects.toThrow(/^Shared database unavailable$/);
    await vi.advanceTimersByTimeAsync(25); await result;
    resolve({ query, release }); await vi.advanceTimersByTimeAsync(0);
    expect(query).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledExactlyOnceWith(true);
  } finally { vi.useRealTimers(); }
});

it("prevents provider calls when the Postgres budget is unavailable", async () => {
  const transport = vi.fn();
  const rpc = pooledPostgresRpc({ connect: async () => { throw Error(password); } });
  const runtime = createChatRuntime({ LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes", GEMINI_EVAL_API_KEY: "fixture", GROQ_EVAL_API_KEY: "fixture" }, transport,
    new PostgresProviderBudget(rpc, new LocalProviderStop(directory)));
  await expect(runtime("gemini-embedding-001").embeddings.embed("hours")).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  await expect(new PostgresRateLimitStore(rpc).consume([{ key: "client:fixture", limit: 1 }], 60000)).rejects.toThrow("Shared database unavailable");
});

it("forces the Mac pilot controls and preserves explicit acceptance, origin, free confirmation and isolated eval keys", () => {
  const env = pilotEnvironment({ IFD_DATABASE_URL: url, PILOT_ACCESS_TOKEN: "x".repeat(32), GEMINI_EVAL_API_KEY: "isolated-gemini", GROQ_EVAL_API_KEY: "isolated-groq" },
    { LOCAL_CHAT_MAX_CALLS: "999", GEMINI_API_KEY: "widget-key", GROQ_API_KEY: "production-key" });
  expect(env).toMatchObject({ IFD_PILOT_MODE: "yes", IFD_DATA_STORE: "postgres", RATE_LIMIT_STORE: "postgres", LOCAL_CHAT_MAX_CALLS: "60", IFD_MCP_ENABLED: "no" });
  expect(env.GEMINI_API_KEY).toBeUndefined(); expect(env.GROQ_API_KEY).toBeUndefined();
  expect(env.IFD_PROVIDER_STOP_DIR).not.toMatch(/onedrive/i);
  expect(pilotConfigurationIssues(env)).toContain("Exact HTTPS pilot origin required");
  expect(pilotConfigurationIssues(env)).toContain("Confirmed free-only real chat required");
  expect(pilotConfigurationIssues(env)).toContain("Reviewed benchmark, judge calibration, concurrency and security acceptance required");
  const valid = { ...env, FREE_TIER_CONFIRMED: "yes", PILOT_PUBLIC_ORIGIN: "https://pilot.example.com", PILOT_ACCEPTANCE_CONFIRMED: "yes",
    PILOT_BUSINESS_IDS: "00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002", PILOT_BENCHMARK_HASHES: `${"a".repeat(64)},${"b".repeat(64)}` };
  expect(pilotConfigurationIssues(valid)).toEqual([]);
  expect(pilotConfigurationIssues({ ...valid, RATE_LIMIT_STORE: "memory" })).toContain("Shared rate limits required");
});

it("checks the authenticated role before runtime RPCs and destroys privileged or unverified connections", async () => {
  for (const allowed of [false, null, "true", undefined]) {
    const query = vi.fn(async () => ({ rows: [{ allowed }] })), release = vi.fn();
    const rpc = pooledPostgresRpc(restrictedPostgresPool({ connect: async () => ({ query, release }) }));
    await expect(rpc("ifd_reserve_call", { max_calls: 60 })).rejects.toThrow(/^Shared database unavailable$/);
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  }
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ allowed: true }] }).mockResolvedValueOnce({ rows: [{ value: false }] });
  const release = vi.fn();
  const rpc = pooledPostgresRpc(restrictedPostgresPool({ connect: async () => ({ query, release }) }));
  expect(await rpc("ifd_reserve_call", { max_calls: 60 })).toBe(false);
  expect(query).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledExactlyOnceWith(false);
});

let db: PGlite;
beforeAll(async () => { db = await seedChatDatabase(); }, 30000);
afterAll(async () => { await db?.close(); });

it("records eight migrations once and refuses a changed applied hash", async () => {
  // PGlite's query uses the extended protocol; real pg uses simple protocol for a migration batch.
  const client = { query: async (sql: string, values?: unknown[]) => {
    if (sql.trim().startsWith("BEGIN;")) { await db.exec(sql); return { rows: [] }; }
    return db.query<Record<string, unknown>>(sql, values);
  } };
  await applyMigrations(client);
  await applyMigrations(client);
  expect((await db.query("SELECT * FROM ifd_migrations")).rows).toHaveLength(8);
  await db.query("UPDATE ifd_migrations SET sha256='changed' WHERE name='008_budget_stop.sql'");
  await expect(applyMigrations(client)).rejects.toThrow("Applied migration changed");
});

it("grants the login exactly the four app RPCs; real table, schema and unrelated function access is denied", async () => {
  const database = (await db.query<{ name: string }>("SELECT current_database() AS name")).rows[0].name;
  expect(database).toMatch(/^[a-z_]+$/);
  // Reinitialization must also strip explicit grants left on a pre-existing role.
  await db.exec(`CREATE ROLE ifd_app LOGIN; GRANT ALL ON DATABASE ${database} TO ifd_app;
    GRANT ALL ON SCHEMA public TO ifd_app; GRANT ALL ON chunks TO ifd_app;`);
  await db.query("SELECT set_config('ifd.app_password',$1,false)", [password]);
  await db.exec(APP_ROLE_SQL.replaceAll("ifd_live", database));
  expect(await verifyAppRole(db)).toBe(true);
  await db.exec("SET ROLE ifd_app");
  try {
    for (const sql of ["SELECT * FROM chunks", "SELECT * FROM pilot_budget", "CREATE TABLE forbidden(id int)", "SELECT vector_dims('[1,2]'::vector)"])
      await expect(db.query(sql)).rejects.toThrow("permission denied");
    const rpc = pooledPostgresRpc(restrictedPostgresPool({ connect: async () => ({ query: (sql, values) => db.query(sql, values), release: () => {} }) }));
    const data = remoteBusinessData(rpc, ["00000000-0000-0000-0000-000000000001"]);
    expect(await data.list()).toHaveLength(1);
    expect(await data.find("maple-repair")).toBeNull();
    const vector = await new FakeEmbeddings().embed("hours");
    expect((await data.repository("00000000-0000-0000-0000-000000000001").searchChunks(vector, new FakeEmbeddings().model, 8)).length).toBeGreaterThan(0);
    expect(await rpc("ifd_reserve_call", { max_calls: 60 })).toBe(true);
    await rpc("ifd_stop_calls", {});
    expect(await rpc("ifd_reserve_call", { max_calls: 60 })).toBe(false);
  } finally { await db.exec("RESET ROLE"); }
});
