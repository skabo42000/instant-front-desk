const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
require("./eval.ts").main(process.argv.slice(2)).catch(error => {
  console.error(error.message.startsWith("Usage:") ? error.message : "Evaluation failed; check the approved version and crawl run.");
  process.exitCode = 1;
});
