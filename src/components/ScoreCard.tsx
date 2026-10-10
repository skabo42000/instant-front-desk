import type { EvalReport } from "@/lib/eval/runner";
export function ScoreCard({ report }: { report?: EvalReport | null }) {
  const failures = report?.results.filter(r => r.error !== null || r.verdict?.pass !== true) ?? [];
  return <section aria-labelledby="score-title" className="rounded-lg border p-5">
    <h2 id="score-title" className="mb-2 text-2xl font-semibold">Answer checks</h2>
    {!report ? <p>No checks have been run yet. There is no score to show.</p> : <>
      <p>{report.results.length - failures.length}/{report.results.length} checks passed (question version {report.questionVersion}).</p>
      <p>A reviewed sample, not a guarantee of correctness.</p>
      <ul>{failures.map(r => <li key={r.question.id} className="mt-3">
        <p>{r.question.question}</p>
        <p>{r.error ? `Execution error: ${r.error}` : r.verdict?.reason ?? "Missing verdict"}</p>
        {r.answer && <p>Answer: {r.answer.text}</p>}
      </li>)}</ul>
    </>}
  </section>;
}
