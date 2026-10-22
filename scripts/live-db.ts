import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readFile, readdir, realpath, unlink, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { loadMigrations, validateResolvedRoot, SERVER_FUNCTIONS, TABLES } from "./shared-local";
import { readLocalSettings, saveLocalSettings } from "./live-settings";
import { postgresConfiguration } from "../src/lib/postgres-config";

const execute = promisify(execFile);
export const LIVE_PORT = 55432;
export const liveRoot = () => join(homedir(), "ifd-postgres");
export const liveDirectory = () => join(liveRoot(), "live");
export const stopDirectory = () => join(liveRoot(), "provider-stop");

export async function prepareDirectories(): Promise<void> {
  for (const path of [liveRoot(), liveDirectory(), stopDirectory()]) {
    await validateResolvedRoot(path, await realpath(process.cwd()));
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}
export async function binaries() {
  if (process.platform !== "darwin") throw Error("This live cluster script is for this Mac only");
  const nativeImport = new Function("name", "return import(name)") as (name: string) => Promise<{ pg_ctl: string; initdb: string; postgres: string }>;
  return nativeImport(`@embedded-postgres/darwin-${process.arch === "x64" ? "x64" : "arm64"}`);
}
export async function requirePgvector(): Promise<void> {
  const native = dirname(dirname((await binaries()).postgres));
  try {
    await access(join(native, "share/postgresql/extension/vector.control"));
    await access(join(native, "lib/postgresql/vector.dylib"));
  } catch {
    const target = `node_modules/@embedded-postgres/darwin-${process.arch === "x64" ? "x64" : "arm64"}/native`;
    throw Error(`Native pgvector missing. From the project directory, restore the matching local build:\n` +
      `cp "$HOME/ifd-pgbuild/src/pgvector/vector.dylib" ${target}/lib/postgresql/vector.dylib\n` +
      `cp "$HOME/ifd-pgbuild/src/pgvector/vector.control" ${target}/share/postgresql/extension/\n` +
      `cp "$HOME/ifd-pgbuild/src/pgvector/sql/"vector--*.sql ${target}/share/postgresql/extension/`);
  }
}
export async function databaseRunning(): Promise<boolean> {
  try { await execute((await binaries()).pg_ctl, ["-D", liveDirectory(), "status"], { timeout: 5000 }); return true; }
  catch (error) {
    if ([3, 4].includes(Number((error as { code?: number }).code))) return false;
    throw Error("Cannot inspect local Postgres status");
  }
}
export async function adminClient(database = "ifd_live") {
  const pool = new Pool({ host: liveDirectory(), port: LIVE_PORT, user: "ifd_owner", database,
    max: 1, connectionTimeoutMillis: 3000, query_timeout: 10_000 });
  pool.on("error", () => {});
  try {
    const client = await pool.connect();
    return { client, close: async () => { client.release(); await pool.end(); } };
  } catch { await pool.end(); throw Error("Local operator connection unavailable"); }
}

export const APP_ROLE_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ifd_app') THEN CREATE ROLE ifd_app LOGIN; END IF;
END $$;
ALTER ROLE ifd_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
REVOKE ALL ON DATABASE ifd_live FROM PUBLIC,ifd_app;
GRANT CONNECT ON DATABASE ifd_live TO ifd_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC,ifd_app;
GRANT USAGE ON SCHEMA public TO ifd_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ifd_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ifd_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,ifd_app;
GRANT EXECUTE ON FUNCTION ${SERVER_FUNCTIONS.join(",")} TO ifd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('ALTER ROLE ifd_app PASSWORD %L',current_setting('ifd.app_password'));
END $$;`;

export async function applyMigrations(client: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {
  await client.query("CREATE TABLE IF NOT EXISTS ifd_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
  for (const migration of await loadMigrations(process.cwd())) {
    const old = (await client.query("SELECT sha256 FROM ifd_migrations WHERE name=$1", [migration.name])).rows[0];
    if (old) { if (old.sha256 !== migration.sha256) throw Error("Applied migration changed; operator review required"); continue; }
    // Put the ledger insert inside the migration's own transaction.
    await client.query(migration.sql.trim().replace(/COMMIT;$/, ""));
    try {
      await client.query("INSERT INTO ifd_migrations(name,sha256) VALUES ($1,$2)", [migration.name, migration.sha256]);
      await client.query("COMMIT");
    } catch { await client.query("ROLLBACK"); throw Error("Migration failed"); }
  }
}

export async function verifyAppRole(client: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }): Promise<boolean> {
  const role = (await client.query("SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS value FROM pg_roles WHERE rolname='ifd_app'")).rows[0];
  if (role?.value !== true) return false;
  if ((await client.query("SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='ifd_app')")).rows.length) return false;
  const owned = await client.query(`SELECT 1 FROM pg_roles r WHERE r.rolname='ifd_app' AND (
    EXISTS (SELECT FROM pg_database WHERE datdba=r.oid) OR
    EXISTS (SELECT FROM pg_namespace WHERE nspowner=r.oid) OR
    EXISTS (SELECT FROM pg_class WHERE relowner=r.oid) OR
    EXISTS (SELECT FROM pg_proc WHERE proowner=r.oid))`);
  if (owned.rows.length) return false;
  if ((await client.query("SELECT has_database_privilege('ifd_app',current_database(),'CREATE,TEMPORARY') AS value")).rows[0].value) return false;
  const allTables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => String(row.tablename));
  for (const table of new Set([...TABLES, "ifd_migrations", ...allTables])) {
    if ((await client.query("SELECT has_table_privilege('ifd_app',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS value", [table])).rows[0].value) return false;
  }
  if ((await client.query("SELECT has_schema_privilege('ifd_app','public','CREATE') AS value")).rows[0].value) return false;
  for (const fn of SERVER_FUNCTIONS) {
    if ((await client.query("SELECT has_function_privilege('ifd_app',$1,'EXECUTE') AS value", [fn])).rows[0].value !== true) return false;
  }
  return true;
}

export async function initializeDatabase() {
  await requirePgvector();
  await prepareDirectories();
  if (await databaseRunning()) throw Error("Stop the live app and database before init; existing data is retained");
  const { initdb } = await binaries();
  try { await access(join(liveDirectory(), "PG_VERSION")); }
  catch {
    if ((await readdir(liveDirectory())).length) throw Error("Incomplete cluster directory; preserve it for operator inspection");
    await execute(initdb, ["-D", liveDirectory(), "-U", "ifd_owner", "--auth-local=trust", "--auth-host=scram-sha-256", "--locale=C"], { timeout: 30_000 });
  }
  await startDatabase();
  try {
    const operator = await adminClient("postgres");
    try {
      if (!(await operator.client.query("SELECT 1 FROM pg_database WHERE datname='ifd_live'")).rows.length) await operator.client.query("CREATE DATABASE ifd_live");
    } finally { await operator.close(); }
    const settings = await readLocalSettings();
    const password = settings.IFD_DATABASE_URL ? postgresConfiguration(settings).password : randomBytes(32).toString("hex");
    // Save before configuring the role: a failed setup can resume without losing the generated password.
    await saveLocalSettings({ IFD_DATABASE_URL: `postgresql://ifd_app:${encodeURIComponent(password)}@127.0.0.1:${LIVE_PORT}/ifd_live`,
      PILOT_ACCESS_TOKEN: settings.PILOT_ACCESS_TOKEN || randomBytes(32).toString("hex") });
    const db = await adminClient();
    try {
      await applyMigrations(db.client);
      await db.client.query("BEGIN");
      try {
        await db.client.query("SELECT set_config('ifd.app_password',$1,true)", [password]);
        await db.client.query(APP_ROLE_SQL);
        if (!await verifyAppRole(db.client)) throw Error();
        await db.client.query("COMMIT");
      } catch { await db.client.query("ROLLBACK"); throw Error("Restricted app-role setup failed"); }
    } finally { await db.close(); }
  } finally { await stopDatabase(); }
  console.log("Live database initialized; stopped. Eight migrations recorded; restricted app role verified. Secrets saved only in .env.local.");
}
export async function startDatabase() {
  await requirePgvector();
  await prepareDirectories();
  if (await databaseRunning()) return;
  // Socket stays in the 0700 cluster directory; TCP is loopback and SCRAM only.
  await execute((await binaries()).pg_ctl, ["-D", liveDirectory(), "-l", join(liveRoot(), "postgres.log"), "-w", "-t", "15",
    "-o", `-h 127.0.0.1 -p ${LIVE_PORT} -k ${liveDirectory()} -c password_encryption=scram-sha-256 -c log_statement=none -c log_min_error_statement=panic`, "start"], { timeout: 20_000 });
}
export async function stopDatabase() {
  if (!await databaseRunning()) return;
  await execute((await binaries()).pg_ctl, ["-D", liveDirectory(), "-w", "-t", "15", "-m", "fast", "stop"], { timeout: 20_000 });
}

export async function main(args: string[]) {
  process.umask(0o077);
  const [command, ...rest] = args;
  if (!["init", "start", "stop", "status", "import"].includes(command)) throw Error("Usage: npm run live-db -- init|start|stop|status|import [--snapshots FILE FILE]");
  if (command === "status") { console.log(JSON.stringify({ database: await databaseRunning() ? "running" : "stopped", directory: liveDirectory(), port: LIVE_PORT })); return; }
  await prepareDirectories();
  const lock = await open(join(liveRoot(), "live-db.lock"), "wx", 0o600).catch(() => { throw Error("Another live-db command is active, or a stale ~/ifd-postgres/live-db.lock needs operator inspection"); });
  try {
    if (command === "init") await initializeDatabase();
    if (command === "start") { await startDatabase(); console.log("Live database running on 127.0.0.1:55432"); }
    if (command === "stop") { await stopDatabase(); console.log("Live database stopped; data retained"); }
    if (command === "import") {
      const { importOwnedBusinesses } = await import("./live-import");
      await importOwnedBusinesses(rest);
    }
  } finally { await lock.close(); await unlink(join(liveRoot(), "live-db.lock")); }
}
