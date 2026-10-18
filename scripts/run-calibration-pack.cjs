const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
};
const mode = process.argv[2];
const main = require("./calibration-pack.ts")[mode === "compare" ? "compareMain" : "packMain"];
main(process.argv.slice(3)).catch(error => {
  console.error("Calibration failed: " + error.message);
  process.exitCode = 1;
});
