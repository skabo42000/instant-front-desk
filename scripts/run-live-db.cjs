const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
require("./live-db.ts").main(process.argv.slice(2)).catch(error => {
  // Only our fixed diagnostics are safe; never print driver/process exceptions or argv.
  if (error?.message?.startsWith("Native pgvector missing.")) console.error(error.message);
  else console.error("Live database command failed. Check arguments, pgvector, settings, process locks and directory permissions; raw errors omitted. See docs/pilot.md.");
  process.exitCode = 1;
});
