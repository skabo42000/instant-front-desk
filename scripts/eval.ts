import { localDatabasePath, openDatabase } from "../src/lib/db/client";
import { FakeJudge, runEvaluation, scoreReport } from "../src/lib/eval/runner";
export async function main(args: string[]): Promise<void> {
  const [businessId, version, crawlRunId] = args;
  if (args.length !== 3) throw new Error("Usage: npm run eval -- <business-uuid> <approved-version> <crawl-run-uuid>");
  const db = await openDatabase(localDatabasePath());
  try {
    // Empty scripts expose errors, never a manufactured quality score.
    const report = await runEvaluation(db, businessId, Number(version), { crawlRunId, judge: new FakeJudge([]) });
    console.log(JSON.stringify({ runId: report.id, ...scoreReport(report) }, null, 2));
  } finally { await db.close(); }
}
