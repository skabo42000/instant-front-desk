import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { databaseRunning, liveRoot, prepareDirectories, stopDirectory, adminClient, verifyAppRole } from "./live-db";
import { readLocalSettings, saveLocalSettings } from "./live-settings";
import { pilotConfigurationIssues } from "../src/lib/pilot-policy";

const execute = promisify(execFile);
const pidFile = () => join(liveRoot(), "app.pid");
const supervisor = () => resolve("scripts/pilot-server.cjs");
export const APP_PORT = 3000;

export function pilotEnvironment(settings: Record<string, string>, inherited: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...settings, ...inherited, NODE_ENV: "production", IFD_PILOT_MODE: "yes", IFD_DATA_STORE: "postgres",
    RATE_LIMIT_STORE: "postgres", LOCAL_CHAT_MODE: "real", LOCAL_CHAT_MAX_CALLS: "60", IFD_MCP_ENABLED: "no",
    IFD_PROVIDER_STOP_DIR: stopDirectory(), PORT: String(APP_PORT) };
  // The application adapters use only the isolated eval keys. Remove legacy production credentials.
  for (const key of ["GEMINI_API_KEY", "GROQ_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "DATABASE_URL"]) delete env[key];
  return env;
}
async function appPid(): Promise<number | null> {
  let pid: number;
  try { pid = Number((await readFile(pidFile(), "utf8")).trim()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("Cannot inspect app PID"); }
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error("Invalid app PID file");
  try {
    process.kill(pid, 0);
    const command = (await execute("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 })).stdout;
    if (!command.includes(supervisor())) throw Error("PID belongs to a different process; operator inspection required");
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw Error("Cannot safely identify app process");
  }
}

export async function main(args: string[]) {
  process.umask(0o077);
  if (args.length !== 1 || !["start", "stop", "status"].includes(args[0])) throw Error("Usage: npm run live -- start|stop|status");
  await prepareDirectories();
  const lock = await open(join(liveRoot(), "app-command.lock"), "wx", 0o600).catch(() => { throw Error("Another app command is active; inspect ~/ifd-postgres/app-command.lock"); });
  try {
    const pid = await appPid();
    if (args[0] === "status") {
      console.log(JSON.stringify({ app: pid ? "process-running" : "stopped", database: await databaseRunning() ? "running" : "stopped", address: "127.0.0.1:3000", httpVerified: false }));
      return;
    }
    if (args[0] === "stop") {
      if (pid) {
        process.kill(pid, "SIGTERM");
        for (let attempt = 0; attempt < 100 && await appPid(); attempt++) await delay(100);
        if (await appPid()) throw Error("App did not stop; inspect before stopping database");
      }
      await unlink(pidFile()).catch(error => { if (error.code !== "ENOENT") throw error; });
      console.log("Live app stopped; database and budget retained"); return;
    }
    if (pid) throw Error("App already running; stop before rebuilding");
    if (!await databaseRunning()) throw Error("Run npm run live-db -- start first");
    const settings = await readLocalSettings();
    if (!settings.PILOT_ACCESS_TOKEN && !process.env.PILOT_ACCESS_TOKEN) {
      settings.PILOT_ACCESS_TOKEN = randomBytes(32).toString("hex");
      await saveLocalSettings({ PILOT_ACCESS_TOKEN: settings.PILOT_ACCESS_TOKEN });
    }
    const env = pilotEnvironment(settings);
    const issues = pilotConfigurationIssues(env);
    if (issues.length) { console.error(JSON.stringify({ configurationIssues: issues })); throw Error("Pilot prerequisites missing"); }
    const db = await adminClient();
    try { if (!await verifyAppRole(db.client)) throw Error("Restricted app role verification failed"); }
    finally { await db.close(); }
    // Build once per explicit start, before launching the production server. No models are invoked.
    await new Promise<void>((yes, no) => {
      const build = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--webpack"], { env, stdio: "inherit" });
      build.once("error", () => no(Error("Build unavailable")));
      build.once("exit", code => code === 0 ? yes() : no(Error("Build failed")));
    });
    const log = await open(join(liveRoot(), "app.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [supervisor()], { env, detached: true, stdio: ["ignore", log.fd, log.fd] });
      await new Promise<void>((yes, no) => { child.once("spawn", yes); child.once("error", () => no(Error("App launch failed"))); });
      if (!child.pid) throw Error("App launch failed");
      await writeFile(pidFile(), `${child.pid}\n`, { mode: 0o600 });
      child.unref();
      await delay(1500);
      if (!await appPid()) throw Error("App exited; inspect ~/ifd-postgres/app.log privately");
      console.log("Production app process running on 127.0.0.1:3000. Verify invitation and HTTP behavior before sharing the tunnel.");
    } finally { await log.close(); }
  } finally { await lock.close(); await unlink(join(liveRoot(), "app-command.lock")); }
}
