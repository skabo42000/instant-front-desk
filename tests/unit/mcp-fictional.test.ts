import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fixture from "../fixtures/mcp-maple-street-dental.json";
import { assertFictionalEnvironment, createFictionalDatabase } from "../../scripts/mcp-fictional-api";
import { authenticatedMcpRequest } from "../helpers/mcp-auth";
import { createMcpReadHandler } from "../../src/lib/mcp/api";
// The runner is a standalone Node module, deliberately outside the TS application.
// @ts-expect-error Standalone .mjs has no declaration file.
import { privateEnvironment, stopChild, verifyEvents } from "../../scripts/demo-mcp-fictional.mjs";

let db: Awaited<ReturnType<typeof createFictionalDatabase>>;
let handler: ReturnType<typeof createMcpReadHandler>;
const token="fictional-unit-test-secret-12345678901234567890";
beforeAll(async()=>{
  db=await createFictionalDatabase();
  handler=createMcpReadHandler(async()=>db,{IFD_MCP_ENABLED:"yes",IFD_MCP_TOKEN:token,IFD_MCP_BUSINESS_IDS:fixture.business.businessId});
});
afterAll(async()=>{await db?.close();});
async function call(name:string,args:unknown={}) {
  return handler(await authenticatedMcpRequest(handler,name,args,token),name);
}
it("loads only the fictional business, invented report and saved content; reads leave all records unchanged",async()=>{
  const tables=["businesses","crawl_runs","pages","chunks","question_lists","eval_questions","eval_runs","eval_results","model_requests"];
  const snapshot=async()=>Promise.all(tables.map(table=>db.query(`SELECT * FROM ${table}`)));
  const before=await snapshot();
  const list=await (await call("list_businesses")).json();
  expect(list.businesses).toEqual([fixture.business]);
  expect(fixture.fictional).toBe(true);expect(fixture.business.sourceUrl).toBe("https://maple-street-dental.test");
  expect(fixture.dateNote).toContain("invented example date");
  const b=await (await call("get_business",{businessId:fixture.business.businessId})).json();
  expect(b.business).toMatchObject({...fixture.business,pageCount:1,chunkCount:1});
  const r=await (await call("get_evaluation_report",{businessId:fixture.business.businessId})).json();
  expect(r.report).toMatchObject({id:fixture.report.id,total:3,passed:1,failed:2,errors:1});
  expect(r.report.failures[0].reason).toContain("Saturday hours");
  expect(r.report.failures[1].error).toBe("JUDGE_EXECUTION_ERROR");
  expect((await call("get_business",{businessId:"00000000-0000-0000-0000-000000000999"})).status).toBe(404);
  expect(await snapshot()).toEqual(before);
});
it("refuses saved database/model settings before opening a database and strips inherited settings",async()=>{
  for(const key of ["IFD_DATABASE_DIR","DATABASE_URL","GEMINI_EVAL_API_KEY","MODEL_MODE","IFD_OUTPUT_ROOT"]) {
    expect(()=>assertFictionalEnvironment({[key]:"must-not-read"})).toThrow();
    await expect(createFictionalDatabase({[key]:"must-not-read"})).rejects.toThrow();
  }
  expect(privateEnvironment({PATH:"/bin",HOME:"/fictional-home",NODE_OPTIONS:"--require hostile",IFD_DATABASE_DIR:"private",GEMINI_EVAL_API_KEY:"private",IFD_MCP_TOKEN:"private"}))
    .toEqual({PATH:"/bin",HOME:"/fictional-home"});
});
it("discards the in-memory database on cleanup",async()=>{
  const isolated=await createFictionalDatabase();
  await isolated.close();
  await expect(isolated.query("SELECT 1")).rejects.toThrow();
},30000);
it.each(["success","failure","timeout"])("stops child process groups on %s",async(mode)=>{
  const child=spawn(process.execPath,["-e",mode==="success"?"process.exit(0)":mode==="failure"?"process.exit(1)":"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    {detached:true,env:privateEnvironment(process.env),stdio:"ignore"});
  await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});
  await new Promise(resolve=>setTimeout(resolve,100));
  await stopChild(child);
  expect(()=>process.kill(child.pid!,0)).toThrow();
},10000);
it.runIf(process.platform === "win32")("stops a live Windows child's descendants",async()=>{
  const child=spawn(process.execPath,["-e","const {spawn}=require('node:child_process'); const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.send(grandchild.pid); setInterval(()=>{},1000)"],
    {detached:true,env:privateEnvironment(process.env),stdio:["ignore","ignore","ignore","ipc"]});
  let descendant:number|undefined;
  try {
    descendant=await new Promise<number>((resolve,reject)=>{child.once("message",pid=>resolve(Number(pid)));child.once("error",reject);});
    await stopChild(child);
    expect(()=>process.kill(child.pid!,0)).toThrow();
    expect(()=>process.kill(descendant!,0)).toThrow();
  } finally {
    await stopChild(child);
    if(descendant)try{process.kill(descendant,"SIGKILL");}catch{ /* Already stopped. */ }
  }
},10000);
it("fails verification for absent calls, unrelated tools, foreign IDs and wrong totals",()=>{
  expect(()=>verifyEvents([])).toThrow();
  const event=(tool:string,args:unknown,result:unknown)=>({type:"item.completed",item:{type:"mcp_tool_call",server:"ifd",tool,arguments:args,status:"completed",result:{structured_content:result}}});
  const events=[
    event("list_businesses",{},{businesses:[fixture.business]}),
    event("get_business",{businessId:fixture.business.businessId},{business:{...fixture.business,pageCount:1,chunkCount:1}}),
    event("get_evaluation_report",{businessId:fixture.business.businessId},{businessId:fixture.business.businessId,report:{...fixture.report,snapshotId:fixture.report.crawlRunId,at:fixture.report.createdAt,total:3,passed:1,failed:2,errors:1,failures:fixture.report.results.slice(1).map(r=>({questionId:r.question.id,question:r.question.question,answer:r.answer.text,reason:r.verdict?.reason ?? null,error:r.error}))}}),
    {type:"item.completed",item:{type:"agent_message",text:`Fictional saved example ${fixture.business.businessId}, report ${fixture.report.id}: Saturday omitted; judge execution error. This is not calibrated accuracy or production readiness.`}},
  ];
  expect(verifyEvents(events)).toMatchObject({total:3,passed:1,failed:2,errors:1});
  for(const mutate of [
    (e:typeof events)=>{if("tool" in e[0].item)e[0].item.tool="shell";},
    (e:typeof events)=>{if("arguments" in e[1].item)e[1].item.arguments={businessId:"00000000-0000-0000-0000-000000000999"};},
    (e:typeof events)=>{if("result" in e[2].item)e[2].item.result.structured_content={businessId:fixture.business.businessId,report:{...fixture.report,total:0}};},
  ]) {const changed=structuredClone(events);mutate(changed);expect(()=>verifyEvents(changed)).toThrow();}
});
