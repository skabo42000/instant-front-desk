import { expect, it } from "vitest";
import fixture from "../fixtures/judge-calibration.json";
import { calibrate } from "../../src/lib/eval/calibration";
it("reports sample size, agreement and every hand-labelled disagreement honestly",async()=>{
  const report=await calibrate(fixture,async sample=>fixture.find(r=>r.id===sample.id)!.fakeJudgePass);
  expect(report).toMatchObject({sampleSize:4,agreements:3,disagreementCount:1});
  expect(report.disagreements.map(r=>r.id)).toEqual(["unsupported-comparison"]);
});
it("failed judge calls are disagreements, never agreements",async()=>{
  const report=await calibrate(fixture,async()=>{throw new Error("private-key-marker");});
  expect(report).toMatchObject({sampleSize:4,agreements:0,disagreementCount:4});
  expect(JSON.stringify(report)).not.toContain("private-key-marker");
});
