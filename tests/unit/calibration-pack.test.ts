import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import { applyAiReview, type AiReviewNotes } from "../../src/lib/eval/ai-review";
import { benchmarkHash, type Benchmark } from "../../src/lib/eval/benchmark";
import type { BenchmarkReport } from "../../src/lib/eval/benchmark-runner";
import { makeCalibrationPack, calibrationPage, compareCalibration, type CalibrationLabels } from "../../src/lib/eval/calibration-pack";
import { compareMain } from "../../scripts/calibration-pack";

async function inputs() {
  return Promise.all(["synq", "salon"].map(async site => {
    const base = `benchmarks/owned-sites/2026-10-15/${site}`;
    const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(`${base}/${file}`, "utf8"));
    const benchmark = applyAiReview(await json<Benchmark>("draft.json"), await json<AiReviewNotes>("ai-review-notes.json"));
    const report = { schema: 1, at: "2026-10-17T00:00:00Z", benchmarkHash: benchmarkHash(benchmark), snapshotHash: benchmark.snapshotHash,
      results: benchmark.cases.map((q,i) => ({ id: q.id, kind: q.kind, question: q.question, effectiveIds: q.evidenceChunkIds,
        answer: { text: "Example answer", kind: q.kind === "source" ? "answer" : "refusal", citations: q.evidenceChunkIds.map(id => ({id})) },
        quality: { grounded: i !== 6, complete: i !== 7, correctBehavior: true, reason: "Example grader reason" },
        citationIdsValid: true, error: i === 8 ? "JUDGE_EXECUTION_ERROR" : null })) } as unknown as BenchmarkReport;
    return { report, benchmark, contactEvidence: [] };
  }));
}
function labelsFor(pack: ReturnType<typeof makeCalibrationPack>): CalibrationLabels {
  return { schema: 1, packId: pack.packId, labels: pack.cases.map(c => ({ id: c.id,
    label: c.grader.pass ? "good" : "not-good", note: "", timestamp: "2026-10-17T01:00:00Z" })) };
}

describe("offline human judge calibration", () => {
  it("deterministically selects all completed failures, both sites and all available categories", async () => {
    const data = await inputs();
    const pack = makeCalibrationPack(data);
    expect(pack.cases).toHaveLength(12);
    expect(makeCalibrationPack(data)).toEqual(pack);
    expect(makeCalibrationPack([...data].reverse())).toEqual(pack);
    for (const v of data) {
      for (const r of v.report.results.filter(r => !r.error && (!r.quality!.grounded || !r.quality!.complete))) expect(pack.cases.some(c => c.caseId === r.id)).toBe(true);
      expect(pack.cases.some(c => c.site === v.benchmark.snapshot.business.name && c.kind === "source" && c.grader.pass)).toBe(true);
      expect(pack.cases.some(c => c.site === v.benchmark.snapshot.business.name && c.kind !== "source" && c.grader.pass)).toBe(true);
      expect(pack.cases.some(c => c.caseId === v.report.results[8].id)).toBe(false);
    }
    expect(new Set(pack.cases.map(c => c.kind)).size).toBe(7);
    expect(() => makeCalibrationPack(data, 3)).toThrow();
  });

  it("resolves the cited and reference text separately and validates identities", async () => {
    const data = await inputs(), pack = makeCalibrationPack(data);
    for (const c of pack.cases) {
      const b = data.find(d => d.benchmark.snapshot.business.name === c.site)!.benchmark;
      for (const e of c.citedEvidence) expect(e.text).toBe(b.snapshot.chunks.find(s => s.id === e.id)!.text);
    }
    data[0].report.benchmarkHash = "wrong";
    expect(() => makeCalibrationPack(data)).toThrow("Mismatched");
    expect(() => makeCalibrationPack([data[1],data[1]])).toThrow("Duplicate");
  });

  it("escapes untrusted text in markup and inert JSON, with no network resources", async () => {
    const pack = makeCalibrationPack(await inputs());
    const attack = `</script><img src='https://evil.test' onerror="alert(1)">&`;
    const c = pack.cases[0];
    c.site = c.question = c.answer = c.expectedBehavior = c.grader.reason = attack;
    c.requiredFacts = [attack]; c.citedEvidence = [{id:attack,text:attack,heading:attack,pageUrl:attack}];
    const html = calibrationPage(pack);
    expect(html).not.toContain(attack);
    expect(html).toContain("&lt;/script&gt;&lt;img");
    expect(html).not.toMatch(/<img|<iframe|<link|<script src|fetch\(|XMLHttpRequest/);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(JSON.parse(html.match(/id="pack">([\s\S]*?)<\/script>/)![1]).cases[0].answer).toBe(attack);
  });

  it("keeps every verdict empty and hidden until a label, even if localStorage throws", async () => {
    const pack = makeCalibrationPack(await inputs()), html = calibrationPage(pack);
    expect(html.match(/class="verdict" hidden aria-live="polite"><\/p>/g)).toHaveLength(12);
    expect(html.match(/<fieldset hidden>/g)).toHaveLength(12);
    const nodes = new Map<string, {textContent:string; onclick?:()=>void}>();
    for (const id of ["pack","storage","progress","download","message"]) nodes.set(id,{textContent:id === "pack" ? JSON.stringify(pack) : ""});
    const cards = pack.cases.map(() => {
      const verdict = {hidden:true,textContent:""}, field = {hidden:true}, note = {value:"",oninput:()=>{}};
      const buttons = ["good","not-good"].map(label => ({dataset:{label},onclick:()=>{},setAttribute:()=>{}}));
      return {verdict,field,note,buttons,querySelector:(s:string) => s === ".verdict" ? verdict : s === "fieldset" ? field : note,
        querySelectorAll:(s:string) => s === "select" ? [] : buttons};
    });
    const localStorage = {getItem:()=>{throw Error("blocked");},setItem:()=>{throw Error("full");}};
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {document:{getElementById:(id:string)=>nodes.get(id),querySelectorAll:()=>cards},localStorage});
    expect(cards.every(c => c.verdict.hidden && !c.verdict.textContent)).toBe(true);
    cards[0].buttons[1].onclick();
    expect(cards[0].verdict.hidden).toBe(false);
    expect(cards[0].verdict.textContent).toContain("AI grader:");
    expect(cards[1].verdict.hidden).toBe(true);
    expect(nodes.get("progress")!.textContent).toBe("1 / 12 labeled");
    expect(nodes.get("storage")!.textContent).toContain("Could not save");
  });

  it("computes overall and explicit Not good dimension agreement and every disagreement", async () => {
    const pack = makeCalibrationPack(await inputs()), labels = labelsFor(pack);
    expect(compareCalibration(pack,labels,"Bosko")).toMatchObject({agreement:1,agreements:12,targetMet:true,humanReviewed:true});
    const good = pack.cases.findIndex(c => c.grader.pass);
    labels.labels[good].label = "not-good";
    labels.labels[good].dimensions = { grounded:false, complete:true };
    const result = compareCalibration(pack,labels,"Bosko");
    expect(result.agreement).toBe(11/12);
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].dimensionDisagreements).toEqual(["grounded"]);
    expect(result.perDimension).toMatchObject({ grounded:{sampleSize:1,agreement:0},complete:{sampleSize:1,agreement:1},correctBehavior:{sampleSize:0,agreement:null} });
    labels.labels[good].dimensions = undefined;
    expect(compareCalibration(pack,labels,"Bosko").perDimension.grounded.sampleSize).toBe(0);
  });

  it("reports dimension disagreements even when overall failure labels agree", async () => {
    const pack = makeCalibrationPack(await inputs()), labels = labelsFor(pack);
    const i = pack.cases.findIndex(c => !c.grader.pass);
    labels.labels[i].dimensions = {grounded: !pack.cases[i].grader.grounded};
    const result = compareCalibration(pack,labels,"Bosko");
    expect(result.agreement).toBe(1);
    expect(result.disagreements).toHaveLength(1);
  });

  it("rejects wrong pack, tampering, missing/duplicate/foreign labels and absent reviewer", async () => {
    const pack = makeCalibrationPack(await inputs()), labels = labelsFor(pack);
    const before = JSON.stringify(pack);
    expect(() => compareCalibration(pack,{...labels,packId:"wrong"},"Bosko")).toThrow();
    expect(() => compareCalibration({...pack, cases:pack.cases.slice(1)},labels,"Bosko")).toThrow();
    expect(() => compareCalibration(pack,{...labels,labels:labels.labels.slice(1)},"Bosko")).toThrow();
    const duplicate = structuredClone(labels); duplicate.labels[0] = duplicate.labels[1];
    expect(() => compareCalibration(pack,duplicate,"Bosko")).toThrow();
    const foreign = structuredClone(labels); foreign.labels[0].id = "foreign";
    expect(() => compareCalibration(pack,foreign,"Bosko")).toThrow();
    expect(() => compareCalibration(pack,labels,"")).toThrow();
    expect(JSON.stringify(pack)).toBe(before);
  });

  it("writes only a new comparison file; mismatches never create output", async () => {
    const dir = await mkdtemp(join(tmpdir(),"calibration-compare-"));
    try {
      const pack = makeCalibrationPack(await inputs()), labels = labelsFor(pack);
      const p=join(dir,"pack.json"),l=join(dir,"labels.json"),out=join(dir,"comparison.json");
      await writeFile(p,JSON.stringify(pack)); await writeFile(l,JSON.stringify(labels));
      await compareMain([p,l,out,"--reviewer","Bosko"]);
      expect(JSON.parse(await readFile(out,"utf8"))).toMatchObject({agreement:1,reviewer:"Bosko",humanReviewed:true});
      await expect(compareMain([p,l,out,"--reviewer","Bosko"])).rejects.toThrow();
      labels.packId="wrong"; await writeFile(l,JSON.stringify(labels));
      await expect(compareMain([p,l,join(dir,"bad.json"),"--reviewer","Bosko"])).rejects.toThrow();
      await expect(readFile(join(dir,"bad.json"))).rejects.toThrow();
      expect(JSON.parse(await readFile(p,"utf8"))).toEqual(pack);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
