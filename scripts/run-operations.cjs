const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
require("./operations.ts").main(process.argv.slice(2)).catch(() => {
  console.error("Operational check failed; inspect configuration and input format. Raw exceptions are intentionally omitted.");
  process.exitCode = 1;
});
