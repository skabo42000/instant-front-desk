import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/lib/db/client";
import { createMcpReadHandler } from "../src/lib/mcp/api";
import fixture from "../tests/fixtures/mcp-maple-street-dental.json";

type DemoEnvironment = Readonly<Record<string,string|undefined>>;
export function assertFictionalEnvironment(env: DemoEnvironment) {
  // Never silently substitute a saved database or load local configuration.
  if (Object.keys(env).some(key => /DATABASE|DATA_DIR|MODEL|API_KEY|OUTPUT_ROOT/.test(key))) {
    throw Error("Fictional demo rejects database and model settings");
  }
}

export async function createFictionalDatabase(env: DemoEnvironment = {}) {
  assertFictionalEnvironment(env);
  const db = await openDatabase();
  try {
    const b = fixture.business, r = fixture.report, at = r.createdAt;
    await db.query(`INSERT INTO businesses (business_id,id,slug,name,source_url,embedding_model)
      VALUES ($1,$1,$2,$3,$4,'fictional-example')`, [b.businessId,b.slug,b.name,b.sourceUrl]);
    await db.query(`INSERT INTO crawl_runs (business_id,id,status,started_at,finished_at)
      VALUES ($1,$2,'completed',$3,$3)`, [b.businessId,r.crawlRunId,at]);
    const pageId = randomUUID();
    await db.query(`INSERT INTO pages (business_id,id,crawl_run_id,url,title,clean_text,content_hash,fetched_at)
      VALUES ($1,$2,$3,$4,'Fictional example',$5,'fictional-example',$6)`,
      [b.businessId,pageId,r.crawlRunId,b.sourceUrl,fixture.content,at]);
    await db.query(`INSERT INTO chunks (business_id,id,page_id,ordinal,heading,text,embedding,embedding_model,content_hash)
      VALUES ($1,$2,$3,0,'Fictional example',$4,$5::vector,'fictional-example','fictional-example')`,
      [b.businessId,randomUUID(),pageId,fixture.content,JSON.stringify(Array(768).fill(0))]);
    await db.query(`INSERT INTO question_lists (business_id,version,created_at,approved_at) VALUES ($1,1,$2,$2)`,[b.businessId,at]);
    for (const entry of r.results) await db.query(`INSERT INTO eval_questions
      (business_id,id,version,kind,question,expected_behavior,approved_at)
      VALUES ($1,$2,1,'source',$3,'Fictional example only',$4)`,[b.businessId,entry.question.id,entry.question.question,at]);
    await db.query(`INSERT INTO eval_runs (business_id,id,question_version,crawl_run_id,answer_model,judge_model,prompt_version,started_at,status,report)
      VALUES ($1,$2,1,$3,$4,$5,'fictional-example',$6,'completed_with_errors',$7::jsonb)`,
      [b.businessId,r.id,r.crawlRunId,r.answerModel,r.judgeModel,at,JSON.stringify(r)]);
    return db;
  } catch (error) { await db.close(); throw error; }
}

export async function startFictionalApi(env: DemoEnvironment) {
  const db = await createFictionalDatabase(env);
  const settings: Record<string,string|undefined> = {...env, IFD_MCP_ENABLED:"yes", IFD_MCP_BUSINESS_IDS:fixture.business.businessId};
  let handler: ReturnType<typeof createMcpReadHandler>;
  const server = createServer(async (req,res) => {
    try {
      const parts: Buffer[] = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 4096) { res.writeHead(413).end(); return; }
        parts.push(part);
      }
      const headers = new Headers();
      for (const [key,value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key,Array.isArray(value)?value.join(","):value);
      const request = new Request(`${settings.IFD_MCP_ORIGIN}${req.url}`, {
        method:req.method,headers,...(["GET","HEAD"].includes(req.method || "GET")?{}:{body:Buffer.concat(parts)}),
      });
      const response = await handler(request,req.url?.split("/").pop() || "");
      res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(400).end(); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No loopback address");
    settings.IFD_MCP_ORIGIN = `http://127.0.0.1:${address.port}`;
    handler = createMcpReadHandler(async()=>db,settings);
    let closing: Promise<void> | undefined;
    return {origin:settings.IFD_MCP_ORIGIN, db, close:()=>closing ??= (async()=>{
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await db.close();
    })()};
  } catch (error) { server.close(); await db.close(); throw error; }
}

export async function main() {
  const api = await startFictionalApi(process.env);
  const stop = () => { void api.close().then(()=>process.exit(0),()=>process.exit(1)); };
  process.once("SIGTERM",stop); process.once("SIGINT",stop);
  process.send?.({origin:api.origin});
}
