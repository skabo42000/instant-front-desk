const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
require("./questions.ts").main(process.argv.slice(2)).catch(error => {
  console.error(error.message.startsWith("Usage:") ? error.message : "Question command failed; check the business, version and replacement file.");
  process.exitCode = 1;
});
