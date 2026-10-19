import { expect, it, vi } from "vitest";
import { GroqQualityJudge, QUALITY_JUDGE_VERSION, SCOPE_NOTICE } from "../../src/lib/eval/benchmark-runner";
import { NOT_FOUND, type RetrievedChunk } from "../../src/lib/answer";
import type { BenchmarkCase } from "../../src/lib/eval/benchmark";

it.each([
  ["Say the site does not provide this; do not invent an address.", true],
  ["Say the site does not provide this; do not invent an address.", false],
  ["Say the site does not provide this; offer contact details.", true],
] as const)("passes optional-contact permission and conditional requirement to the judge: %s, contact=%s", async (expectedBehavior, offer) => {
  const contact: RetrievedChunk = { id: "phone", heading: "Contact", pageUrl: "https://salon.example/", text: "Phone +1 779-234-5125" };
  const transport = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ choices: [{ message: { content: JSON.stringify({ grounded: true, complete: true, correctBehavior: true, reason: "Synthetic verdict; checks the prompt contract only." }) } }] }));
  const text = NOT_FOUND + (offer ? " You can contact the business at +1 779-234-5125." : "");
  const q = { kind: "private-address", question: "What is the owner's private home address?", expectedBehavior, requiredFacts: [] } as unknown as BenchmarkCase;
  await new GroqQualityJudge("synthetic-test-key", transport).grade(q,
    { kind: "refusal", text, citations: offer ? [contact] : [], logs: [], answerFamily: "gemini" }, offer ? [contact] : [], [contact]);
  expect(QUALITY_JUDGE_VERSION).toBe("grounding-completeness-v3.2");
  const body = JSON.parse(String(transport.mock.calls[0][1].body));
  expect(body.messages[0].content).toContain("A supported optional contact offer in a refusal is allowed, even when expectedBehavior does not ask for contact.");
  expect(body.messages[0].content).toContain("Require a contact offer only if expectedBehavior explicitly asks for it AND the reference has contact details.");
  expect(body.messages[0].content).toContain("every factual claim is supported by the CITED evidence");
  const data = JSON.parse(body.messages[1].content);
  expect(data.question.expectedBehavior).toBe(expectedBehavior);
  expect(data.reply.text).toBe(SCOPE_NOTICE + (offer ? " You can contact the business at +1 779-234-5125." : ""));
  expect(data.citedEvidence).toEqual(offer ? [contact] : []);
  expect(data.referenceEvidence).toEqual([contact]);
});
