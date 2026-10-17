const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
require("./local-status.ts").main().catch(() => {
  console.error("Cannot read the local database. Stop the web server before running this command.");
  process.exitCode = 1;
});
