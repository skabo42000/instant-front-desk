import "server-only";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { contracts, MAX_RESPONSE_BYTES, mcpSettings, toolName, newNonce, validNonce, mcpProof, sameProof, type ToolName } from "./contracts";
import { latestReport } from "../eval/runner";

class ReadError extends Error { constructor(readonly status:number){super("MCP read rejected");} }
export function createMcpReadHandler(getDb:()=>Promise<PGlite>, env:Readonly<Record<string,string|undefined>>,
  chat?: (request: Request) => Promise<Response>) {
  // One-use challenges are bounded and expire within the adapter deadline.
  const pending=new Map<string,{proof:string;expires:number}>();
  // One stable client bucket per MCP handler, in addition to the shared business bucket.
  const clientId = randomUUID();
  return async (request:Request, name:string):Promise<Response> => {
    const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    if(env.IFD_MCP_ENABLED!=="yes" || env.IFD_PILOT_MODE==="yes")return reply({error:"Unavailable"},404);
    try {
      const config=mcpSettings(env);
      if(request.method!=="POST")throw new ReadError(405);
      // Next reconstructs Request.url with localhost internally; validate the actual HTTP Host.
      if(request.headers.get("host")!==new URL(config.origin).host || request.headers.has("origin") ||
        ![null,"none","same-origin"].includes(request.headers.get("sec-fetch-site")))throw new ReadError(403);
      if(!toolName(name))throw new ReadError(404);
      if(!request.headers.get("content-type")?.startsWith("application/json"))throw new ReadError(400);
      // Read incrementally: Content-Length alone cannot bound chunked requests.
      const reader=request.body?.getReader();let bytes=0;const parts:Uint8Array[]=[];
      if(reader)try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>4096){await reader.cancel();throw new ReadError(413);}parts.push(r.value);}}finally{reader.releaseLock();}
      const body=Buffer.concat(parts).toString("utf8");
      const clientNonce=request.headers.get("x-ifd-mcp-nonce")||"";
      if(!validNonce(clientNonce))throw new ReadError(401);
      const serverNonce=request.headers.get("x-ifd-mcp-challenge")||"";
      const context=[config.origin,name,body,clientNonce,serverNonce];
      if(request.headers.get("x-ifd-mcp-phase")==="challenge") {
        const now=Date.now();
        for(const [nonce,entry] of pending)if(entry.expires<=now)pending.delete(nonce);
        if(pending.size>=256)throw new ReadError(503);
        const nonce=newNonce();context[4]=nonce;
        pending.set(nonce,{proof:mcpProof(config.token,"client",context),expires:now+5000});
        return reply({nonce,proof:mcpProof(config.token,"server",context)});
      }
      const entry=pending.get(serverNonce);
      // Consume before any await or database access, including failed authentication.
      pending.delete(serverNonce);
      if(!entry || entry.expires<=Date.now() || !sameProof(request.headers.get("x-ifd-mcp-proof")||"",entry.proof) ||
        !sameProof(entry.proof,mcpProof(config.token,"client",context)))throw new ReadError(401);
      const raw=JSON.parse(body||"{}");
      const parsed=contracts[name].input.safeParse(raw);if(!parsed.success)throw new ReadError(400);
      const args=parsed.data as {businessId?:string;question?:string;limit?:number;cursor?:number;reportId?:string};
      if(args.businessId&&!config.allowed.includes(args.businessId))throw new ReadError(404);
      const db=await getDb();
      let output: unknown;
      if (name === "ask_business") {
        const business = (await db.query<{slug:string}>("SELECT slug FROM businesses WHERE business_id=$1", [args.businessId])).rows[0];
        if (!business) throw new ReadError(404);
        if (!chat) throw new ReadError(503);
        // Reuse chat's retrieval, answer checks, provider reservations and shared rate limits.
        // No client-supplied cookies, URLs or provider settings cross this boundary.
        const response = await chat(new Request(`${config.origin}/api/chat`, { method: "POST",
          headers: { "content-type": "application/json", cookie: `ifd-client=${clientId}` },
          body: JSON.stringify({ slug: business.slug, question: args.question }) }));
        if (!response.ok) throw new ReadError(response.status);
        output = { businessId: args.businessId, ...await response.json() };
      } else output=await readTool(db,name,args,config.allowed);
      const validated=contracts[name].output.parse(output);
      if(Buffer.byteLength(JSON.stringify(validated))>MAX_RESPONSE_BYTES)throw new ReadError(413);
      const result=JSON.stringify(validated);
      return new Response(result,{headers:{"content-type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
        "x-ifd-mcp-proof":mcpProof(config.token,"result",[...context,result])}});
    } catch(error) { return reply({error:"MCP read unavailable"},error instanceof ReadError?error.status:error instanceof SyntaxError?400:503); }
  };
}
async function readTool(db:PGlite,name:ToolName,args:{businessId?:string;limit?:number;cursor?:number;reportId?:string},allowed:string[]) {
  let truncated=false;
  const clip=(value:string|null|undefined,limit=2000)=>{if(value==null)return null;if(value.length>limit)truncated=true;return value.slice(0,limit);};
  const business=(b:{businessId:string;name:string;slug:string;sourceUrl:string})=>({...b,name:clip(b.name,200)!,slug:clip(b.slug,200)!});
  const limit=args.limit??10,offset=args.cursor??0;
  if(name==="list_businesses") {
    const rows=(await db.query<{businessId:string;name:string;slug:string;sourceUrl:string}>(`SELECT business_id AS "businessId",name,slug,source_url AS "sourceUrl" FROM businesses WHERE business_id=ANY($1::uuid[]) ORDER BY business_id LIMIT $2 OFFSET $3`,[allowed,limit+1,offset])).rows;
    return {businesses:rows.slice(0,limit).map(business),nextCursor:rows.length>limit?offset+limit:null,truncated};
  }
  const id=args.businessId!;
  const b=(await db.query<{businessId:string;name:string;slug:string;sourceUrl:string}>(`SELECT business_id AS "businessId",name,slug,source_url AS "sourceUrl" FROM businesses WHERE business_id=$1`,[id])).rows[0];
  if(!b)throw new ReadError(404);
  if(name==="get_business") {
    const counts=(await db.query<{pageCount:number;chunkCount:number;latestCrawlAt:string|null}>(`SELECT (SELECT count(*)::int FROM pages WHERE business_id=$1) AS "pageCount",(SELECT count(*)::int FROM chunks WHERE business_id=$1) AS "chunkCount",(SELECT max(finished_at)::text FROM crawl_runs WHERE business_id=$1 AND status='completed') AS "latestCrawlAt"`,[id])).rows[0];
    return {business:{...business(b),...counts},truncated};
  }
  const saved=await latestReport(db,id);
  const evidenceScope="Saved evaluation only; not current service health or calibrated accuracy.";
  if(!saved)return {businessId:id,report:null,truncated,evidenceScope};
  if(saved.businessId!==id)throw new ReadError(503);
  if(args.reportId&&args.reportId!==saved.id)throw new ReadError(409);
  const failures=saved.results.filter(r=>!!r.error||r.verdict?.pass!==true);
  const detail=failures.slice(offset,offset+limit).map(r=>({questionId:r.question.id,question:clip(r.question.question)!,answer:clip(r.answer?.text),reason:clip(r.verdict?.reason),
    error:r.error?(/^[A-Z_]{3,100}$/.test(r.error)?r.error:"EXECUTION_ERROR"):null}));
  return {businessId:id,report:{id:saved.id,at:saved.createdAt,questionVersion:saved.questionVersion,snapshotId:saved.crawlRunId,
    answerModel:clip(saved.answerModel,200),judgeModel:clip(saved.judgeModel,200),answerPromptVersion:clip(saved.answerPromptVersion,200),judgePromptVersion:clip(saved.judgePromptVersion,200),
    reportKind:"legacy-single-verdict",total:saved.results.length,passed:saved.results.length-failures.length,failed:failures.length,errors:saved.results.filter(r=>!!r.error).length,
    failures:detail,nextCursor:failures.length>offset+limit?offset+limit:null},truncated,evidenceScope};
}
