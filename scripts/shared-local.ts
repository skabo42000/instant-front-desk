import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { PostgresProviderBudget, PostgresRateLimitStore, type Rpc } from "../src/lib/shared-controls";
import { LocalProviderStop } from "../src/lib/provider-stop";
import { createChatRuntime } from "../src/lib/chat-runtime";
import { pooledPostgresRpc, restrictedPostgresPool } from "../src/lib/postgres-rpc";

export const SCOPE = "Local Postgres 18.4 via direct SQL; not Supabase PostgREST/hosted, not a deployment proof.";
export const MIGRATIONS = ["001_initial.sql", "002_embedding_dimensions.sql", "003_question_lists.sql", "004_eval_reports.sql", "005_pilot_controls.sql", "006_pilot_reads.sql", "007_pilot_permissions.sql", "008_budget_stop.sql"];
export function validateDataRoot(root: string, project: string) {
  const child = relative(project, root);
  if (!child || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child)) || /onedrive/i.test(root)) {
    throw Error("Data root must be outside OneDrive and the project");
  }
}
export async function validateResolvedRoot(root: string, project: string): Promise<void> {
  validateDataRoot(root, project);
  try {
    validateDataRoot(await realpath(root), project);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Check existing ancestors before mkdir can follow a symlink into the project.
    const parent = dirname(root);
    if (parent === root) throw error;
    await validateResolvedRoot(parent, project);
  }
}
export async function loadMigrations(project: string) {
  return Promise.all(MIGRATIONS.map(async name => {
    const sql = await readFile(join(project, "db", name), "utf8");
    if (!sql.trim().startsWith("BEGIN;") || !sql.trim().endsWith("COMMIT;")) throw Error("Incomplete migration");
    return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") };
  }));
}
export interface SqlClient { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export function directRpc(client: SqlClient): Rpc {
  return async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const queries: Record<string, [string, unknown[]]> = {
      ifd_consume_rate: ["SELECT ifd_consume_rate($1::jsonb,$2) AS value", [JSON.stringify(args.entries), args.window_ms]],
      ifd_reserve_call: ["SELECT ifd_reserve_call($1) AS value", [args.max_calls]],
      ifd_stop_calls: ["SELECT ifd_stop_calls() AS value", []],
    };
    if (!queries[name]) throw Error("Unknown local RPC");
    const [sql, values] = queries[name];
    return (await client.query(sql, values)).rows[0].value as T;
  };
}
// Supabase-like API roles. Default privileges grant every new public object to them, as hosted projects do,
// so the proof fails if a migration forgets a revoke.
export const STAND_IN_ROLES_SQL = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`;
export const BROWSER_ROLES = ["anon", "authenticated"] as const;
export const SERVER_FUNCTIONS = ["ifd_consume_rate(jsonb,integer)", "ifd_reserve_call(integer)", "ifd_stop_calls()",
  "ifd_read(uuid,text,text,text,text,vector,integer)"];
export const TABLES = ["businesses", "crawl_runs", "pages", "chunks", "eval_questions", "eval_runs", "eval_results", "question_evidence",
  "result_citations", "model_requests", "question_lists", "rate_buckets", "pilot_budget"];
export async function checkPermissions(client: SqlClient) {
  const one = async (sql: string, values: unknown[]) => (await client.query(sql, values)).rows[0].value === true;
  const functionGrants: string[] = [], tableGrants: string[] = [], schemaCreate: string[] = [];
  for (const role of BROWSER_ROLES) {
    for (const fn of SERVER_FUNCTIONS) if (await one("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, fn])) functionGrants.push(`${role}:${fn}`);
    for (const table of TABLES) if (await one("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS value", [role, table])) tableGrants.push(`${role}:${table}`);
    if (await one("SELECT has_schema_privilege($1,'public','CREATE') AS value", [role])) schemaCreate.push(role);
  }
  // Real attempts, not only catalog answers: 42501 is insufficient_privilege.
  const deniedAsAnon = async (sql: string) => {
    try { await client.query("BEGIN"); await client.query("SET LOCAL ROLE anon"); await client.query(sql); return false; }
    catch (error) { return (error as { code?: string }).code === "42501"; }
    finally { await client.query("ROLLBACK"); }
  };
  const anonReserveDenied = await deniedAsAnon("SELECT ifd_reserve_call(1000)");
  const anonStopDenied = await deniedAsAnon("SELECT ifd_stop_calls()");
  const anonBudgetReadDenied = await deniedAsAnon("SELECT * FROM pilot_budget");
  const vectorSchema = String((await client.query("SELECT n.nspname AS value FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'")).rows[0]?.value ?? "");
  const serverRoleCanReserve = await one("SELECT has_function_privilege('service_role','ifd_reserve_call(integer)','EXECUTE') AS value", []);
  return {
    pass: !functionGrants.length && !tableGrants.length && !schemaCreate.length && anonReserveDenied && anonStopDenied && anonBudgetReadDenied && vectorSchema === "public",
    functionGrants, tableGrants, schemaCreate, anonReserveDenied, anonStopDenied, anonBudgetReadDenied, vectorSchema, serverRoleCanReserve,
    scope: "Local stand-in roles with Supabase-style default grants; catalog checks plus real SET ROLE anon attempts. Not PostgREST/JWT or a hosted project.",
  };
}
export function summarizeRace(results: PromiseSettledResult<boolean>[], expectedAccepted = 3) {
  const accepted = results.filter(r => r.status === "fulfilled" && r.value === true).length;
  const errors = results.filter(r => r.status === "rejected").length;
  return { requests: results.length, expectedAccepted, accepted, errors, pass: results.length === 24 && accepted === expectedAccepted && errors === 0 };
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No local port");
  await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  return address.port;
}
// Structural types avoid adding @types/pg solely for this dev-only proof.
interface Client extends SqlClient { connect(): Promise<void>; end(): Promise<void>; on(event: string, fn: () => void): void }
interface Cluster { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; getPgClient(database: string, host: string): Client }
export async function main(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const postgresPath = args.includes("--postgres");
  const files = args.filter(arg => arg !== "--dry-run" && arg !== "--postgres");
  if (files.length !== 1 || files[0].startsWith("--")) throw Error("check-shared-local -- [--dry-run] OUTPUT_JSON");
  const project = await realpath(process.cwd());
  const output = resolve(files[0]);
  const migrations = await loadMigrations(project);
  const root = resolve(process.env.IFD_POSTGRES_ROOT ?? join(homedir(), "ifd-postgres"));
  validateDataRoot(root, project);
  const report = {
    schema: 1, at: new Date().toISOString(), test: "Local direct-SQL shared controls", scope: SCOPE, dryRun,
    adapter: postgresPath ? "pooledPostgresRpc (production boundary), restricted ifd_app login" : "legacy directRpc",
    migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    roles: "Stand-in anon/authenticated/service_role created before migrations with Supabase-style default grants on public tables/functions/sequences, so db/007 revokes are exercised. Approximation of a hosted project, not one.",
    requestedDataRoot: root,
    dataDirectory: null as string | null, serverVersion: null as string | null,
    stage: "migration-loading", error: null as string | null, pass: false,
    checks: {} as Record<string, { pass: boolean; [key: string]: unknown }>,
    cleanup: { stopped: false, removed: false, required: !dryRun },
  };
  if (!dryRun) {
    for (const name of ["connections", "permissions", "concurrency", "budgetPersistence", "savedStopOutage", "unsavedStopOutage"]) {
      report.checks[name] = { pass: false, observed: false, reason: "Not executed" };
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "", { mode: 0o600, flag: "wx" });
  let cluster: Cluster | undefined;
  const clients: Client[] = [];
  let stopped = true;
  const disconnect = async () => { await Promise.allSettled(clients.splice(0).map(c => c.end())); };
  try {
    if (dryRun) {
      report.checks.migrationLoading = { pass: true, count: migrations.length, scope: "Files and transaction boundaries only; SQL not executed; pgvector unverified." };
      report.pass = true;
    } else {
      report.stage = "data-directory";
      await validateResolvedRoot(root, project);
      await mkdir(root, { recursive: true, mode: 0o700 });
      validateDataRoot(await realpath(root), project);
      report.dataDirectory = await mkdtemp(join(await realpath(root), "run-"));
      report.stage = "loopback-port";
      const port = await freePort();
      // Native import keeps the ESM package out of the CLI's CJS transpilation.
      const nativeImport = new Function("return import('embedded-postgres')") as () => Promise<{ default: new (options: object) => Cluster }>;
      const EmbeddedPostgres = (await nativeImport()).default;
      const password = randomBytes(32).toString("hex");
      const loadPg = new Function("return import('pg')") as () => Promise<{ default: { Client: new (options: object) => Client } }>;
      const PgClient = (await loadPg()).default.Client;
      const newClient = (app = false, bootstrap = false) => new PgClient({ host: "127.0.0.1", port, user: app ? "ifd_app" : "postgres",
        database: postgresPath && !bootstrap ? "ifd_live" : "postgres", password,
        connectionTimeoutMillis: 3000, query_timeout: 5000 });
      const rpcFor = (client: Client): Rpc => postgresPath ? pooledPostgresRpc(restrictedPostgresPool({ connect: async () => ({
        query: (sql, values) => client.query(sql, values), release: () => {},
      }) }), [password]) : directRpc(client);
      cluster = new EmbeddedPostgres({ databaseDir: report.dataDirectory, port, user: "postgres", password,
        persistent: true, createPostgresUser: false, initdbFlags: ["--locale=C"],
        postgresFlags: ["-h", "127.0.0.1", "-k", report.dataDirectory], onLog: () => {}, onError: () => {} });
      report.stage = "initialise";
      // embedded-postgres writes a temporary initdb password file via os.tmpdir().
      // Keep it outside the repo even when the caller uses a workspace TMPDIR.
      const tempNames = ["TMPDIR", "TMP", "TEMP"] as const;
      const previousTemp = tempNames.map(name => process.env[name]);
      const previousMask = process.umask(0o077);
      try {
        for (const name of tempNames) process.env[name] = await realpath(root);
        await cluster.initialise();
      } finally {
        tempNames.forEach((name, i) => {
          if (previousTemp[i] === undefined) delete process.env[name]; else process.env[name] = previousTemp[i];
        });
        process.umask(previousMask);
      }
      report.stage = "start";
      stopped = false; await cluster.start();
      if (postgresPath) {
        const bootstrap = newClient(false, true);
        try { await bootstrap.connect(); await bootstrap.query("CREATE DATABASE ifd_live"); }
        finally { await bootstrap.end(); }
      }
      const connect = async (app = false) => {
        const c = newClient(app);
        c.on("error", () => {}); // Shutdown errors are expected; query promises still reject.
        clients.push(c); await c.connect(); await c.query("SET statement_timeout = '5s'"); return c;
      };
      let a = await connect(), b = await connect();
      report.serverVersion = String((await a.query("SHOW server_version")).rows[0].server_version);
      if (!/^18\.4(?:\D|$)/.test(report.serverVersion)) throw Error("Wrong Postgres version");
      report.stage = "pgvector-prerequisite";
      if (!(await a.query("SELECT name FROM pg_available_extensions WHERE name='vector'")).rows.length) throw Error("Missing vector");
      report.stage = "roles";
      await a.query(STAND_IN_ROLES_SQL);
      report.stage = "migrations";
      for (const migration of migrations) await a.query(migration.sql);
      let appPermissions = true;
      if (postgresPath) {
        const { APP_ROLE_SQL, verifyAppRole } = await import("./live-db");
        await a.query("CREATE TABLE ifd_migrations(name text PRIMARY KEY,sha256 text NOT NULL)");
        await a.query("BEGIN");
        await a.query("SELECT set_config('ifd.app_password',$1,true)", [password]);
        await a.query(APP_ROLE_SQL);
        await a.query("COMMIT");
        appPermissions = await verifyAppRole(a);
      }
      report.stage = "checks";
      const pids = await Promise.all([a.query("SELECT pg_backend_pid() AS pid"), b.query("SELECT pg_backend_pid() AS pid")]);
      report.checks.connections = { pass: pids[0].rows[0].pid !== pids[1].rows[0].pid, count: 2 };
      report.stage = "permissions";
      report.checks.permissions = await checkPermissions(a);
      report.checks.permissions.appRoleVerified = postgresPath ? appPermissions : null;
      report.checks.permissions.pass &&= appPermissions;
      // SQL inspection uses the owner; all production RPC checks use the restricted login.
      let appA = postgresPath ? await connect(true) : a, appB = postgresPath ? await connect(true) : b;
      if (postgresPath) {
        const identities = await Promise.all([appA, appB].map(c => c.query("SELECT current_user AS role,pg_backend_pid() AS pid")));
        report.checks.connections = { pass: identities[0].rows[0].pid !== identities[1].rows[0].pid && identities.every(r => r.rows[0].role === "ifd_app"), count: 2, role: "ifd_app" };
        let tableDenied = false, createDenied = false;
        try { await appA.query("SELECT * FROM chunks LIMIT 1"); } catch (error) { tableDenied = (error as { code?: string }).code === "42501"; }
        try { await appA.query("CREATE TABLE ifd_forbidden(id integer)"); } catch (error) { createDenied = (error as { code?: string }).code === "42501"; }
        report.checks.permissions.appTableReadDenied = tableDenied;
        report.checks.permissions.appSchemaCreateDenied = createDenied;
        report.checks.permissions.pass &&= tableDenied && createDenied;
      }
      const stores = [appA, appB].map(c => new PostgresRateLimitStore(rpcFor(c)));
      const key = `client:local-proof-${randomUUID()}`;
      report.checks.concurrency = summarizeRace(await Promise.allSettled(Array.from({ length: 24 }, (_, i) =>
        stores[i % 2].consume([{ key, limit: 3 }, { key: `${key}-${i}`, limit: 1 }], 60000))));
      const stopDirectory = join(report.dataDirectory, "provider-stop");
      const budgetA = new PostgresProviderBudget(rpcFor(appA), new LocalProviderStop(stopDirectory));
      const reserved = await budgetA.reserve(60); await budgetA.stop();
      // Empty local store: prove DB persistence without marker replay hiding a regression.
      const observerDirectory = join(report.dataDirectory, "observer-stop");
      const acceptedAfterStop = await new PostgresProviderBudget(rpcFor(appB), new LocalProviderStop(observerDirectory)).reserve(60);
      report.checks.budgetPersistence = { pass: reserved && !acceptedAfterStop, reserved, acceptedAfterStop };
      report.stage = "saved-stop-outage";
      await disconnect(); await cluster.stop(); stopped = true;
      stopped = false; await cluster.start(); a = await connect(); b = await connect();
      appA = postgresPath ? await connect(true) : a; appB = postgresPath ? await connect(true) : b;
      const acceptedAfterRecovery = await new PostgresProviderBudget(rpcFor(appB), new LocalProviderStop(observerDirectory)).reserve(60);
      report.checks.savedStopOutage = { pass: !acceptedAfterRecovery, acceptedAfterRecovery, scope: "Orderly database stop/restart; not host power loss." };
      // Only this disposable test cluster is reset, to isolate an unsaved quota stop.
      await a.query("TRUNCATE pilot_budget");
      await rm(stopDirectory, { recursive: true, force: true });
      let stopRejected = false, reservationRejected = false;
      let connectionRejected = false;
      const outageRpc: Rpc = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
        const c = newClient(postgresPath); c.on("error", () => {});
        try {
          try { await c.connect(); } catch (error) { connectionRejected = true; throw error; }
          return await rpcFor(c)<T>(name, params);
        } finally { await c.end().catch(() => {}); }
      };
      const observedRpc: Rpc = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
        try { return stopped ? await outageRpc<T>(name, params) : await rpcFor(appA)<T>(name, params); }
        catch (error) { if (name === "ifd_stop_calls") stopRejected = true; throw error; }
      };
      const quotaBudget = new PostgresProviderBudget(observedRpc, new LocalProviderStop(stopDirectory));
      // Real runtime guard, fake HTTP only: reserve while up, then lose DB before quota arrives.
      const quotaRuntime = createChatRuntime({ LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes",
        GEMINI_EVAL_API_KEY: "synthetic-unused", GROQ_EVAL_API_KEY: "synthetic-unused" }, async () => {
        await disconnect(); await cluster!.stop(); stopped = true;
        return Response.json({ error: "quota exceeded" }, { status: 429 });
      }, quotaBudget);
      let quotaRejected = false;
      try { await quotaRuntime("gemini-embedding-001").embeddings.embed("synthetic outage check"); }
      catch (error) { quotaRejected = (error as { code?: string }).code === "FREE_TIER_EXHAUSTED"; }
      try { await quotaBudget.reserve(60); } catch { reservationRejected = true; }
      stopped = false; await cluster.start(); b = await connect();
      appB = postgresPath ? await connect(true) : b;
      const acceptedAfterLostStop = await new PostgresProviderBudget(rpcFor(appB), new LocalProviderStop(stopDirectory)).reserve(60);
      const sharedStopped = (await b.query("SELECT stopped FROM pilot_budget WHERE id='pilot'")).rows[0]?.stopped === true;
      report.checks.unsavedStopOutage = {
        pass: quotaRejected && connectionRejected && stopRejected && reservationRejected && !acceptedAfterLostStop && sharedStopped,
        observed: true, quotaRejected, sharedStopped, connectionRejected, stopRejected, reservationRejected, acceptedAfterRecovery: acceptedAfterLostStop,
        limitationObserved: stopRejected && acceptedAfterLostStop,
        scope: "Fake HTTP quota through real runtime; fresh local-store/budget objects replay after recovery on the same filesystem. No provider calls, separate-host or power-loss proof.",
      };
      report.pass = Object.values(report.checks).every(check => check.pass);
      report.stage = "complete";
    }
  } catch (error) {
    report.error = report.stage === "pgvector-prerequisite" ? "Native pgvector unavailable; cannot apply db/001-008 unchanged." : `Local check unavailable or failed at ${report.stage}; raw exception omitted.`;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && ["EPERM", "EACCES", "ECONNREFUSED", "ENOENT", "ETIMEDOUT"].includes(code)) report.error += ` Code: ${code}.`;
    report.pass = false;
  } finally {
    await disconnect();
    try { if (cluster && !stopped) { await cluster.stop(); stopped = true; } report.cleanup.stopped = stopped; }
    catch { report.pass = false; }
    if (report.dataDirectory && stopped) {
      try { await rm(report.dataDirectory, { recursive: true, force: true }); report.cleanup.removed = true; }
      catch { report.pass = false; }
    }
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(JSON.stringify(report));
  if (!report.pass) process.exitCode = 1;
}
