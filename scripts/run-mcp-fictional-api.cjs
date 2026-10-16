// Load the isolated TypeScript service without starting Next or reading .env.local.
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText,filename);
require("./mcp-fictional-api.ts").main().catch(()=>{
  console.error("Fictional MCP service failed; no private details logged.");
  process.exitCode=1;
});
