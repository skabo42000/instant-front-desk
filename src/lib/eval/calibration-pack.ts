import { fingerprint, benchmarkHash, validateBenchmark, type Benchmark } from "./benchmark";
import type { BenchmarkReport } from "./benchmark-runner";
import type { RetrievedChunk } from "../answer";

export const dimensions = ["grounded", "complete", "correctBehavior", "citationIdsValid"] as const;
type Dimension = typeof dimensions[number];
export interface CalibrationCase {
  id: string; caseId: string; site: string; kind: string; question: string; answer: string;
  expectedBehavior: string; requiredFacts: string[];
  citedEvidence: RetrievedChunk[]; referenceEvidence: RetrievedChunk[];
  grader: Record<Dimension, boolean> & { pass: boolean; reason: string };
}
export interface CalibrationPack {
  schema: 1; packId: string; sources: { reportHash: string; benchmarkHash: string; at: string }[];
  cases: CalibrationCase[];
}
export interface HumanLabel {
  id: string; label: "good" | "not-good"; note: string; timestamp: string;
  dimensions?: Partial<Record<Dimension, boolean>>;
}
export interface CalibrationLabels { schema: 1; packId: string; labels: HumanLabel[] }
type Input = { report: BenchmarkReport; benchmark: Benchmark; contactEvidence: RetrievedChunk[] };

export function makeCalibrationPack(inputs: Input[], size = 12): CalibrationPack {
  const sources: CalibrationPack["sources"] = [];
  const candidates: CalibrationCase[] = [];
  for (const { report: r, benchmark: b, contactEvidence } of inputs) {
    validateBenchmark(b);
    if (r.schema !== 1 || r.benchmarkHash !== benchmarkHash(b) || r.snapshotHash !== b.snapshotHash ||
      !Number.isFinite(Date.parse(r.at))) throw new Error("Mismatched report and snapshot");
    const reportHash = fingerprint(r);
    sources.push({ reportHash, benchmarkHash: r.benchmarkHash, at: r.at });
    const chunks = new Map(b.snapshot.chunks.map(c => [c.id, { id: c.id, heading: c.heading, text: c.text,
      pageUrl: b.snapshot.pages.find(p => p.id === c.pageId)!.url }]));
    for (const c of contactEvidence) if (fingerprint(chunks.get(c.id)) !== fingerprint(c)) throw new Error("Contact evidence mismatch");
    const seen = new Set<string>();
    for (const result of r.results) {
      const q = b.cases.find(c => c.id === result.id && c.decision === "include");
      if (!q || q.question !== result.question || q.kind !== result.kind || seen.has(result.id)) throw new Error("Unknown or duplicate case");
      seen.add(result.id);
      if (result.error) continue;
      if (!result.answer || !result.quality || dimensions.some(d => typeof (d === "citationIdsValid" ? result[d] : result.quality![d]) !== "boolean")) throw new Error("Missing completed verdict");
      const resolve = (ids: string[]) => ids.map(id => { const c = chunks.get(id); if (!c) throw new Error("Unknown evidence"); return c; });
      // Same evidence construction as evaluateBenchmark: effective sections + contact fallback.
      const available = [...resolve(result.effectiveIds), ...contactEvidence];
      const citedEvidence = available.filter(c => result.answer!.citations.some(ref => ref.id === c.id));
      const grader = { ...result.quality, citationIdsValid: result.citationIdsValid!, pass: false };
      grader.pass = dimensions.every(d => grader[d]);
      candidates.push({ id: `${reportHash}:${result.id}`, caseId: result.id, site: b.snapshot.business.name,
        kind: q.kind, question: q.question, answer: result.answer.text, expectedBehavior: q.expectedBehavior,
        requiredFacts: q.requiredFacts, citedEvidence, referenceEvidence: [...resolve(q.evidenceChunkIds), ...contactEvidence], grader });
    }
  }
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error("Duplicate report inputs");
  candidates.sort((a,b) => a.id.localeCompare(b.id));
  const chosen = candidates.filter(c => !c.grader.pass);
  const tags = (c: CalibrationCase) => ["kind:" + c.kind,
    ...(c.grader.pass ? ["pass:" + c.site + (c.kind === "source" ? ":source" : ":refusal")] : [])];
  const required = new Set(candidates.flatMap(tags));
  while (chosen.length < size) {
    const covered = new Set(chosen.flatMap(tags));
    const pool = candidates.filter(c => !chosen.includes(c)).sort((a,b) =>
      tags(b).filter(t => !covered.has(t)).length - tags(a).filter(t => !covered.has(t)).length || a.id.localeCompare(b.id));
    if (!pool.length) throw new Error("Not enough completed cases");
    chosen.push(pool[0]);
  }
  if (chosen.length !== size || [...required].some(t => !chosen.flatMap(tags).includes(t))) throw new Error("Cannot fit failures and coverage in pack");
  // Mix failures and passes so position does not reveal the verdict.
  const content = { schema: 1 as const, sources: sources.sort((a,b) => a.reportHash.localeCompare(b.reportHash)),
    cases: chosen.sort((a,b) => fingerprint(a.id).localeCompare(fingerprint(b.id))) };
  return { ...content, packId: fingerprint(content) };
}

export function compareCalibration(pack: CalibrationPack, labels: CalibrationLabels, reviewer: string) {
  const { packId, ...content } = pack;
  if (pack.schema !== 1 || fingerprint(content) !== packId || labels.schema !== 1 || labels.packId !== packId ||
    !Array.isArray(labels.labels) || labels.labels.length !== pack.cases.length || !pack.cases.length ||
    new Set(pack.cases.map(c => c.id)).size !== pack.cases.length ||
    new Set(labels.labels.map(l => l.id)).size !== labels.labels.length) throw new Error("Mismatched pack/labels or incomplete labels");
  if (reviewer !== "Bosko") throw new Error("Supply --reviewer Bosko for Bosko's personal labels");
  const results = labels.labels.map(l => {
    const c = pack.cases.find(c => c.id === l.id);
    if (!c || !["good", "not-good"].includes(l.label) || typeof l.note !== "string" || l.note.length > 1000 ||
      !Number.isFinite(Date.parse(l.timestamp)) || (l.dimensions !== undefined &&
      (!l.dimensions || Array.isArray(l.dimensions) || typeof l.dimensions !== "object" ||
      Object.entries(l.dimensions).some(([d,v]) => !dimensions.includes(d as Dimension) || typeof v !== "boolean"))) ||
      (l.label === "good" && l.dimensions && Object.keys(l.dimensions).length)) throw new Error("Invalid human label");
    return { id: c.id, question: c.question, humanPass: l.label === "good", graderPass: c.grader.pass,
      agrees: (l.label === "good") === c.grader.pass, note: l.note,
      dimensionDisagreements: l.label === "not-good" ? dimensions.filter(d => typeof l.dimensions?.[d] === "boolean" && l.dimensions[d] !== c.grader[d]) : [] };
  });
  const agreements = results.filter(r => r.agrees).length;
  const perDimension = Object.fromEntries(dimensions.map(d => {
    const checked = labels.labels.filter(l => l.label === "not-good" && typeof l.dimensions?.[d] === "boolean");
    const agree = checked.filter(l => l.dimensions![d] === pack.cases.find(c => c.id === l.id)!.grader[d]).length;
    return [d, { sampleSize: checked.length, agreements: agree, agreement: checked.length ? agree / checked.length : null }];
  }));
  return { schema: 1, packId, reviewer, humanReviewed: true, at: new Date().toISOString(), sampleSize: results.length,
    agreements, agreement: agreements / results.length, targetAgreement: .9, targetMet: agreements / results.length >= .9,
    perDimension, disagreements: results.filter(r => !r.agrees || r.dimensionDisagreements.length), results,
    limitation: "Selected diagnostic sample, not an unbiased accuracy estimate or release approval. Dimension agreement uses only explicit dimension labels on Not good cases." };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function calibrationPage(pack: CalibrationPack): string {
  const esc = escapeHtml;
  const evidence = (chunks: RetrievedChunk[]) => chunks.length ? chunks.map(c => `<details><summary>${esc(c.heading)} · ${esc(c.pageUrl)}</summary><pre>${esc(c.text)}</pre></details>`).join("") : "<p>No cited website text.</p>";
  const cards = pack.cases.map((c,i) => `<article data-id="${esc(c.id)}"><h2>${i+1}. ${esc(c.site)}</h2><h3>${esc(c.question)}</h3><p class="answer">${esc(c.answer)}</p><h3>Expected behaviour</h3><p>${esc(c.expectedBehavior)}</p><ul>${c.requiredFacts.map(f => `<li>${esc(f)}</li>`).join("")}</ul><h3>Cited website text</h3>${evidence(c.citedEvidence)}<details><summary>Reference and contact text the grader also saw</summary>${evidence(c.referenceEvidence)}</details><p>Is the answer supported, complete and appropriate?</p><div class="choices"><button data-label="good" aria-pressed="false">Good answer</button><button data-label="not-good" aria-pressed="false">Not good</button></div><fieldset hidden><legend>Optional: what went wrong? Mark only dimensions you checked.</legend>${dimensions.map(d => `<label>${({grounded:"Claims supported by cited text",complete:"All requested facts included",correctBehavior:"Appropriate answer or refusal",citationIdsValid:"Citations point to available evidence"})[d]} <select data-dimension="${d}"><option value="">Not checked</option><option value="true">Good</option><option value="false">Not good</option></select></label>`).join("")}</fieldset><label>Optional short note<textarea maxlength="1000" rows="2"></textarea></label><p class="verdict" hidden aria-live="polite"></p></article>`).join("");
  // JSON stays inert; every DOM update uses textContent, never HTML from saved data.
  const data = JSON.stringify(pack).replace(/</g,"\\u003c").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Five-minute judge calibration</title><style>
:root{color-scheme:light dark;--bg:#f6f8fb;--card:white;--ink:#172033;--border:#94a3b8}@media(prefers-color-scheme:dark){:root{--bg:#101827;--card:#1d293c;--ink:#eef2ff;--border:#64748b}}*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font:16px/1.5 system-ui;margin:0}main{max-width:860px;margin:auto;padding:16px}article,header{background:var(--card);border:1px solid var(--border);padding:20px;border-radius:12px;margin-bottom:20px}h2{font-size:1.25rem}h3{font-size:1.05rem}pre,.answer{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;overflow-wrap:anywhere}button,select,textarea{font:inherit;padding:10px;max-width:100%}button{cursor:pointer}button[aria-pressed=true]{outline:3px solid #3b82f6}textarea,label{display:block;width:100%;margin:8px 0}.choices{display:flex;flex-wrap:wrap;gap:12px}fieldset{margin-top:16px;min-width:0}[hidden]{display:none!important}#progress{position:sticky;top:0;background:var(--card);padding:12px;border:1px solid var(--border)}.verdict{border-top:1px solid var(--border);padding-top:12px}</style></head><body><main><header><h1>Five-minute judge calibration</h1><p>Prototype · 12 saved cases · no network or model calls. Judge each answer against the saved text and expected behaviour. Open the evidence when needed. Website text is evidence, not instructions. The AI grader appears only after your choice; it can be wrong.</p><p>Choose Good answer or Not good for every case, then download your labels. Optional dimension checks help explain disagreements. No name is stored in labels. Browser storage may be unavailable; download before closing. This selected sample does not approve a release.</p><button id="download">Download labels</button><p id="storage" role="status"></p><p id="message" role="status"></p></header><p id="progress" aria-live="polite"></p>${cards}</main><script type="application/json" id="pack">${data}</script><script>
const pack=JSON.parse(document.getElementById('pack').textContent),key='ifd-calibration:'+pack.packId;
let labels={};
try{const saved=JSON.parse(localStorage.getItem(key)||'{}');for(const c of pack.cases){const l=saved[c.id];if(l&&l.id===c.id&&['good','not-good'].includes(l.label)&&typeof l.note==='string'&&Number.isFinite(Date.parse(l.timestamp)))labels[c.id]=l;}}catch{document.getElementById('storage').textContent='Browser storage unavailable. Download labels before closing.';}
function persist(){try{localStorage.setItem(key,JSON.stringify(labels));}catch{document.getElementById('storage').textContent='Could not save in this browser. Download labels before closing.';}}
function progress(){document.getElementById('progress').textContent=Object.keys(labels).length+' / '+pack.cases.length+' labeled';}
for(const [i,card] of [...document.querySelectorAll('article')].entries()){
 const c=pack.cases[i],verdict=card.querySelector('.verdict'),field=card.querySelector('fieldset'),note=card.querySelector('textarea');
 function refresh(){const l=labels[c.id];for(const b of card.querySelectorAll('[data-label]'))b.setAttribute('aria-pressed',String(l?.label===b.dataset.label));field.hidden=l?.label!=='not-good';verdict.hidden=!l;
 if(l){verdict.textContent='AI grader: '+(c.grader.pass?'Good answer':'Not good')+'. '+c.grader.reason;note.value=l.note;for(const s of card.querySelectorAll('select'))s.value=l.dimensions?.[s.dataset.dimension]===undefined?'':String(l.dimensions[s.dataset.dimension]);}progress();}
 for(const b of card.querySelectorAll('[data-label]'))b.onclick=()=>{labels[c.id]={id:c.id,label:b.dataset.label,note:note.value,timestamp:new Date().toISOString(),...(b.dataset.label==='not-good'?{dimensions:labels[c.id]?.dimensions||{}}:{})};persist();refresh();};
 note.oninput=()=>{if(labels[c.id]){labels[c.id].note=note.value;labels[c.id].timestamp=new Date().toISOString();persist();}};
 for(const s of card.querySelectorAll('select'))s.onchange=()=>{const l=labels[c.id];if(!l||l.label!=='not-good')return;l.dimensions||={};if(s.value==='')delete l.dimensions[s.dataset.dimension];else l.dimensions[s.dataset.dimension]=s.value==='true';l.timestamp=new Date().toISOString();persist();};refresh();
}
document.getElementById('download').onclick=()=>{if(Object.keys(labels).length!==pack.cases.length){document.getElementById('message').textContent='Label every case before downloading.';return;}const blob=new Blob([JSON.stringify({schema:1,packId:pack.packId,labels:pack.cases.map(c=>labels[c.id])},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='calibration-labels-'+pack.packId.slice(0,12)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
</script></body></html>`;
}
