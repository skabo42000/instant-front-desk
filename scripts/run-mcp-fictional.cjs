// Start the fictional API and the real stdio adapter in one disposable process.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
process.chdir(path.join(__dirname, ".."));
if (process.argv.includes("--print-config")) {
  console.log(JSON.stringify({ mcpServers: { "ifd-fictional": { command: process.execPath,
    args: ["--conditions=react-server", path.join(__dirname, "run-mcp-fictional.cjs")] } } }, null, 2));
  return;
}
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
require("./mcp-fictional-stdio.ts").main().catch(() => {
  console.error("Fictional MCP startup failed; no private details logged.");
  process.exitCode = 1;
});
