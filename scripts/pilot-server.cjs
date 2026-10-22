// A stable supervisor PID lets stop/status avoid signaling an unrelated reused PID.
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3000"], { stdio: "inherit" });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (!stopping) { stopping = true; child.kill("SIGTERM"); }
});
child.once("error", () => { console.error("Production server failed to start"); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
