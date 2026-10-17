import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pilotConfigurationIssues } from "../src/lib/pilot-policy";
import { summarizeMonitoring, type ChatEvent } from "../src/lib/telemetry";
import { createSupabaseRpc, PostgresRateLimitStore } from "../src/lib/shared-controls";
import { benchmarkHash, validateBenchmark, type Benchmark } from "../src/lib/eval/benchmark";
import type { BenchmarkReport } from "../src/lib/eval/benchmark-runner";
import { TRAP_CATEGORIES } from "../src/lib/eval/questions";

export async function main(args:string[]) {
  const [command,file,...rest]=args;
  if(command==="monitoring") {
    if(!file)throw Error("monitoring JSONL");
    const lines=(await readFile(file,"utf8")).split(/\r?\n/).filter(Boolean);
    const events:ChatEvent[]=[];let ignored=0;const denials:Record<string,number>={};
    for(const line of lines){try{const e=JSON.parse(line);
      if(e.schema===1&&e.event==="pilot.denied"&&["pilot-unavailable","invitation-required","cross-origin"].includes(e.reason)) {denials[e.reason]=(denials[e.reason]??0)+1;continue;}
      if(e.event!=="chat.request"||e.schema!==1||!Number.isFinite(e.totalMs)||!Number.isInteger(e.status))throw Error();events.push(e);
    }catch{ignored++;}}
    console.log(JSON.stringify({...summarizeMonitoring(events),pilotDenials:denials,ignoredLines:ignored},null,2));
  } else if(command==="shared-check") {
    if(process.env.READINESS_LIVE_OK!=="yes"||!file)throw Error("Explicit shared database probe required");
    const a=new PostgresRateLimitStore(createSupabaseRpc(process.env)),b=new PostgresRateLimitStore(createSupabaseRpc(process.env));
    const key=`client:readiness-${randomUUID()}`;
    const results=await Promise.allSettled(Array.from({length:24},(_,i)=>(i%2?a:b).consume([{key,limit:3},{key:`${key}-${i}`,limit:1}],60000)));
    const accepted=results.filter(r=>r.status==="fulfilled"&&r.value).length;
    const errors=results.filter(r=>r.status==="rejected").length;
    const report={schema:1,at:new Date().toISOString(),test:"Supabase RPC concurrent shared reservations",requests:24,expectedAccepted:3,accepted,errors,pass:accepted===3&&errors===0,
      scope:"Random hashed operational counters, expiring in 60s; no model calls or business content writes."};
    await mkdir(dirname(resolve(file)),{recursive:true});await writeFile(file,JSON.stringify(report,null,2),{mode:0o600,flag:"wx"});
    console.log(JSON.stringify(report));if(!report.pass)process.exitCode=1;
  } else if(command==="readiness") {
    const issues=pilotConfigurationIssues(process.env);
    let acceptance: {benchmarks: string[]; reports: string[]; concurrencyProof: string; securityReview: {reviewer:string;at:string;approved:boolean}; judgeCalibration:{humanReviewed:boolean;sampleSize:number;agreement:number}} | undefined;
    if(file)try{acceptance=JSON.parse(await readFile(file,"utf8"));}catch{issues.push("Cannot read acceptance packet");}
    else issues.push("Acceptance packet is missing");
    if(acceptance) {
      if(acceptance.benchmarks?.length!==2||acceptance.reports?.length!==2)issues.push("Two benchmark bundles and answer reports required");
      else for(let i=0;i<2;i++)try{
        const b=JSON.parse(await readFile(acceptance.benchmarks[i],"utf8")) as Benchmark;validateBenchmark(b);
        if(b.review?.method!=="human")throw Error();
        const r=JSON.parse(await readFile(acceptance.reports[i],"utf8")) as BenchmarkReport;
        if(r.schema!==1||r.partial||r.provisional||!r.humanReviewed||r.benchmarkHash!==benchmarkHash(b)||r.snapshotHash!==b.snapshotHash)throw Error();
        const included=b.cases.filter(q=>q.decision==="include");
        if(r.results.length!==included.length||r.results.some((row,n)=>row.id!==included[n].id))throw Error();
        const source=r.results.filter(row=>row.kind==="source");
        if(source.length<10||TRAP_CATEGORIES.some(kind=>!r.results.some(row=>row.kind===kind))||
          r.results.some(row=>row.error||!row.citationIdsValid||!row.quality?.grounded||!row.quality.correctBehavior)||
          source.filter(row=>row.quality?.complete).length/source.length<.9)issues.push(`Benchmark ${i+1} fails the pilot quality/coverage gate`);
        if(!(process.env.PILOT_BENCHMARK_HASHES??"").split(",").includes(benchmarkHash(b))||
          !(process.env.PILOT_BUSINESS_IDS??"").split(",").includes(b.snapshot.business.businessId))issues.push(`Benchmark ${i+1} does not match pilot configuration`);
      }catch{issues.push(`Benchmark ${i+1} is missing, unreviewed or mismatched`);}
      try{const proof=JSON.parse(await readFile(acceptance.concurrencyProof,"utf8"));if(proof.test!=="Supabase RPC concurrent shared reservations"||!proof.pass||proof.accepted!==3||proof.errors!==0)throw Error();}catch{issues.push("Successful real shared-Postgres concurrency probe required");}
      if(!acceptance.securityReview?.approved||!acceptance.securityReview.reviewer?.trim()||!Number.isFinite(Date.parse(acceptance.securityReview.at)))issues.push("Independent security review sign-off required");
      if(!acceptance.judgeCalibration?.humanReviewed||!Number.isSafeInteger(acceptance.judgeCalibration.sampleSize)||acceptance.judgeCalibration.sampleSize<10||
        !Number.isFinite(acceptance.judgeCalibration.agreement)||acceptance.judgeCalibration.agreement<.9||acceptance.judgeCalibration.agreement>1)issues.push("Human judge calibration: at least 10 cases and 90% agreement required");
    }
    console.log(JSON.stringify({at:new Date().toISOString(),ready:issues.length===0,issues,scope:"Offline configuration/artifact gate only; does not deploy or establish hosting/account billing state."},null,2));
    if(issues.length)process.exitCode=1;
  }else throw Error("Commands: monitoring JSONL; readiness [ACCEPTANCE_JSON]; shared-check OUTPUT_JSON");
}
