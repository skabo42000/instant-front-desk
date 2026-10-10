import { expect, it, vi } from "vitest";
import { GeminiAnswer, GeminiEmbeddings, GeminiQuestions, GroqAnswer, GroqJudge,
  evaluationProviders, ProviderError, type HttpTransport } from "../../src/lib/models/providers";
import { ModelGateway } from "../../src/lib/models/gateway";
import { FakeModel } from "../../src/lib/models/fake";
import type { ModelRequest } from "../../src/lib/types";
const KEY="synthetic-eval-key-marker";
const request:ModelRequest={businessId:"fixture",question:"Haircuts?",systemInstruction:"Use excerpts only.",sources:[{businessId:"fixture",id:"chunk",pageUrl:"https://fixture.invalid",heading:"Haircuts",text:"Haircuts available."}]};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const gemini=(value:unknown)=>({candidates:[{content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:4}});
const groq=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});
it("Gemini answers/questions/embeddings and Groq fallback/judge serialize correctly over fake HTTP",async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const transport:HttpTransport=async(url,init)=>{
    calls.push({url,init});
    if(url.includes("embedContent")) return json({embedding:{values:Array(768).fill(0.1)}});
    if(url.includes("groq")) return json(groq(JSON.parse(String(init.body)).messages[0].content.includes("Judge") ? {pass:true,reason:"grounded"}:{text:"Haircuts available.",citedChunkIds:["chunk"]}));
    return json(gemini(JSON.parse(String(init.body)).systemInstruction.parts[0].text.includes("Generate 20") ? [{question:"Haircuts?",expectedBehavior:"Cite",evidenceChunkIds:["chunk"]}]:{text:"Haircuts available.",citedChunkIds:["chunk"]}));
  };
  const p=evaluationProviders({GEMINI_EVAL_API_KEY:KEY,GROQ_EVAL_API_KEY:KEY},transport);
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
});
it("only eval env properties are accessed",()=>{
  const env=new Proxy({} as Record<string,string>,{get:(_,name)=>{
    if(name!=="GEMINI_EVAL_API_KEY" && name!=="GROQ_EVAL_API_KEY") throw new Error("Forbidden environment read");
    return KEY;
  }});
  expect(()=>evaluationProviders(env,async()=>json({}))).not.toThrow();
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
    fallback:{provider:"groq",model:"llama",family:"llama",adapter:{generate:fallback}},onLog:log=>logs.push(log)});
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
