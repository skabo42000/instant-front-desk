const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
};
require("./benchmark.ts").main(process.argv.slice(2)).catch(error => {
  // Do not print exceptions from providers, transports or parsed private files.
  console.error("Benchmark command failed. Check the command, snapshot integrity and review state; no result was accepted.");
  process.exitCode = 1;
});
