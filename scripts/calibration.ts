import { readFile, mkdir, writeFile } from "node:fs/promises";
import { calibrate, type CalibrationLabel } from "../src/lib/eval/calibration";
export async function main(): Promise<void> {
  const labels: (CalibrationLabel & { fakeJudgePass: boolean })[] = JSON.parse(await readFile("tests/fixtures/judge-calibration.json", "utf8"));
  const report = await calibrate(labels, async sample => labels.find(label => label.id === sample.id)!.fakeJudgePass);
  await mkdir("data/eval-reports", { recursive: true });
  await writeFile("data/eval-reports/calibration-fixture.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ sampleSize: report.sampleSize, agreements: report.agreements,
    disagreementCount: report.disagreementCount, evidence: report.evidence }));
}
