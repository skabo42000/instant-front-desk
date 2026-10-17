// Only isolated eval keys are loaded. Never print provider bodies or exceptions.
const fs = require("node:fs");
const path = require("node:path");
async function main() {
  if (process.env.LIVE_OK !== "yes" || process.env.FREE_TIER_CONFIRMED !== "yes") throw Error();
  const output = process.argv[2];
  if (!output || fs.existsSync(output)) throw Error();
  const keys = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(GEMINI_EVAL_API_KEY|GROQ_EVAL_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) keys[match[1]] = /^(["']).*\1$/.test(match[2]) ? match[2].slice(1,-1) : match[2].replace(/\s+#.*$/, "");
  }
  const report = {at:new Date().toISOString(), scope:"One tiny generation per provider at most; no retries/fallback; isolated eval keys only", recovered:false, results:[]};
  const providers = [
    {name:"gemini", key:keys.GEMINI_EVAL_API_KEY, url:"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      body:{contents:[{parts:[{text:"Reply OK."}]}],generationConfig:{maxOutputTokens:8}}},
    {name:"groq", key:keys.GROQ_EVAL_API_KEY, url:"https://api.groq.com/openai/v1/chat/completions",
      body:{model:"openai/gpt-oss-120b",messages:[{role:"user",content:"Reply OK."}],max_completion_tokens:16}},
  ];
  for (const p of providers) {
    if (!p.key) { report.results.push({provider:p.name,status:"missing-eval-key",attempts:0}); break; }
    try {
      const response = await fetch(p.url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15000),
        headers:{"content-type":"application/json",...(p.name==="gemini"?{"x-goog-api-key":p.key}:{authorization:`Bearer ${p.key}`})},body:JSON.stringify(p.body)});
      report.results.push({provider:p.name,status:response.status,attempts:1});
      await response.body?.cancel();
      if (!response.ok) break; // Stop immediately on quota or any other failed probe.
    } catch { report.results.push({provider:p.name,status:"transport-unavailable",attempts:1}); break; }
  }
  report.recovered = report.results.length===2 && report.results.every(r=>r.status===200);
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:"wx"});
  console.log(JSON.stringify(report));
}
main().catch(()=>{console.error("Quota probe unavailable; no recovery established.");process.exitCode=1;});
