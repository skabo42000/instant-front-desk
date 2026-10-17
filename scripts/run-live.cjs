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
require("./live.ts").main(process.argv.slice(2)).catch(() => {
  console.error("Live runner refused. Usage: npm run live -- <https URL> [--max-calls N] [--pause-ms N] [--approve-generated | --reuse-snapshot --question-version N]. Requires LIVE_OK=yes, FREE_TIER_CONFIRMED=yes and isolated evaluation keys.");
  process.exitCode = 1;
});
