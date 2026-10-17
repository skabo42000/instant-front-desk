// Temporary production server, fake credentials, no valid question/model calls.
// Always stop it. This is an HTTP/security check, not a deployed-pilot verification.
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { setTimeout: pause } = require("node:timers/promises");
async function main() {
  const port = 3187;
  const origin = `http://127.0.0.1:${port}`;
  const password = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore", env: { ...process.env, IFD_PILOT_MODE: "yes", IFD_DATA_STORE: "supabase", RATE_LIMIT_STORE: "supabase",
      SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-real-database-key",
      GEMINI_EVAL_API_KEY: "synthetic-not-a-real-provider-key", GROQ_EVAL_API_KEY: "synthetic-not-a-real-provider-key",
      PILOT_ACCESS_TOKEN: password, PILOT_PUBLIC_ORIGIN: "https://pilot.example", PILOT_PAUSED: "no",
      LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes", LOCAL_CHAT_MAX_CALLS: "3",
      PILOT_BUSINESS_IDS: "00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002",
      PILOT_BENCHMARK_HASHES: `${"a".repeat(64)},${"b".repeat(64)}`, PILOT_ACCEPTANCE_CONFIRMED: "yes", NEXT_TELEMETRY_DISABLED: "1" },
  });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    let ready = false;
    for (let i=0;i<100;i++) {
      if(exited)throw Error("Temporary server exited");
      try { const health = await fetch(`${origin}/api/health`, {signal:AbortSignal.timeout(1000)}); if(health.status===200){ready=true;break;} } catch {}
      await pause(150);
    }
    if(!ready)throw Error("Temporary server did not start");
    const auth = `Basic ${Buffer.from(`pilot:${password}`).toString("base64")}`;
    const results = [];
    async function check(label, path, expected, init) {
      const response = await fetch(`${origin}${path}`, { ...init, signal:AbortSignal.timeout(5000), redirect:"manual" });
      if(response.status!==expected)throw Error(`${label}: expected ${expected}, received ${response.status}`);
      const body=await response.text();if(body.includes(password)||body.includes("synthetic-not-a-real"))throw Error("Credential echo");
      results.push({label,status:response.status});return response;
    }
    await check("Health without credentials", "/api/health",200);
    const anonymous=await check("Invitation required", "/",401);if(!anonymous.headers.has("www-authenticate"))throw Error("Missing password challenge");
    if(!/^[a-f0-9-]{36}$/.test(anonymous.headers.get("x-request-id")??""))throw Error("Missing denial request ID");
    await check("Incorrect password", "/",401,{headers:{authorization:`Basic ${Buffer.from("pilot:wrong").toString("base64")}`}});
    await check("Missing origin", "/api/chat",403,{method:"POST",headers:{authorization:auth},body:"{}"});
    await check("Foreign origin", "/api/chat",403,{method:"POST",headers:{authorization:auth,origin:"https://attacker.example"},body:"{}"});
    const invalid=await check("Authenticated invalid input", "/api/chat",400,{method:"POST",headers:{authorization:auth,origin:"https://pilot.example"},body:"{}"});
    if(!/^[a-f0-9-]{36}$/.test(invalid.headers.get("x-request-id")??""))throw Error("Missing request ID");
    if(invalid.headers.get("cache-control")?.includes("no-store")!==true)throw Error("Missing no-store");
    await check("Authenticated unknown route", "/unknown-check-route",404,{headers:{authorization:auth}});
    console.log(JSON.stringify({scope:"Temporary production HTTP security smoke; no model calls",checks:results,serverStoppedAfterCheck:true}));
  } finally {
    child.kill("SIGTERM");
    for(let i=0;i<40&&!exited;i++)await pause(100);
    if(!exited){child.kill("SIGKILL");await new Promise(r=>child.once("exit",r));}
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
