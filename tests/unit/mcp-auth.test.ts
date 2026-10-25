import { expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../../src/lib/mcp/adapter";
import { createMcpReadHandler } from "../../src/lib/mcp/api";
import { mcpProof, newNonce } from "../../src/lib/mcp/contracts";
import { authenticatedMcpRequest } from "../helpers/mcp-auth";

const env={IFD_MCP_ENABLED:"yes",IFD_MCP_TOKEN:"synthetic-security-test-secret-1234567890",IFD_MCP_BUSINESS_IDS:"00000000-0000-0000-0000-000000000001"};
const origin="http://127.0.0.1:3000",name="list_businesses";
const output={businesses:[],nextCursor:null,truncated:false};
const forged={...output,businesses:[{businessId:env.IFD_MCP_BUSINESS_IDS,name:"Forged",slug:"forged",sourceUrl:"https://fictional.test"}]};
function api() {
  const query=vi.fn(async()=>({rows:[]}));
  const getDb=vi.fn(async()=>({query}) as unknown as PGlite);
  return {handler:createMcpReadHandler(getDb,env),getDb,query};
}
function wire(input:Parameters<typeof fetch>[0],init?:RequestInit) {
  const headers=new Headers(init?.headers);headers.set("host","127.0.0.1:3000");
  return new Request(String(input),{...init,headers});
}
async function connect(transport:typeof fetch) {
  const server=createMcpServer(env,transport),client=new Client({name:"security-test",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);
  return {call:()=>client.callTool({name,arguments:{}}),close:async()=>{await client.close();await server.close();}};
}

it.each(["forged-result","forged-proof"])("impostor receives no reusable credential and cannot return %s",async(mode)=>{
  const captured:Request[]=[];
  const c=await connect(async(input,init)=>{
    captured.push(wire(input,init));
    return Response.json(mode==="forged-result"?forged:{nonce:newNonce(),proof:"0".repeat(64)});
  });
  try {
    for(let i=0;i<2;i++)expect((await c.call()).isError).toBe(true);
    expect(captured).toHaveLength(2); // No client proof is sent after the impostor's response.
    expect(captured[0].headers.get("x-ifd-mcp-nonce")).not.toBe(captured[1].headers.get("x-ifd-mcp-nonce"));
    const real=api();
    for(const request of captured) {
      expect(request.headers.has("x-ifd-mcp-token")).toBe(false);
      expect(request.headers.has("x-ifd-mcp-proof")).toBe(false);
      expect(JSON.stringify([...request.headers])+await request.clone().text()).not.toContain(env.IFD_MCP_TOKEN);
      // Replaying the public challenge yields only another challenge, never tool data.
      const response=await real.handler(request.clone(),name);
      expect(await response.json()).not.toHaveProperty("businesses");
      const headers=new Headers(request.headers);headers.delete("x-ifd-mcp-phase");
      expect((await real.handler(new Request(request,{headers}),name)).status).toBe(401);
    }
    expect(real.getDb).not.toHaveBeenCalled();
  } finally {await c.close();}
});

it.each(["tampered-result","replayed-result","replayed-challenge"])("rejects %s even when an impostor relays a genuine challenge",async(mode)=>{
  const real=api();let saved:Response|undefined;
  const c=await connect(async(input,init)=>{
    const req=wire(input,init),challenge=req.headers.get("x-ifd-mcp-phase")==="challenge";
    if(mode==="replayed-challenge"&&challenge&&saved)return saved.clone();
    const response=await real.handler(req,name);
    if(challenge) {
      if(mode==="replayed-challenge")saved=response.clone();
      return response;
    }
    if(mode==="tampered-result")return Response.json(forged,{headers:response.headers});
    if(mode==="replayed-result") {
      if(saved)return saved.clone();
      saved=response.clone();
    }
    return response;
  });
  try {
    expect((await c.call()).isError).toBe(mode==="tampered-result"?true:undefined);
    expect((await c.call()).isError).toBe(true);
  } finally {await c.close();}
});

it("accepts a client proof only once and only for its exact tool, body and role",async()=>{
  const real=api();
  const req=await authenticatedMcpRequest(real.handler,name,{},env.IFD_MCP_TOKEN);
  expect((await real.handler(req.clone(),name)).status).toBe(200);
  expect((await real.handler(req,name)).status).toBe(401);
  for(const change of ["body","tool","role"]) {
    const signed=await authenticatedMcpRequest(real.handler,name,{},env.IFD_MCP_TOKEN);
    const headers=new Headers(signed.headers);
    if(change==="role")headers.set("x-ifd-mcp-proof",mcpProof(env.IFD_MCP_TOKEN,"server",[origin,name,"{}",headers.get("x-ifd-mcp-nonce")!,headers.get("x-ifd-mcp-challenge")!]));
    const modified=new Request(signed,{headers,...(change==="body"?{body:'{"limit":1}'}:{})});
    expect((await real.handler(modified,change==="tool"?"get_business":name)).status).toBe(401);
  }
  expect(real.query).toHaveBeenCalledTimes(1);
});

it("expires challenges and bounds unauthenticated challenge storage",async()=>{
  const real=api();const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now);
  try {
    const req=await authenticatedMcpRequest(real.handler,name,{},env.IFD_MCP_TOKEN);
    clock.mockReturnValue(now+5001);
    expect((await real.handler(req,name)).status).toBe(401);
    const request=()=>new Request(`${origin}/api/mcp/${name}`,{method:"POST",body:"{}",headers:{host:"127.0.0.1:3000","content-type":"application/json","x-ifd-mcp-phase":"challenge","x-ifd-mcp-nonce":newNonce()}});
    for(let i=0;i<256;i++)expect((await real.handler(request(),name)).status).toBe(200);
    expect((await real.handler(request(),name)).status).toBe(503);
    clock.mockReturnValue(now+10002);
    expect((await real.handler(request(),name)).status).toBe(200);
    expect(real.getDb).not.toHaveBeenCalled();
  } finally {clock.mockRestore();}
});

it.each([{}, {IFD_MCP_ENABLED:"no"}, {IFD_MCP_ENABLED:"yes",IFD_PILOT_MODE:"yes"}])("keeps challenge and tool endpoints unavailable in disabled/pilot modes: %j",async(settings)=>{
  const getDb=vi.fn();const handler=createMcpReadHandler(getDb,{...env,IFD_MCP_ENABLED:undefined,...settings});
  for(const phase of ["challenge",""]) {
    const request=new Request(`${origin}/api/mcp/${name}`,{method:"POST",headers:{"x-ifd-mcp-phase":phase},body:"{}"});
    expect((await handler(request,name)).status).toBe(404);
  }
  expect(getDb).not.toHaveBeenCalled();
});
