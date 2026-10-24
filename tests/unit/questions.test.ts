import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase, migrateDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { FakeQuestionGenerator, questionRepository, TRAP_CATEGORIES, validateGeneratedQuestions } from "../../src/lib/eval/questions";
import { fakeEmbedding, FAKE_EMBEDDING_MODEL } from "../helpers/fake-embeddings";
import { execute } from "../../scripts/questions";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionList } from "../../src/lib/eval/questions";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const A=id(1), B=id(2), RUN=id(3), PAGE=id(4), CHUNK=id(5);
let db: PGlite;
describe("versioned evaluation questions", () => {
  beforeAll(async () => {
    db=await openDatabase();
    for (const businessId of [A,B]) {
      const repo=businessRepository(db,businessId);
      await repo.createBusiness({ slug: businessId, name: "Fixture", sourceUrl: "https://fixture.invalid",
        contactUrl: null, phone: null, embeddingModel: FAKE_EMBEDDING_MODEL });
      await repo.createCrawlRun(RUN);
      await repo.createPage({ id: PAGE, crawlRunId: RUN, url: "https://fixture.invalid/hours", title: "Hours",
        cleanText: "Open Monday", contentHash: "hours" });
      await repo.createChunk({ id: CHUNK, pageId: PAGE, ordinal: 0, heading: "Hours", text: `Hours for ${businessId}`,
        embedding: fakeEmbedding("hours"), embeddingModel: FAKE_EMBEDDING_MODEL, contentHash: "hours" });
    }
  },30000);
  afterAll(async () => { if(db) await db.close(); });
  it("generates 20 referenced questions and exactly six deterministic trap categories", async () => {
    const list=await questionRepository(db,A).generate();
    expect(list.questions).toHaveLength(26);
    expect(list.questions.filter(q=>q.kind!=="source").map(q=>q.kind).sort()).toEqual([...TRAP_CATEGORIES].sort());
    expect(list.questions.filter(q=>q.kind==="source").every(q=>q.evidenceChunkIds[0]===CHUNK && q.expectedBehavior && !q.validationErrors.length)).toBe(true);
    expect(list.approvedAt).toBeNull();
  });
  it("flags missing, malformed, unknown and foreign references and malformed replies", async () => {
    const repo=questionRepository(db,A);
    const raw=[null, {question:"Hours?",expectedBehavior:"Cite",evidenceChunkIds:[]},
      {question:"Hours?",expectedBehavior:"Cite",evidenceChunkIds:[id(99),23,"bad",CHUNK,CHUNK]},
      {question:"x".repeat(2001),expectedBehavior:"",evidenceChunkIds:[CHUNK]}];
    const list=await repo.generate(new FakeQuestionGenerator(raw));
    expect(list.questions.filter(q=>q.kind==="source")).toHaveLength(4);
    expect(list.questions.filter(q=>q.kind==="source").every(q=>q.validationErrors.length>0)).toBe(true);
    await expect(repo.approve(list.version)).rejects.toThrow("flagged");
    expect(validateGeneratedQuestions({question:"Hours?"},[])[0].validationErrors).toContain("Generated reply must be an array");
    expect(validateGeneratedQuestions([],[])[0].validationErrors).toContain("Generated reply contains no questions");
    const b=businessRepository(db,B);
    await b.createChunk({id:id(98),pageId:PAGE,ordinal:1,heading:"Private to B",text:"B only",
      embedding:fakeEmbedding("b"),embeddingModel:FAKE_EMBEDDING_MODEL,contentHash:"b"});
    const foreign=await repo.generate(new FakeQuestionGenerator([{question:"B?",expectedBehavior:"Cite",evidenceChunkIds:[id(98)]}]));
    expect(foreign.questions.find(q=>q.kind==="source")?.validationErrors.join()).toContain("foreign");
  });
  it("edits through the CLI create a new unapproved version and preserve approved history", async () => {
    const repo=questionRepository(db,A);
    const old=await repo.generate();
    await execute(db,[A,"approve",String(old.version)]);
    const q=old.questions.find(q=>q.kind==="source")!;
    const directory = await mkdtemp(join(tmpdir(), "ifd-question-edit-"));
    const file = join(directory, "edit.json");
    let next: QuestionList;
    try {
      await writeFile(file,JSON.stringify({question:"What are the listed hours?",expectedBehavior:"Cite hours",evidenceChunkIds:[CHUNK]}));
      next=await execute(db,[A,"edit",String(old.version),q.id,file]) as QuestionList;
    } finally { await rm(directory, { recursive: true, force: true }); }
    expect(next.version).toBe(old.version+1);
    expect(next.approvedAt).toBeNull();
    expect(next.questions.every(item=>!old.questions.some(prior=>prior.id===item.id))).toBe(true);
    expect((await repo.get(old.version)).questions).toEqual(old.questions);
    expect((await repo.get(old.version)).approvedAt).not.toBeNull();
    await expect(repo.forRun(next.version)).rejects.toThrow("not approved");
    expect(await execute(db,[A,"show",String(next.version)])).toEqual(next);
    expect(await execute(db,[A,"list"])).toEqual(await repo.list());
  });
  it("blocks unapproved runs in both the repository and direct SQL; accepts approved runs", async () => {
    const repo=questionRepository(db,A), list=await repo.generate();
    const insert=()=>db.query(`INSERT INTO eval_runs (business_id,id,question_version,crawl_run_id,answer_model,judge_model,prompt_version,status)
      VALUES ($1,$2,$3,$4,'fake','judge','v1','running')`,[A,id(60),list.version,RUN]);
    await expect(repo.forRun(list.version)).rejects.toThrow("not approved");
    await expect(insert()).rejects.toThrow("approved");
    await repo.approve(list.version);
    expect((await repo.forRun(list.version)).questions).toHaveLength(26);
    await insert();
    const other=await repo.generate(); await repo.approve(other.version);
    await expect(db.query(`INSERT INTO eval_results (business_id,id,eval_run_id,question_id,answer)
      VALUES ($1,$2,$3,$4,'test')`,[A,id(61),id(60),other.questions[0].id])).rejects.toThrow("approved run version");
    await db.query(`INSERT INTO eval_results (business_id,id,eval_run_id,question_id,answer)
      VALUES ($1,$2,$3,$4,'test')`,[A,id(62),id(60),list.questions[0].id]);
  });
  it("isolates lists, edits, approvals and evidence by business, including reused chunk IDs", async () => {
    const a=questionRepository(db,A),b=questionRepository(db,B);
    expect(await b.list()).toEqual([]);
    await expect(b.get(1)).rejects.toThrow("not found");
    await expect(b.approve(1)).rejects.toThrow("not found");
    const list=await b.generate();
    const aq=(await a.get(1)).questions[0];
    await expect(b.edit(list.version,aq.id,{})).rejects.toThrow("not found");
    expect(list.version).toBe(1);
    await expect(db.query("INSERT INTO question_evidence (business_id,id,question_id,chunk_id) VALUES ($1,$2,$3,$4)",
      [B,id(70),aq.id,CHUNK])).rejects.toMatchObject({code:"23503"});
    await migrateDatabase(db);
    expect((await a.get(1)).questions).toHaveLength(26);
  });
  it("flags malformed trap edits and rechecks legacy unsourced rows before approval", async () => {
    const repo=questionRepository(db,A),list=await repo.generate();
    const trap=list.questions.find(q=>q.kind==="off-topic")!;
    const edited=await repo.edit(list.version,trap.id,{question:"New question?",expectedBehavior:"Decline"});
    expect(edited.questions.find(q=>q.kind==="off-topic")?.validationErrors).toContain("Malformed evidence array");
    await expect(repo.approve(edited.version)).rejects.toThrow("flagged");
    const next=(await repo.generate()).version;
    await db.query(`INSERT INTO eval_questions (business_id,id,version,kind,question,expected_behavior)
      VALUES ($1,$2,$3,'source','Legacy unsourced?','Cite')`,[A,id(80),next]);
    await expect(repo.approve(next)).rejects.toThrow("unsourced stored");
  });
});
