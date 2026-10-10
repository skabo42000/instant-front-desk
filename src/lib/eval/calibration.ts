import "server-only";
export interface CalibrationLabel {
  id: string; question: string; evidence: string; answer: string; humanPass: boolean;
}
export async function calibrate(labels: readonly CalibrationLabel[], judge: (sample: CalibrationLabel) => Promise<boolean>) {
  const results = [];
  for (const sample of labels) {
    let judgePass: boolean | null = null;
    let error: string | null = null;
    try {
      judgePass = await judge(sample);
      if (typeof judgePass !== "boolean") throw new Error("Malformed verdict");
    } catch { judgePass = null; error = "JUDGE_EXECUTION_ERROR"; }
    results.push({ ...sample, judgePass, error });
  }
  const disagreements = results.filter(r => r.error || r.judgePass !== r.humanPass);
  return { evidence: "Hand-labelled synthetic fixtures; fake judge plumbing only", sampleSize: labels.length,
    agreements: labels.length - disagreements.length, disagreementCount: disagreements.length, disagreements, results };
}
