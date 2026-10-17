import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { seedChatDatabase } from "../helpers/chat-database";
import { businessRepository } from "../../src/lib/db/repository";
import { questionRepository, FakeQuestionGenerator } from "../../src/lib/eval/questions";
import { exportBenchmark, importReview, fingerprint, reviewProvenance, validateBenchmark, type Benchmark } from "../../src/lib/eval/benchmark";
import { applyAiReview, type AiReviewNotes } from "../../src/lib/eval/ai-review";
import { retrievalMetrics, bm25Rerank } from "../../src/lib/eval/retrieval-metrics";
import { reviewPage } from "../../src/lib/eval/review-page";
import { prepareAnswerEvidence } from "../../src/lib/answer";
import { evaluateBenchmark, compareBenchmarkReports, scoreBenchmarkReport, GroqQualityJudge, type BenchmarkReport } from "../../src/lib/eval/benchmark-runner";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { ModelGateway } from "../../src/lib/models/gateway";
import { FakeModel } from "../../src/lib/models/fake";
import { openDatabase } from "../../src/lib/db/client";
import { pilotSnapshotSql } from "../../src/lib/eval/pilot-export";
const A="00000000-0000-0000-0000-000000000001";
let db: PGlite, draft: Benchmark;
beforeAll(async () => {
  db = await seedChatDatabase();
  const rows = (await db.query<{ id: string }>("SELECT id FROM chunks WHERE business_id=$1 ORDER BY id LIMIT 1",[A])).rows;
  const version = (await questionRepository(db,A).generate(new FakeQuestionGenerator([{ question:"What are your hours?", expectedBehavior:"State the hours", evidenceChunkIds:[rows[0].id] }]))).version;
  await questionRepository(db,A).approve(version);
  draft = await exportBenchmark(db,A,version);
},30000);
afterAll(async () => { await db?.close(); });
function reviewed() {
  const b = structuredClone(draft);
  b.cases.forEach(q => { q.decision="include"; q.requiredFacts=q.kind==="source"?["State the supported hours"]:[]; });
  b.review={method:"human",reviewer:"Synthetic test reviewer",reviewedAt:"2026-10-15T12:00:00Z",attestation:true,draftHash:b.draftHash};
  return b;
}
describe("immutable benchmark and explicit review", () => {
  it("does not mistake database approval for human review", () => {
    expect(draft.review).toBeNull(); expect(() => validateBenchmark(draft)).toThrow("review");
    expect(() => validateBenchmark(draft,false)).not.toThrow();
    expect(importReview(draft,reviewed()).review?.reviewer).toBe("Synthetic test reviewer");
  });
  it("rejects altered snapshots, foreign evidence, missing facts, unmatched reviews and silent exclusions", () => {
    const edits: ((b:Benchmark)=>void)[] = [b=>{b.snapshot.chunks[0].text="changed";},b=>{b.cases[0].evidenceChunkIds=["foreign"];},
      b=>{b.cases.find(q=>q.kind==="source")!.requiredFacts=[];},b=>{b.draftHash="0".repeat(64);},
      b=>{b.cases[0].decision="exclude";b.cases[0].exclusionReason="";},b=>{b.cases[0].id="different";}];
    for(const edit of edits){const b=reviewed();edit(b);expect(()=>importReview(draft,b)).toThrow();}
    const b=reviewed();b.cases[0].question="A human correction?";expect(()=>importReview(draft,b)).not.toThrow();
  });
  it("escapes hostile source text in a standalone offline review page", () => {
    const b=structuredClone(draft);b.cases[0].question='</script><img src=x onerror="alert(1)">';
    const html=reviewPage([b]);expect(html).not.toContain(b.cases[0].question);expect(html).toContain("connect-src 'none'");
    expect(html).toContain("textContent=text");expect(html).not.toContain("innerHTML");expect(html).toContain("attestation:true");
  });
});
it("measures gold-ID recall separately at each stage, with traps ineligible", () => {
  expect(retrievalMetrics(["a","b"],[{id:"c"},{id:"a"},{id:"a"}])).toMatchObject({recallAt1:0,recallAt5:.5,poolRecall:.5,reciprocalRank:.5,complete:false});
  expect(retrievalMetrics([],[]).poolRecall).toBeNull();
  const chunks=[{id:"a",heading:"Hours",text:"Open 9 AM",pageUrl:"https://fixture.test/"},
    {id:"b",heading:"Book",text:"Find current prices on our booking page.",pageUrl:"https://fixture.test/book"}];
  expect(prepareAnswerEvidence("Where can I find current prices?",chunks).map(c=>c.id)).toContain("b");
  expect(bm25Rerank("booking page",chunks).map(c=>c.id)).toEqual(["b","a"]);
  expect(chunks[0].id).toBe("a");
});
it("counts alternative evidence once per required fact instead of demanding duplicate chunks",()=>{
  const groups=[["a","duplicate-a"],["b"]];
  expect(retrievalMetrics(["a","duplicate-a","b"],[{id:"duplicate-a"},{id:"b"}],groups)).toMatchObject({recallAt1:.5,poolRecall:1,complete:true});
  expect(retrievalMetrics(["a","duplicate-a","b"],[{id:"a"}],groups).poolRecall).toBe(.5);
  expect(retrievalMetrics([],[],[]).poolRecall).toBeNull();
});
it("accepts explicit AI source review without ever labeling it human or removing the release guard",()=>{
  const notes:AiReviewNotes={schema:1,method:"ai",reviewer:"Synthetic AI fixture",reviewedAt:"2026-10-15T12:00:00Z",draftHash:draft.draftHash,
    scope:"Synthetic test of provenance and quotes, not quality evidence",cases:draft.cases.map(q=>{
      const c=draft.snapshot.chunks.find(c=>c.id===q.evidenceChunkIds[0]);
      return {id:q.id,expectedBehavior:q.expectedBehavior,decision:"include",exclusionReason:"",notes:"Explicit synthetic case review.",
        facts:c?[{fact:"Supported fixture fact",quotes:[`${c.heading} ${c.text}`.trim()]}]:[]};
    })};
  const result=applyAiReview(draft,notes);
  expect(reviewProvenance(result)).toEqual({reviewMethod:"ai",humanReviewed:false,provisional:true});
  expect(result.cases.map(q=>q.question)).toEqual(draft.cases.map(q=>q.question));expect(result.snapshotHash).toBe(draft.snapshotHash);
  expect(pilotSnapshotSql(result)).toContain("DRAFT_REQUIRES_HUMAN_REVIEW");
  const bad=structuredClone(notes);bad.cases.find(q=>q.facts.length)!.facts[0].quotes=["This evidence never appeared in the fixture corpus."];
  expect(()=>applyAiReview(draft,bad)).toThrow("No saved source");
  expect(()=>applyAiReview(draft,{...notes,method:"human"} as unknown as AiReviewNotes)).toThrow();
  expect(()=>applyAiReview(draft,{...notes,cases:notes.cases.slice(1)})).toThrow();
  const badGroups=structuredClone(result);badGroups.cases.find(q=>q.kind==="source")!.evidenceGroups=[["foreign-id"]];
  expect(()=>validateBenchmark(badGroups)).toThrow("groups");
});
it("retains booking directions for general prices/deals but does not substitute them for a named service price",()=>{
  const booking={id:"booking",heading:"Book online",pageUrl:"https://fixture.test/book",text:"Book online any time through our booking page, where you can see every service and choose a time."};
  expect(prepareAnswerEvidence("Where can I find current prices and deals?",[booking]).map(c=>c.id)).toEqual(["booking"]);
  expect(prepareAnswerEvidence("What is the exact haircut price?",[booking])).toEqual([]);
});
it("runs the frozen snapshot offline and keeps missing evidence distinct from answer quality", async () => {
  const isolated=await openDatabase();
  try {
    const b=reviewed();const grade=vi.fn(async()=>({grounded:true,complete:false,correctBehavior:false,reason:"Safe refusal missed an answer."}));
    const report=await evaluateBenchmark(isolated,b,{embeddings:new FakeEmbeddings(),queryCacheHash:"fixed",variant:"hybrid",
      gateway:new ModelGateway({primary:{provider:"fake",model:"fixture",family:"fake",adapter:new FakeModel([])},retry:false}),
      judge:{family:"other-family",model:"test",grade}});
    expect(report.humanReviewed).toBe(true);expect(report.results).toHaveLength(7);
    // Unavailable fake replies are execution errors, never a successful refusal grade.
    expect(report.results.filter(r=>r.answer?.refusalReason==="model-error").every(r=>r.error&&r.quality===null)).toBe(true);
    const copy=structuredClone(report);copy.benchmarkHash="other";expect(()=>compareBenchmarkReports(report,copy)).toThrow("mismatch");
    const wrongCases=structuredClone(report);wrongCases.results.reverse();expect(()=>compareBenchmarkReports(report,wrongCases)).toThrow("IDs");
    expect(compareBenchmarkReports(report,report).before.total).toBe(7);
  } finally { await isolated.close(); }
},30000);
it("the independent quality judge separates grounding, completeness and behavior",async()=>{
  const transport=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({grounded:true,complete:false,correctBehavior:true,reason:"One requested fact omitted."})}}]}));
  const judge=new GroqQualityJudge("synthetic-test-key",transport);
  const q=reviewed().cases[0];
  expect(await judge.grade(q,{kind:"answer",text:"Supported but incomplete",citations:[],logs:[],answerFamily:"gemini"},[],[])).toMatchObject({grounded:true,complete:false});
  await expect(judge.grade(q,{kind:"answer",text:"x",citations:[],logs:[],answerFamily:"openai-oss"},[],[])).rejects.toThrow("different model family");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("prepares a scoped SQL import, blocks unreviewed execution and round-trips reviewed text safely",async()=>{
  expect(()=>pilotSnapshotSql(draft)).toThrow();expect(pilotSnapshotSql(draft,true)).toContain("DRAFT_REQUIRES_HUMAN_REVIEW");
  const target=await openDatabase();
  try{
    await target.exec(pilotSnapshotSql(reviewed()));
    expect(await businessRepository(target,A).listPageTexts()).toEqual(await businessRepository(db,A).listPageTexts());
    expect((await businessRepository(target,A).getBusiness())?.businessId).toBe(A);
    await expect(target.exec(pilotSnapshotSql(reviewed()))).rejects.toThrow(); // Never overwrite another installed corpus.
  }finally{await target.close();}
},30000);

it("checkpoints a quota-stopped run without inventing results for unattempted cases", async()=>{
  const isolated=await openDatabase();let stop:string|null=null;
  const grade=vi.fn(async()=>{stop="FREE_TIER_EXHAUSTED";throw new Error("quota");});
  const progress=vi.fn();
  try {
    const b=reviewed();
    // Start with a trap: deterministic refusal reaches the judge without a model reply.
    b.cases.sort((a,b)=>Number(a.kind==="source")-Number(b.kind==="source"));
    const report=await evaluateBenchmark(isolated,b,{embeddings:new FakeEmbeddings(),queryCacheHash:"fixed",variant:"hybrid",
      gateway:new ModelGateway(),judge:{family:"other-family",model:"fixture",grade},stopReason:()=>stop,onProgress:progress});
    expect(report.partial).toBe(true);expect(report.stopReason).toBe("FREE_TIER_EXHAUSTED");
    expect(report.results).toHaveLength(1);expect(grade).toHaveBeenCalledTimes(1);
    expect(report.results[0]).toMatchObject({error:"FREE_TIER_EXHAUSTED",quality:null});
    expect(report.results[0].judgeMs).not.toBeNull();
    expect(scoreBenchmarkReport(report)).toMatchObject({total:7,completed:1,unattempted:6,partial:true,errors:1,passedAll:0});
    expect(progress.mock.calls[0][0].partial).toBe(true);
    expect(()=>compareBenchmarkReports(report,report)).toThrow("Partial");
  } finally {await isolated.close();}
},30000);
