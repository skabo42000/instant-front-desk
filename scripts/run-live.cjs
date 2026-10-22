// Share the installed TypeScript loader used by run-ingest.cjs.
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
const pilotCommand = ["start", "stop", "status"].includes(process.argv[2]);
require(pilotCommand ? "./live-pilot.ts" : "./live.ts").main(process.argv.slice(2)).catch(() => {
  if (pilotCommand) {
    console.error("Mac pilot command failed. See docs/pilot.md; check settings, database, acceptance gates and process locks. Raw errors omitted.");
    process.exitCode = 1;
    return;
  }
  console.error("Live runner refused. Usage: npm run live -- <https URL> [--max-calls N] [--pause-ms N] [--approve-generated | --reuse-snapshot --question-version N]. Requires LIVE_OK=yes, FREE_TIER_CONFIRMED=yes and isolated evaluation keys.");
  process.exitCode = 1;
});
