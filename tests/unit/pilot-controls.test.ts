import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProviderStop } from "../../src/lib/provider-stop";
import type { PGlite } from "@electric-sql/pglite";
import { seedChatDatabase } from "../helpers/chat-database";
import { businessRepository } from "../../src/lib/db/repository";
import { createSupabaseRpc, databaseRpc, PostgresProviderBudget, PostgresRateLimitStore, type Rpc } from "../../src/lib/shared-controls";
import { remoteBusinessData } from "../../src/lib/business-data";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { createChatRuntime } from "../../src/lib/chat-runtime";
import { pilotConfigurationIssues } from "../../src/lib/pilot-policy";
import { migrateDatabase } from "../../src/lib/db/client";
const A="00000000-0000-0000-0000-000000000001",B="00000000-0000-0000-0000-000000000002";
let db: PGlite;
const stopDirectory = mkdtempSync(join(tmpdir(), "ifd-stop-test-"));
const localStop = new LocalProviderStop(stopDirectory);
afterAll(() => rmSync(stopDirectory, { recursive: true, force: true }));
beforeAll(async()=>{db=await seedChatDatabase();},30000);
afterAll(async()=>{await db?.close();});
it("shares all-or-nothing limits between independent store objects on one PGlite connection",async()=>{
  const first=new PostgresRateLimitStore(databaseRpc(db)),second=new PostgresRateLimitStore(databaseRpc(db));
  expect(await first.consume([{key:`business:${A}`,limit:2},{key:"client:a",limit:1}],60000)).toBe(true);
  expect(await second.consume([{key:`business:${A}`,limit:2},{key:"client:a",limit:1}],60000)).toBe(false);
  expect(await second.consume([{key:`business:${A}`,limit:2},{key:"client:b",limit:1}],60000)).toBe(true);
  expect(await first.consume([{key:`business:${A}`,limit:2},{key:"client:c",limit:1}],60000)).toBe(false);
  expect(await second.consume([{key:`business:${B}`,limit:2},{key:"client:c",limit:1}],60000)).toBe(true);
  const rows=(await db.query<{key_hash:string}>("SELECT key_hash FROM rate_buckets")).rows;
  expect(rows.every(r=>/^[a-f0-9]{64}$/.test(r.key_hash))).toBe(true);
  await expect(first.consume([{key:"a",limit:1},{key:"a",limit:1}],60000)).rejects.toThrow();
  await expect(db.query("SELECT ifd_consume_rate(NULL,60000)")).rejects.toThrow("INVALID_RATE_INPUT");
  await expect(db.query("SELECT ifd_reserve_call(NULL)")).rejects.toThrow("INVALID_BUDGET");
  await expect(db.query("SELECT ifd_read(NULL,'list',NULL,NULL,NULL,NULL,NULL)")).rejects.toThrow("INVALID_READ_LIMIT");
  // This proves shared state / SQL behavior, not real multi-connection serialization.
  const accepted=await Promise.all(Array.from({length:12},(_,i)=>(i%2?first:second).consume([{key:"contention-fixture",limit:3}],60000)));
  expect(accepted.filter(Boolean)).toHaveLength(3);
  await db.query("UPDATE rate_buckets SET expires_at=now()-interval '1 second'");
  expect(await first.consume([{key:"contention-fixture",limit:3}],60000)).toBe(true);
});
it("a durable provider budget survives object restart and cannot be raised or replenished by config",async()=>{
  const first=new PostgresProviderBudget(databaseRpc(db), localStop);
  expect(await first.reserve(2)).toBe(true);
  expect(await new PostgresProviderBudget(databaseRpc(db), localStop).reserve(60)).toBe(true);
  expect(await first.reserve(60)).toBe(false);
  expect((await db.query<{used:number;call_limit:number}>("SELECT used,call_limit FROM pilot_budget")).rows[0]).toMatchObject({used:2,call_limit:2});
  await db.query("DELETE FROM pilot_budget");
  expect(await first.reserve(3)).toBe(true);await first.stop();
  expect(await new PostgresProviderBudget(databaseRpc(db), localStop).reserve(3)).toBe(false);
});
it("budgets reserve before any provider request and database failure prevents calls",async()=>{
  const transport=vi.fn(async()=>Response.json({}));
  const runtime=createChatRuntime({LOCAL_CHAT_MODE:"real",FREE_TIER_CONFIRMED:"yes",GEMINI_EVAL_API_KEY:"fixture-gemini",GROQ_EVAL_API_KEY:"fixture-groq"},transport,
    {reserve:async()=>false,stop:async()=>{}});
  await expect(runtime("gemini-embedding-001").embeddings.embed("hours")).rejects.toMatchObject({code:"FREE_TIER_EXHAUSTED"});
  expect(transport).not.toHaveBeenCalled();
  const broken=createChatRuntime({LOCAL_CHAT_MODE:"real",FREE_TIER_CONFIRMED:"yes",GEMINI_EVAL_API_KEY:"fixture",GROQ_EVAL_API_KEY:"fixture"},transport,
    {reserve:async()=>{throw Error("db secret");},stop:async()=>{}});
  await expect(broken("gemini-embedding-001").embeddings.embed("hours")).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
});
it("remote read SQL matches local search and confines every operation to one allowed business",async()=>{
  const rpc:Rpc=async <T>(name:string,args:Record<string,unknown>)=>{
    expect(name).toBe("ifd_read");
    return (await db.query<{value:T}>("SELECT ifd_read($1,$2,$3,$4,$5,$6::vector,$7) AS value",
      [args.scope,args.operation,args.slug_value??null,args.model_value??null,args.pattern_value??null,args.query_vector??null,args.result_limit??8])).rows[0].value;
  };
  const data=remoteBusinessData(rpc,[A]);expect(await data.find("maple-repair")).toBeNull();expect(await data.list()).toHaveLength(1);
  expect(()=>data.repository(B)).toThrow("outside");await expect(data.report(B)).rejects.toThrow();
  const local=businessRepository(db,A),remote=data.repository(A),embeddings=new FakeEmbeddings(),v=await embeddings.embed("hours");
  expect(await remote.getBusiness()).toEqual(await local.getBusiness());
  expect(await remote.listPageTexts()).toEqual(await local.listPageTexts());
  expect(await remote.searchChunks(v,embeddings.model,8)).toEqual(await local.searchChunks(v,embeddings.model,8));
  expect(await remote.searchChunksByPattern("hours",embeddings.model,3)).toEqual(await local.searchChunksByPattern("hours",embeddings.model,3));
  expect(await remote.searchChunksByHeading("hours",embeddings.model,8)).toEqual(await local.searchChunksByHeading("hours",embeddings.model,8));
  expect(await remote.listHomepageSummary(embeddings.model)).toEqual(await local.listHomepageSummary(embeddings.model));
  expect(await data.report(A)).toBeNull();
  await expect(remote.searchChunks(v,"wrong-space",8)).rejects.toThrow();
});
it("revokes public table/function access; anonymous callers cannot invoke privileged SQL",async()=>{
  await db.exec("CREATE ROLE ifd_anonymous_test NOLOGIN; SET ROLE ifd_anonymous_test;");
  try {
    await expect(db.query("SELECT * FROM chunks")).rejects.toThrow("permission denied");
    await expect(db.query("SELECT ifd_reserve_call(5)")).rejects.toThrow("permission denied");
    await expect(db.query("SELECT ifd_read(NULL,'list')")).rejects.toThrow("permission denied");
  } finally { await db.exec("RESET ROLE"); }
});
it("also removes explicit Supabase anonymous/authenticated grants after remigration",async()=>{
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; GRANT ALL ON chunks TO anon,authenticated; GRANT EXECUTE ON FUNCTION ifd_read(uuid,text,text,text,text,vector,integer),ifd_reserve_call(integer) TO anon,authenticated;");
  await migrateDatabase(db);
  for(const role of ["anon","authenticated"]){
    await db.exec(`SET ROLE ${role}`);
    try{await expect(db.query("SELECT * FROM chunks")).rejects.toThrow("permission denied");await expect(db.query("SELECT ifd_read(NULL,'list')")).rejects.toThrow("permission denied");}
    finally{await db.exec("RESET ROLE");}
  }
});
it("RPC transport has an exact public project endpoint, no redirects, bounded timeout and generic errors",async()=>{
  const key="fixture-service-role-key-not-real";
  const transport=vi.fn(async(_url:URL|RequestInfo,_init?:RequestInit)=>Response.json(true));
  const rpc=createSupabaseRpc({SUPABASE_URL:"https://fixture.supabase.co",SUPABASE_SERVICE_ROLE_KEY:key},transport);
  expect(await rpc("ifd_reserve_call",{max_calls:2})).toBe(true);
  expect(transport.mock.calls[0]?.[0]).toBeDefined();
  expect(transport).toHaveBeenCalledWith(expect.any(URL),expect.objectContaining({redirect:"error",signal:expect.any(AbortSignal)}));
  for(const url of ["http://fixture.supabase.co","https://127.0.0.1","https://fixture.supabase.co.attacker.test","https://fixture.supabase.co/evil"])
    expect(()=>createSupabaseRpc({SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key},transport)).toThrow();
  const broken=createSupabaseRpc({SUPABASE_URL:"https://fixture.supabase.co",SUPABASE_SERVICE_ROLE_KEY:key},async()=>Response.json({error:key}, {status:500}));
  await expect(broken("ifd_read",{})).rejects.toThrow("Shared database unavailable");
});
it("pilot configuration rejects permissive local settings and incomplete acceptance",()=>{
  expect(pilotConfigurationIssues({IFD_PILOT_MODE:"yes"})).toContain("Shared rate limits required");
  expect(pilotConfigurationIssues({})).toEqual(["Pilot mode is disabled"]);
});
