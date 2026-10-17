// Scripted SDK/stdio/HTTP check. This is not an assistant selecting tools.
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
let stage="startup";
async function main() {
  const ids=(process.env.IFD_MCP_BUSINESS_IDS||"").split(",").map(v=>v.trim()).filter(Boolean);
  assert.ok(ids.length,"Configure approved business IDs first");
  const env={...process.env};
  for(const key of Object.keys(env))if(!key.startsWith("IFD_MCP_")&&!['PATH','HOME','SystemRoot'].includes(key))delete env[key];
  const client=new Client({name:"ifd-scripted-smoke",version:"0.1.0"});
  const transport=new StdioClientTransport({command:process.execPath,args:["scripts/run-mcp.cjs"],cwd:process.cwd(),env,stderr:"pipe"});
  try {
    stage="stdio connection";
    await client.connect(transport);
    stage="tool discovery";
    const names=(await client.listTools()).tools.map(t=>t.name).sort();
    assert.deepEqual(names,["get_business","get_evaluation_report","list_businesses"]);
    async function call(name,args) {stage=name;const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,`${name} failed`);assert.ok(result.structuredContent);return result.structuredContent;}
    const listed=await call("list_businesses",{limit:10});
    assert.ok(listed.businesses.every(b=>ids.includes(b.businessId)));
    const reports=[];
    for(const businessId of ids) {
      const b=await call("get_business",{businessId});assert.equal(b.business.businessId,businessId);
      const r=await call("get_evaluation_report",{businessId,limit:1});assert.equal(r.businessId,businessId);
      if(r.report)assert.equal(r.report.passed+r.report.failed,r.report.total);
      reports.push({businessId,pageCount:b.business.pageCount,chunkCount:b.business.chunkCount,report:r.report?{
        id:r.report.id,at:r.report.at,total:r.report.total,passed:r.report.passed,failed:r.report.failed,errors:r.report.errors,reportKind:r.report.reportKind}:null});
    }
    console.log(JSON.stringify({at:new Date().toISOString(),transport:"SDK stdio -> loopback HTTP -> app-owned PGlite",tools:names,reports,modelCalls:0,agentDemonstration:false}));
  } finally {await client.close();await transport.close();}
}
main().catch(()=>{console.error(`MCP stage: ${stage}`);console.error("MCP smoke failed; check configuration and app availability. No report bodies or secrets logged.");process.exitCode=1;});
