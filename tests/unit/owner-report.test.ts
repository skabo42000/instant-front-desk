import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderOwnerReport } from "../../src/lib/owner-report";
import { benchmarkHash, fingerprint, type Benchmark } from "../../src/lib/eval/benchmark";
import type { BenchmarkReport, BenchmarkResult } from "../../src/lib/eval/benchmark-runner";
import { main } from "../../scripts/owner-report";

function fixture() {
  const benchmark = {
    schema: 1, snapshot: { business: { name: "Example Salon", sourceUrl: "https://salon.example/", businessId: "PRIVATE_BUSINESS_ID" }, pages: [{ url: "https://salon.example/services" }], chunks: [] },
    cases: [{ id: "PRIVATE_CASE_ID", kind: "source", question: "What services?", decision: "include" }], review: null,
  } as unknown as Benchmark;
  benchmark.snapshotHash = fingerprint(benchmark.snapshot);
  const result = {
    id: "PRIVATE_CASE_ID", kind: "source", question: "What services?", error: null, citationIdsValid: true,
    quality: { grounded: true, complete: true, correctBehavior: true, reason: "PRIVATE_JUDGE_REASON" },
    answer: { kind: "answer", text: "Haircuts.", citations: [{ pageUrl: "https://salon.example/services", id: "PRIVATE_CHUNK_ID", heading: "PRIVATE_HEADING" }], logs: [{ inputTokens: "PRIVATE_TOKENS", estimatedCost: "PRIVATE_COST", apiKey: "PRIVATE_KEY" }] },
  } as unknown as BenchmarkResult;
  const report = { schema: 1, at: "2026-10-17T23:00:00Z", benchmarkHash: benchmarkHash(benchmark), snapshotHash: benchmark.snapshotHash,
    results: [result], excluded: [], expectedTotal: 1, judgePromptVersion: "PRIVATE_PROMPT", providerCallLogs: ["PRIVATE_PROVIDER_LOG"] } as unknown as BenchmarkReport;
  return { benchmark, report, result };
}

describe("offline owner report", () => {
  it("escapes all displayed website/model text and blocks active or foreign citation links", () => {
    const { benchmark, report, result } = fixture();
    const attack = `<script>alert("x")</script><img src='https://tracker.example/x'>&`;
    benchmark.snapshot.business.name = attack;
    benchmark.cases[0].question = result.question = attack;
    result.answer!.text = attack;
    result.answer!.citations.push({ id: "x", heading: attack, pageUrl: "javascript:alert(1)" },
      { id: "x", heading: attack, pageUrl: "https://foreign.example/" },
      { id: "x", heading: attack, pageUrl: "https://user:password@salon.example/services" });
    benchmark.snapshotHash = report.snapshotHash = fingerprint(benchmark.snapshot);
    report.benchmarkHash = benchmarkHash(benchmark);
    const html = renderOwnerReport(report, benchmark);
    expect(html).not.toContain(attack);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img");
    expect(html).not.toMatch(/<script|<img|javascript:|foreign\.example|user:password/);
    expect(html).toContain('href="https://salon.example/services"');
  });

  it("exports only owner-facing fields and removes URL query/fragment secrets", () => {
    const { benchmark, report, result } = fixture();
    result.answer!.citations[0].pageUrl += "?api_key=PRIVATE_URL_KEY#PRIVATE_FRAGMENT";
    const html = renderOwnerReport(report, benchmark);
    expect(html).not.toMatch(/PRIVATE_|inputTokens|estimatedCost|judgePrompt|businessId|benchmarkHash|providerCallLogs/);
    expect(html).not.toMatch(/<script|<link|<iframe|<img|@import|url\(/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('name="viewport"');
  });

  it("uses honest prototype wording, the saved date and all-checks-required labels", () => {
    const { benchmark, report, result } = fixture();
    let html = renderOwnerReport(report, benchmark);
    expect(html).toContain("Answered from your site");
    expect(html).toContain("1/1 completed checks");
    expect(html).toContain("Prototype test on public website text; not a live deployment; answers checked by an AI grader, not a person");
    expect(html).toContain("2026-10-17 (UTC)");
    expect(html).toContain("not human-validated accuracy");
    benchmark.cases[0].kind = result.kind = "price-not-listed";
    result.answer!.kind = "refusal";
    report.benchmarkHash = benchmarkHash(benchmark);
    html = renderOwnerReport(report, benchmark);
    expect(html).toContain('<p class="result good">Correctly refused</p>');
    expect(html).toContain("0 real questions");
    expect(html).toContain("1 trap questions (prices not listed)");
    result.answer!.kind = "answer";
    result.answer!.text = "I can only answer questions about this business's website.";
    expect(renderOwnerReport(report, benchmark)).toContain('<p class="result good">Correctly refused</p>');
    result.quality!.complete = false;
    expect(renderOwnerReport(report, benchmark)).toContain("0/1 completed checks");
  });

  it.each(["error", "missing verdict", "invalid citations", "wrong answer behavior"])("does not pass %s", issue => {
    const { benchmark, report, result } = fixture();
    if (issue === "error") result.error = "PRIVATE_ERROR";
    if (issue === "missing verdict") result.quality = null;
    if (issue === "invalid citations") result.citationIdsValid = false;
    if (issue === "wrong answer behavior") result.answer!.kind = "refusal";
    const html = renderOwnerReport(report, benchmark);
    expect(html).toContain('<p class="result needs">Needs work</p>');
    expect(html).toContain("0/1 completed checks");
    expect(html).not.toContain("PRIVATE_");
  });

  it("reports incomplete runs without silently counting untested cases as passes", () => {
    const { benchmark, report } = fixture();
    report.results = []; report.partial = true;
    const html = renderOwnerReport(report, benchmark);
    expect(html).toContain("1 planned question was not tested");
    expect(html).toContain("This run was marked incomplete");
  });

  it("rejects mismatched snapshots, test sets, totals and duplicate cases", () => {
    const { benchmark, report } = fixture();
    expect(() => renderOwnerReport({ ...report, snapshotHash: "wrong" }, benchmark)).toThrow();
    expect(() => renderOwnerReport({ ...report, benchmarkHash: "wrong" }, benchmark)).toThrow();
    expect(() => renderOwnerReport({ ...report, expectedTotal: 2 }, benchmark)).toThrow();
    expect(() => renderOwnerReport({ ...report, results: [...report.results, ...report.results] }, benchmark)).toThrow();
    expect(() => renderOwnerReport(report, { ...benchmark, snapshot: { ...benchmark.snapshot, pages: [] } })).toThrow();
  });

  it("writes a single standalone file offline and refuses to overwrite saved files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owner-report-"));
    try {
      const { benchmark, report } = fixture();
      const reportPath = join(dir, "report.json"), benchmarkPath = join(dir, "benchmark.json"), output = join(dir, "owner.html");
      await writeFile(reportPath, JSON.stringify(report));
      await writeFile(benchmarkPath, JSON.stringify(benchmark));
      await main([reportPath, output, benchmarkPath]);
      expect(await readFile(output, "utf8")).toBe(renderOwnerReport(report, benchmark));
      await expect(main([reportPath, output, benchmarkPath])).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
