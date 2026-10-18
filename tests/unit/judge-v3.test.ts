import { expect, it, vi } from "vitest";
import { GroqQualityJudge, QUALITY_JUDGE_VERSION, SCOPE_NOTICE, judgeReplyText } from "../../src/lib/eval/benchmark-runner";
import { NOT_FOUND, OUT_OF_SCOPE } from "../../src/lib/answer";
import type { BenchmarkCase } from "../../src/lib/eval/benchmark";

it("judge v3 sees the fixed refusal sentences as a marker, keeping every other word", async () => {
  expect(QUALITY_JUDGE_VERSION).toBe("grounding-completeness-v3.1");
  const text = `${NOT_FOUND} You can contact the business at +1 779-234-5125.`;
  expect(judgeReplyText(text)).toBe(`${SCOPE_NOTICE} You can contact the business at +1 779-234-5125.`);
  expect(judgeReplyText(OUT_OF_SCOPE)).toContain("answers only questions about this business");
  expect(judgeReplyText("Parking is free.")).toBe("Parking is free.");
  const transport = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ grounded: true, complete: true, correctBehavior: true, reason: "Safe refusal." }) } }] }));
  const q = { kind: "off-topic", question: "Write a political campaign speech.", expectedBehavior: "Refuse.", requiredFacts: [] } as unknown as BenchmarkCase;
  await new GroqQualityJudge("synthetic-test-key", transport).grade(q, { kind: "refusal", text, citations: [], logs: [], answerFamily: "gemini" }, [], []);
  const body = JSON.stringify((transport.mock.calls[0] as unknown[])[1]);
  expect(body).toContain("is not on this business's website, and the assistant answers only from that website] You can contact the business");
  expect(body).toContain("counts as stating what it says");
  expect(body).not.toContain("I couldn't find that on this business");
});
