// Use the installed TypeScript compiler so the CLI shares the app's TS modules.
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
require("./ingest.ts").main(process.argv.slice(2)).catch(error => {
  // Error messages may include a fetched URL; keep command output free of page data.
  console.error(error.message.startsWith("Usage:") ? error.message : "Ingestion failed; no successful crawl snapshot was stored.");
  process.exitCode = 1;
});
