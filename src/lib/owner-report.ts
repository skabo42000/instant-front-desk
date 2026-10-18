import { benchmarkHash, fingerprint, type Benchmark } from "./eval/benchmark";
import type { BenchmarkReport, BenchmarkResult } from "./eval/benchmark-runner";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const trapNames: Record<string, string> = {
  "answer-not-on-site": "information not listed", "price-not-listed": "prices not listed",
  "prompt-injection": "prompt injection", "off-topic": "off-topic requests",
  competitor: "competitor questions", "ignore-your-rules": "requests to ignore rules",
};

// Only public page URLs are links; credentials, queries and fragments never leave the saved data.
function pageUrl(value: string, origin?: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || (origin && url.origin !== origin)) return null;
    url.search = ""; url.hash = "";
    return url.href;
  } catch { return null; }
}

function resultLabel(result: BenchmarkResult): string {
  const q = result.quality;
  if (result.error !== null || !result.answer || result.citationIdsValid !== true ||
    q?.grounded !== true || q.complete !== true || q.correctBehavior !== true) return "Needs work";
  if (result.kind === "source" && result.answer.kind === "answer") return "Answered from your site";
  // The saved answer kind can be "answer" even for a textual refusal; the grader
  // checks safe refusal behavior on traps, so use that verdict instead of the tag.
  if (result.kind !== "source") return "Correctly refused";
  return "Needs work";
}

export function renderOwnerReport(report: BenchmarkReport, benchmark: Benchmark): string {
  if (report.schema !== 1 || benchmark.schema !== 1 || report.benchmarkHash !== benchmarkHash(benchmark) ||
    report.snapshotHash !== benchmark.snapshotHash || fingerprint(benchmark.snapshot) !== benchmark.snapshotHash ||
    !Number.isFinite(Date.parse(report.at)) || !Array.isArray(report.results)) throw new Error("Mismatched saved data");
  const business = benchmark.snapshot.business;
  const site = pageUrl(business.sourceUrl);
  if (!site) throw new Error("Invalid business site");
  const origin = new URL(site).origin;
  const knownPages = new Set(benchmark.snapshot.pages.map(p => pageUrl(p.url, origin)).filter(Boolean));
  const included = benchmark.cases.filter(c => c.decision === "include");
  const seen = new Set<string>();
  for (const r of report.results) {
    if (seen.has(r.id) || !included.some(c => c.id === r.id && c.question === r.question && c.kind === r.kind)) throw new Error("Unknown or duplicate question");
    seen.add(r.id);
  }
  if (report.expectedTotal !== undefined && report.expectedTotal !== included.length) throw new Error("Incorrect total");
  const sourceCount = report.results.filter(r => r.kind === "source").length;
  const traps = report.results.length - sourceCount;
  const passed = report.results.filter(r => resultLabel(r) !== "Needs work").length;
  const unattempted = included.length - report.results.length;
  const errors = report.results.filter(r => r.error !== null).length;
  const date = new Date(report.at).toISOString().slice(0, 10);
  const trapList = [...new Set(report.results.filter(r => r.kind !== "source").map(r => trapNames[r.kind] ?? "safety checks"))].join(", ");
  const cards = report.results.map((r, i) => {
    const label = resultLabel(r);
    const links = [...new Set((r.answer?.citations ?? []).map(c => pageUrl(c.pageUrl, origin)).filter((url): url is string => !!url && knownPages.has(url)))];
    return `<article><p class="result ${label === "Needs work" ? "needs" : "good"}">${label}</p>
<h3>${i + 1}. ${escapeHtml(r.question)}</h3><p class="answer">${escapeHtml(r.answer?.text ?? "No answer was recorded.")}</p>
${r.error !== null ? "<p>The automated check could not finish; this is not a passing result.</p>" : label === "Needs work" ? "<p>The answer did not meet every automated check, or a required check is missing.</p>" : ""}
<p>Cited pages:</p>${links.length ? `<ul>${links.map(url => `<li><a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(url)}</a></li>`).join("")}</ul>` : "<p>No usable page links were recorded.</p>"}</article>`;
  }).join("\n");
  // Render an allowlist of owner-facing fields, never raw reports, judge reasons or logs.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(business.name)} — prototype answer checks</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--text:#172033;--muted:#475569;--border:#cbd5e1;--link:#1d4ed8;--good:#166534;--needs:#9a3412}
@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#172033;--text:#f1f5f9;--muted:#cbd5e1;--border:#475569;--link:#93c5fd;--good:#86efac;--needs:#fdba74}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.65 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:clamp(16px,4vw,40px)}header,section,article,footer{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,28px);margin-bottom:20px}h1{font-size:clamp(1.65rem,5vw,2.5rem);line-height:1.2}h2{font-size:1.5rem}h3{font-size:1.15rem}h1,h2,h3{margin-top:0}p{margin:.6em 0}a{color:var(--link)}a:focus-visible{outline:3px solid var(--link);outline-offset:3px}a,h1,h3,p,li{overflow-wrap:anywhere}.answer{white-space:pre-wrap}.result{font-weight:700}.good{color:var(--good)}.needs{color:var(--needs)}.muted,footer{color:var(--muted)}ul{padding-left:1.4rem}@media print{body{background:white;color:black}article{break-inside:avoid}}
</style></head><body><main><header><p class="muted">Prototype · saved website answer checks</p><h1>${escapeHtml(business.name)}</h1><p><a href="${escapeHtml(site)}" rel="noreferrer">${escapeHtml(site)}</a></p><p>Report date: ${date} (UTC)</p></header>
<section aria-labelledby="summary"><h2 id="summary">What was tested</h2><p>${sourceCount} real questions from your saved website text and ${traps} trap questions${trapList ? ` (${escapeHtml(trapList)})` : ""}.</p>
<p><strong>${passed}/${report.results.length} completed checks met all AI-grader requirements; ${report.results.length - passed} need work.</strong></p>
<p>${count(unattempted, "planned question was", "planned questions were")} not tested; ${count(errors, "check", "checks")} could not finish; ${count(report.excluded.length, "question was", "questions were")} excluded.${report.partial ? " This run was marked incomplete." : ""}</p>
<p>These are provisional automated results from one saved test set, not human-validated accuracy or a guarantee of future answers. Website text may have changed since it was saved.</p>
<p>“Answered from your site” and “Correctly refused” mean every required automated check passed. “Needs work” includes failed, missing and unfinished checks.</p></section>
<h2>Questions and assistant answers</h2>${cards}<footer>Prototype test on public website text; not a live deployment; answers checked by an AI grader, not a person<p>Report date: ${date} (UTC)</p></footer></main></body></html>`;
}
