import { expect, it, vi } from "vitest";
import { GeminiAnswer, GeminiEmbeddings, GeminiQuestions, GroqAnswer, GroqJudge,
  evaluationProviders, ProviderError, type HttpTransport } from "../../src/lib/models/providers";
import { ModelGateway } from "../../src/lib/models/gateway";
import { FakeModel } from "../../src/lib/models/fake";
import type { ModelRequest } from "../../src/lib/types";
import reviewFixtures from "../fixtures/review-fixes.json";
const KEY="synthetic-eval-key-marker";
const request:ModelRequest={businessId:"fixture",question:"Haircuts?",systemInstruction:"Use excerpts only.",sources:[{businessId:"fixture",id:"chunk",pageUrl:"https://fixture.invalid",heading:"Haircuts",text:"Haircuts available."}]};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const gemini=(value:unknown)=>({candidates:[{content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:4}});
const groq=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});
it.each([
  ["What are the receptionist benefits?", "Answers missed calls and passes details to the owner.", 3],
  ["List all your services", "AI receptionist, website chat, websites and automation.", 2],
  ["Describe the process", "Talk, plan, build/test, improve.", 6],
  ["What is the unlisted VIP price?", "Not found; email help@example.test.", 12],
])("judge receives summary, completeness, conditional and contact rules with fixture evidence: %s", async (question, answerText, index) => {
  const transport = vi.fn(async () => json(groq({ pass: true, reason: "Scripted serialization fixture" })));
  const fixture = { ...reviewFixtures[index], id: "fixture", pageUrl: "https://example.test/" };
  const judge = new GroqJudge(KEY, transport);
  await judge.judge({ id: "q", kind: index === 12 ? "price-not-listed" : "source", question, expectedBehavior: "Answer with evidence; offer contact when refusing.", evidenceChunkIds: [fixture.id], validationErrors: [] },
    { kind: index === 12 ? "refusal" : "answer", text: answerText, citations: [fixture], logs: [] }, [fixture]);
  const body = JSON.parse(String((transport.mock.calls as unknown as [string, RequestInit][])[0][1].body));
  expect(body.messages[0].content).toContain("accept a supported useful summary");
  expect(body.messages[0].content).toContain("require the essential requested items or steps");
  expect(body.messages[0].content).toContain("booking only after activation");
  expect(body.messages[0].content).toContain("require a grounded contact offer");
  expect(JSON.parse(body.messages[1].content).evidence).toEqual([{ id: "fixture", heading: fixture.heading, text: fixture.text }]);
});
it("question generation asks to preserve conditional features in expected answers", async () => {
  const transport = vi.fn(async () => json(gemini([])));
  await new GeminiQuestions(KEY, transport).generate([]);
  const body = JSON.parse(String((transport.mock.calls as unknown as [string, RequestInit][])[0][1].body));
  expect(body.systemInstruction.parts[0].text).toContain("booking only after activation");
});
it("Gemini answers/questions/embeddings and Groq fallback/judge serialize correctly over fake HTTP",async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const transport:HttpTransport=async(url,init)=>{
    calls.push({url,init});
    if(url.includes("embedContent")) return json({embedding:{values:Array(768).fill(0.1)}});
    if(url.includes("groq")) return json(groq(JSON.parse(String(init.body)).messages[0].content.includes("Judge") ? {pass:true,reason:"grounded"}:{text:"Haircuts available.",citedChunkIds:["chunk"]}));
    return json(gemini(JSON.parse(String(init.body)).systemInstruction.parts[0].text.includes("Generate 20") ? [{question:"Haircuts?",expectedBehavior:"Cite",evidenceChunkIds:["chunk"]}]:{text:"Haircuts available.",citedChunkIds:["chunk"]}));
  };
  const p=evaluationProviders({GEMINI_EVAL_API_KEY:KEY,GROQ_EVAL_API_KEY:KEY},transport);
  expect(p.answer).toMatchObject({model:"gemini-3.5-flash-lite",family:"gemini"});
  expect(p.questions.model).toBe("gemini-3.5-flash-lite");
  expect(p.fallback).toMatchObject({model:"openai/gpt-oss-120b",family:"openai-oss"});
  expect(p.judge).toMatchObject({model:"openai/gpt-oss-120b",family:"openai-oss"});
  expect(await p.answer.generate(request)).toMatchObject({text:"Haircuts available.",citedChunkIds:["chunk"],usage:{inputTokens:10,outputTokens:4}});
  expect(await p.embeddings.embed("Haircuts")).toHaveLength(768);
  expect(p.embeddings).toMatchObject({model:"gemini-embedding-001",dimensions:768});
  expect(await p.questions.generate(request.sources)).toHaveLength(1);
  expect(await p.fallback.generate(request)).toMatchObject({text:"Haircuts available."});
  expect(await p.judge.judge({id:"q",kind:"source",question:"Haircuts?",expectedBehavior:"Cite",evidenceChunkIds:["chunk"],validationErrors:[]},
    {kind:"answer",text:"Haircuts available.",citations:[],logs:[],answerFamily:"gemini"}, request.sources)).toEqual({pass:true,reason:"grounded"});
  expect(calls).toHaveLength(5);
  expect(calls.every(c=>!c.url.includes(KEY) && !String(c.init.body).includes(KEY))).toBe(true);
  expect(JSON.parse(String(calls[1].init.body)).outputDimensionality).toBe(768);
  expect(calls[0].url).toContain("/gemini-3.5-flash-lite:generateContent");
  expect(calls[2].url).toContain("/gemini-3.5-flash-lite:generateContent");
  expect(calls.slice(3).every(c=>JSON.parse(String(c.init.body)).model==="openai/gpt-oss-120b")).toBe(true);
});
it("only isolated eval keys and model settings are accessed",()=>{
  const env=new Proxy({} as Record<string,string>,{get:(_,name)=>{
    if(["GEMINI_TEXT_MODEL","GEMINI_TEXT_FALLBACK_MODELS","GEMINI_ANSWER_MODEL","GEMINI_QUESTION_MODEL","GROQ_MODEL"].includes(String(name))) return undefined;
    if(name!=="GEMINI_EVAL_API_KEY" && name!=="GROQ_EVAL_API_KEY") throw new Error("Forbidden environment read");
    return KEY;
  }});
  expect(()=>evaluationProviders(env,async()=>json({}))).not.toThrow();
});
it("env overrides select answer, question and Groq models while keeping known families",async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const p=evaluationProviders({GEMINI_EVAL_API_KEY:KEY,GROQ_EVAL_API_KEY:KEY,
    GEMINI_ANSWER_MODEL:"gemini-fixture-answer",GEMINI_QUESTION_MODEL:"gemini-fixture-questions",GROQ_MODEL:"openai/gpt-oss-20b"},async(url,init)=>{
    calls.push({url,init});
    if(url.includes("groq")) return json(groq({text:"Supported",citedChunkIds:[]}));
    return json(gemini(url.includes("questions") ? [] : {text:"Supported",citedChunkIds:[]}));
  });
  await p.answer.generate(request); await p.questions.generate([]); await p.fallback.generate(request);
  expect(calls[0].url).toContain("/gemini-fixture-answer:generateContent");
  expect(calls[1].url).toContain("/gemini-fixture-questions:generateContent");
  expect(JSON.parse(String(calls[2].init.body)).model).toBe("openai/gpt-oss-20b");
  expect(p.judge).toMatchObject({model:"openai/gpt-oss-20b",family:"openai-oss"});
  expect(p.fallback.family).toBe("openai-oss");
  expect(p.embeddings.model).toBe("gemini-embedding-001");
  expect(evaluationProviders({GEMINI_EVAL_API_KEY:KEY,GROQ_EVAL_API_KEY:KEY,GEMINI_ANSWER_MODEL:"gemini-fixture"},async()=>json({})).questions.model).toBe("gemini-fixture");
});
it("every embedding call explicitly requests 768, including repeated inputs",async()=>{
  const transport=vi.fn(async()=>json({embedding:{values:Array(768).fill(0.1)}}));
  const adapter=new GeminiEmbeddings(KEY,transport);
  for(const input of ["page text","visitor question","page text"]) await adapter.embed(input);
  expect(transport).toHaveBeenCalledTimes(3);
  for(const [url,init] of transport.mock.calls as unknown as [string,RequestInit][]) {
    expect(url).toContain("/gemini-embedding-001:embedContent");
    expect(JSON.parse(String(init.body))).toMatchObject({model:"models/gemini-embedding-001",outputDimensionality:768});
  }
});
it("Groq rejects judging its own family before any HTTP call and rejects other model families",async()=>{
  const transport=vi.fn(async()=>json({}));
  const judge=new GroqJudge(KEY,transport);
  await expect(judge.judge({id:"q",kind:"source",question:"?",expectedBehavior:"Cite",evidenceChunkIds:[],validationErrors:[]},
    {kind:"answer",text:"Supported",citations:[],logs:[],answerFamily:"openai-oss"},[])).rejects.toThrow("different model family");
  expect(transport).not.toHaveBeenCalled();
  for(const model of ["llama-3.3-70b-versatile","openai/gpt-4","openai/gpt-oss-120b/extra"]) {
    expect(()=>new GroqAnswer(KEY,transport,model)).toThrow();
  }
  expect(()=>new GeminiAnswer(KEY,transport,"openai/gpt-oss-120b")).toThrow();
});
it("dimension mismatch and nonfinite/malformed embedding values fail loudly",async()=>{
  await expect(new GeminiEmbeddings(KEY,async()=>json({embedding:{values:[1,2]}})).embed("x")).rejects.toThrow("expected 768, received 2");
  await expect(new GeminiEmbeddings(KEY,async()=>json({embedding:{values:Array(768).fill(null)}})).embed("x")).rejects.toMatchObject({code:"MALFORMED"});
});
it("malformed provider envelopes, JSON and payloads are rejected",async()=>{
  for(const value of [{},gemini({text:3,citedChunkIds:[]}),{candidates:[{content:{parts:[{text:"broken json"}]}}]}]) {
    await expect(new GeminiAnswer(KEY,async()=>json(value)).generate(request)).rejects.toMatchObject({code:"MALFORMED"});
  }
  await expect(new GeminiQuestions(KEY,async()=>json(gemini({}))).generate([])).rejects.toMatchObject({code:"MALFORMED"});
  await expect(new GroqAnswer(KEY,async()=>json({choices:[]})).generate(request)).rejects.toMatchObject({code:"MALFORMED"});
  const judge=new GroqJudge(KEY,async()=>json(groq({pass:"true",reason:"ok"})));
  await expect(judge.judge({id:"q",kind:"source",question:"?",expectedBehavior:"?",evidenceChunkIds:[],validationErrors:[]},
    {kind:"refusal",text:"unsupported",citations:[],logs:[]},[])).rejects.toMatchObject({code:"MALFORMED"});
});
it("all adapter operations handle 429, HTTP errors, timeout and never leak raw provider errors",async()=>{
  const operations=(transport:HttpTransport)=>[
    ()=>new GeminiAnswer(KEY,transport,undefined,5).generate(request),
    ()=>new GeminiQuestions(KEY,transport,undefined,5).generate([]),
    ()=>new GeminiEmbeddings(KEY,transport,undefined,5).embed("x"),
    ()=>new GroqAnswer(KEY,transport,undefined,5).generate(request),
    ()=>new GroqJudge(KEY,transport,undefined,5).judge({id:"q",kind:"off-topic",question:"?",expectedBehavior:"refuse",evidenceChunkIds:[],validationErrors:[]}, {kind:"refusal",text:"no",citations:[],logs:[]},[]),
  ];
  for(const operation of operations(async()=>json({},429))) await expect(operation()).rejects.toMatchObject({name:"FreeTierExhausted",code:"FREE_TIER_EXHAUSTED"});
  for(const operation of operations(async()=>json({},500))) await expect(operation()).rejects.toMatchObject({code:"HTTP_ERROR"});
  for(const operation of operations(async()=>new Promise(()=>{}))) await expect(operation()).rejects.toMatchObject({code:"TIMEOUT"});
  for(const operation of operations(async()=>{throw new Error(KEY);} )) {
    try { await operation(); throw new Error("Expected rejection"); } catch(error) {
      expect(error).toBeInstanceOf(ProviderError); expect(String(error)).not.toContain(KEY);
    }
  }
});
it("429 latches provider exhaustion, stops gateway retries/fallback and keeps logs key-free",async()=>{
  const transport=vi.fn(async()=>json({},429));
  const primary=new GeminiAnswer(KEY,transport);
  const fallback=vi.spyOn(new FakeModel([{text:"irrelevant",citedChunkIds:[]}]),"generate");
  const logs:unknown[]=[];
  const gateway=new ModelGateway({primary:{provider:"gemini",model:primary.model,family:primary.family,adapter:primary},
    fallback:{provider:"groq",model:"openai/gpt-oss-120b",family:"openai-oss",adapter:{generate:fallback}},onLog:log=>logs.push(log)});
  const result=await gateway.generate(request);
  expect(result.ok).toBe(false); expect(result.logs[0].errorCode).toBe("FREE_TIER_EXHAUSTED");
  expect(fallback).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  await expect(primary.generate(request)).rejects.toMatchObject({code:"FREE_TIER_EXHAUSTED"});
  expect(transport).toHaveBeenCalledTimes(1); expect(JSON.stringify(logs)).not.toContain(KEY);
});
it("echoed keys are rejected before answers or judge reasons can enter reports",async()=>{
  await expect(new GeminiAnswer(KEY,async()=>json(gemini({text:KEY,citedChunkIds:[]}))).generate(request)).rejects.toMatchObject({code:"MALFORMED"});
  await expect(new GroqAnswer(KEY,async()=>json(groq({text:KEY,citedChunkIds:[]}))).generate(request)).rejects.toMatchObject({code:"MALFORMED"});
  const escaped = JSON.stringify({text:KEY,citedChunkIds:[]}).replace(KEY, KEY.split("").map(c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`).join(""));
  await expect(new GeminiAnswer(KEY,async()=>json({candidates:[{content:{parts:[{text:escaped}]}}]})).generate(request)).rejects.toMatchObject({code:"MALFORMED"});
});

it("text model default and legacy overrides coexist; fallback models must be Gemini", () => {
  const keys = { GEMINI_EVAL_API_KEY: KEY, GROQ_EVAL_API_KEY: KEY };
  const configured = evaluationProviders({ ...keys, GEMINI_TEXT_MODEL: "gemini-configured" }, async () => json({}));
  expect(configured.answer.model).toBe("gemini-configured");
  expect(configured.questions.model).toBe("gemini-configured");
  const legacy = evaluationProviders({ ...keys, GEMINI_TEXT_MODEL: "gemini-configured", GEMINI_ANSWER_MODEL: "gemini-answer", GEMINI_QUESTION_MODEL: "gemini-question" }, async () => json({}));
  expect(legacy.answer.model).toBe("gemini-answer"); expect(legacy.questions.model).toBe("gemini-question");
  expect(() => evaluationProviders({ ...keys, GEMINI_TEXT_FALLBACK_MODELS: "openai/gpt-oss-120b" }, async () => json({}))).toThrow();
});
it("Gemini replies that stopped early are rejected; a normal STOP is accepted",async()=>{
  const reply=(finishReason:string)=>({candidates:[{finishReason,content:{parts:[{text:JSON.stringify({text:"You can always find the most up-",citedChunkIds:[]})}]}}]});
  for(const reason of ["MAX_TOKENS","SAFETY","RECITATION","OTHER"])
    await expect(new GeminiAnswer(KEY,async()=>json(reply(reason))).generate(request)).rejects.toMatchObject({code:"MALFORMED"});
  await expect(new GeminiAnswer(KEY,async()=>json(reply("STOP"))).generate(request)).resolves.toMatchObject({text:"You can always find the most up-"});
});
