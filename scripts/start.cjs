const { spawn } = require("node:child_process");
const pilot = process.env.IFD_PILOT_MODE === "yes";
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", pilot && process.env.IFD_DATA_STORE !== "postgres" ? "0.0.0.0" : "127.0.0.1"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 1; });
