import { beforeAll, afterAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createChatHandler } from "../../src/lib/chat-handler";
import { ChatRateLimiter } from "../../src/lib/chat-limits";
import { seedChatDatabase } from "../helpers/chat-database";
import { estimateCost, summarizeMonitoring, type ChatEvent } from "../../src/lib/telemetry";
let db:PGlite;
beforeAll(async()=>{db=await seedChatDatabase();},30000);afterAll(async()=>{await db?.close();});
const request=(question="What are your hours?",headers:Record<string,string>={})=>new Request("http://localhost/api/chat",{method:"POST",headers,body:JSON.stringify({slug:"bright-salon",question})});
it("assigns its own request ID to successes and errors, and logs only metadata",async()=>{
  const events:ChatEvent[]=[];
  const handler=createChatHandler(async()=>db,new ChatRateLimiter(),undefined,undefined,{telemetry:e=>events.push(e)});
  const response=await handler(request("private-question-marker",{"x-request-id":"forged-id",cookie:"private-cookie-marker"}));
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  expect(events[0].requestId).toBe(response.headers.get("x-request-id"));
  const invalid=await handler(request(""));expect(invalid.status).toBe(400);expect(events[1].failureReason).toBe("invalid-request");
  const logged=JSON.stringify(events);for(const value of ["private-question-marker","private-cookie-marker","forged-id"])expect(logged).not.toContain(value);
  expect(events[0].totalMs).toBeGreaterThanOrEqual(0);expect(events[0].retrievalMs).not.toBeNull();
  expect(events[0].estimatedCostUsd).toBeNull();expect(events[0].costIncomplete).toBe(true);
  expect(summarizeMonitoring(events)).toMatchObject({requests:2,unknownCostRequests:2});
});
it("rejects cross-origin writes and fails closed when shared rate storage fails",async()=>{
  const events:ChatEvent[]=[];
  const limiter=new ChatRateLimiter(10,60,60000,{consume:async()=>{throw Error("secret-provider-detail");}});
  const handler=createChatHandler(async()=>db,limiter,undefined,undefined,{telemetry:e=>events.push(e)});
  expect((await handler(request("hours",{origin:"https://attacker.test"}))).status).toBe(403);
  const failed=await handler(request());expect(failed.status).toBe(503);expect(events[1].failureReason).toBe("rate-store-unavailable");
  expect(JSON.stringify(events)).not.toContain("secret-provider-detail");expect(await failed.text()).not.toContain("secret-provider-detail");
});
it("logging failures do not break the request and unknown model prices remain unknown",async()=>{
  expect((await createChatHandler(async()=>db,new ChatRateLimiter(),undefined,undefined,{telemetry:()=>{throw Error("sink");}})(request(""))).status).toBe(400);
  expect(estimateCost("gemini","gemini-3.5-flash-lite",1_000_000,1_000_000)).toBe(2.8);
  expect(estimateCost("groq","openai/gpt-oss-120b",1_000_000,1_000_000)).toBe(.75);
  expect(estimateCost("gemini","unknown",10,10)).toBeNull();expect(estimateCost("gemini","gemini-3.5-flash-lite",null,10)).toBeNull();
});
