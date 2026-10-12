import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { outputPath } from "../../src/lib/output-path";
import type { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { FakeQuestionGenerator, questionRepository } from "../../src/lib/eval/questions";
import { FakeJudge, latestReport, runEvaluation, scoreReport, type Judge } from "../../src/lib/eval/runner";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { FakeModel } from "../../src/lib/models/fake";
import { ModelGateway } from "../../src/lib/models/gateway";
import type { AnswerResult } from "../../src/lib/answer";
import { GeminiAnswer } from "../../src/lib/models/providers";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const A=id(901), B=id(902), RUN=id(903), PAGE=id(904), CHUNK=id(905);
let db: PGlite, version: number;
beforeAll(async () => {
  db = await openDatabase();
  const repo = businessRepository(db,A), embeddings = new FakeEmbeddings();
  await repo.createBusiness({ slug:"eval-fixture",name:"Fixture",sourceUrl:"https://fixture.invalid",phone:null,contactUrl:null,embeddingModel:embeddings.model });
  await repo.createCrawlRun(RUN,"completed");
  await repo.createPage({id:PAGE,crawlRunId:RUN,url:"https://fixture.invalid",title:"Haircuts",cleanText:"Haircuts available.",contentHash:"v1"});
  await repo.createChunk({id:CHUNK,pageId:PAGE,ordinal:0,heading:"Haircuts",text:"Haircuts available.",embedding:await embeddings.embed("Haircuts available."),embeddingModel:embeddings.model,contentHash:"v1"});
  version=(await questionRepository(db,A).generate(new FakeQuestionGenerator([{question:"Haircuts?",expectedBehavior:"Cite haircuts",evidenceChunkIds:[CHUNK]}]))).version;
},30000);
afterAll(async()=>{ await db?.close(); });
it("refuses unapproved versions and another business before any calls",async()=>{
  const generate=vi.fn();
  await expect(runEvaluation(db,A,version,{crawlRunId:RUN,judge:new FakeJudge([]),answerQuestion:generate})).rejects.toThrow("approved");
  await expect(runEvaluation(db,B,version,{crawlRunId:RUN,judge:new FakeJudge([]),answerQuestion:generate})).rejects.toThrow("not found");
  expect(generate).not.toHaveBeenCalled();
  await questionRepository(db,A).approve(version);
});
it("fixed seven-question fixture yields exactly 4/7; stores every failure, full report and generic errors",async()=>{
  let n=0;
  const judge=new FakeJudge([{pass:true,reason:"supported"},{pass:false,reason:"unsupported"},new Error("synthetic-secret"),
    {pass:true,reason:"refusal"},{pass:true,reason:"refusal"},{pass:true,reason:"refusal"}]);
  const report=await runEvaluation(db,A,version,{crawlRunId:RUN,judge,answerQuestion:async()=> {
    n++;
    return {kind:"refusal",text:"No answer on the site",citations:[],answerFamily:"gemini",
      logs:n===4 ? [{provider:"fake",model:"fixture",attempt:1,status:"error",latencyMs:0,inputTokens:null,outputTokens:null,estimatedCost:null}] : []};
  }});
  expect(scoreReport(report)).toMatchObject({passed:4,total:7});
  expect(scoreReport(report).failures).toHaveLength(3);
  expect(report.results.filter(r=>r.error)).toHaveLength(2);
  expect(report.results.filter(r=>r.error).every(r=>r.verdict===null)).toBe(true);
  expect(report.answerPromptVersion).toBeTruthy(); expect(report.judgePromptVersion).toBeTruthy();
  expect(await latestReport(db,A)).toEqual(report); expect(await latestReport(db,B)).toBeNull();
  const saved=await readFile(outputPath("data/eval-reports", `${report.id}.json`),"utf8");
  expect(saved).not.toContain("synthetic-secret"); expect(JSON.parse(saved).score).toMatchObject({passed:4,total:7});
  expect((await db.query("SELECT * FROM eval_results WHERE business_id=$1 AND eval_run_id=$2",[A,report.id])).rows).toHaveLength(7);
});
it("actual answer engine runs, preserving citations, models and family; rejects same-family fallback judging",async()=>{
  const spy=vi.fn(async()=>({pass:true,reason:"supported"}));
  const judge:Judge={provider:"groq",model:"openai/gpt-oss-fixture",family:"openai-oss",judge:spy};
  const gateway=new ModelGateway({primary:{provider:"fake-gemini",model:"fixture-answer",family:"gemini",adapter:new FakeModel([{text:"Haircuts available.",citedChunkIds:[CHUNK]}])},retry:false});
  const report=await runEvaluation(db,A,version,{crawlRunId:RUN,judge,gateway});
  const supported=report.results.find(r=>r.question.kind==="source")!;
  expect(supported.answer).toMatchObject({kind:"answer",answerFamily:"gemini",citations:[{id:CHUNK}]});
  expect(supported.answer?.logs[0].model).toBe("fixture-answer");
  spy.mockClear();
  const blocked=await runEvaluation(db,A,version,{crawlRunId:RUN,judge,answerQuestion:async()=>({kind:"refusal",text:"unsupported",citations:[],logs:[],answerFamily:"openai-oss"})});
  expect(spy).not.toHaveBeenCalled(); expect(scoreReport(blocked)).toMatchObject({passed:0,total:7});
  expect(blocked.results.every(r=>r.error)).toBe(true);
});
it("exhaustion stops the whole run and remaining calls never pass",async()=>{
  const call=vi.fn(async():Promise<AnswerResult>=>({kind:"refusal",text:"No answer",citations:[],logs:[{provider:"gemini",model:"fixture",attempt:1,status:"error",errorCode:"FREE_TIER_EXHAUSTED",latencyMs:0,inputTokens:null,outputTokens:null,estimatedCost:null}]}));
  const report=await runEvaluation(db,A,version,{crawlRunId:RUN,judge:new FakeJudge([]),answerQuestion:call});
  expect(call).toHaveBeenCalledTimes(1); expect(scoreReport(report)).toMatchObject({passed:0,total:7});
  expect(report.results.slice(1).every(r=>r.error==="FREE_TIER_STOPPED")).toBe(true);
});
it("real adapter failures and echoed synthetic keys cannot pass or enter saved reports/logs",async()=>{
  const key="synthetic-private-key";
  const adapter=new GeminiAnswer(key,async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({text:key,citedChunkIds:[CHUNK]})}]}}]})));
  const logs:unknown[]=[];
  const gateway=new ModelGateway({primary:{provider:"gemini",model:adapter.model,family:adapter.family,adapter},retry:false,onLog:log=>logs.push(log)});
  const report=await runEvaluation(db,A,version,{crawlRunId:RUN,gateway,judge:new FakeJudge(Array.from({length:7},()=>({pass:true,reason:"policy refusal"})))});
  const source=report.results.find(r=>r.question.kind==="source")!;
  expect(source.error).toBe("ANSWER_EXECUTION_ERROR"); expect(source.verdict).toBeNull();
  expect(JSON.stringify(logs)).not.toContain(key);
  expect(await readFile(outputPath("data/eval-reports", `${report.id}.json`),"utf8")).not.toContain(key);
});
it("actual Groq-family gateway fallback cannot be judged by Groq openai-oss, including a rejected model answer",async()=>{
  const judgeCall=vi.fn(async()=>({pass:true,reason:"ok"}));
  const gateway=new ModelGateway({primary:{provider:"gemini",model:"fixture",family:"gemini",adapter:new FakeModel([])},retry:false,
    fallback:{provider:"groq",model:"openai/gpt-oss-fixture",family:"openai-oss",adapter:new FakeModel([{text:"Invented answer: it costs $99.",citedChunkIds:[CHUNK]}])}});
  const report=await runEvaluation(db,A,version,{crawlRunId:RUN,gateway,judge:{provider:"groq",model:"openai-oss",family:"openai-oss",judge:judgeCall}});
  const source=report.results.find(r=>r.question.kind==="source")!;
  expect(source.answer).toMatchObject({kind:"refusal",answerFamily:"openai-oss"});
  expect(source.error).toBe("EVALUATION_EXECUTION_ERROR"); expect(source.verdict).toBeNull();
  expect(judgeCall).not.toHaveBeenCalledWith(source.question, expect.anything(), expect.anything());
});
