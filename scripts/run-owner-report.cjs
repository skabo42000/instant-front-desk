const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
};
require("./owner-report.ts").main(process.argv.slice(2)).catch(() => {
  console.error("Owner report failed. Supply REPORT_JSON OUTPUT_HTML SAVED_BENCHMARK_JSON with matching saved data and a new output path.");
  process.exitCode = 1;
});
