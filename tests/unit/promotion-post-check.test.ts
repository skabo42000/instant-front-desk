import { expect, it } from "vitest";
import { answer, type RetrievedChunk } from "../../src/lib/answer";
import { FakeModel } from "../../src/lib/models/fake";
import { ModelGateway } from "../../src/lib/models/gateway";

// Exact answers from salon case 9aeb5744-e433-4d5c-96fc-7b28b540d992, v3.1 and v2-run2.
const failing = "Yes! The website mentions that great deals are currently running with senior technicians who have 10+ years of experience for microblading and eyelash extensions. You can see the details and current deals on their booking page.";
const passing = "Yes! The website mentions great deals with senior technicians who have 10+ years of experience for microblading and eyelash extensions. You can find current deals and prices on their booking page.";
const source: RetrievedChunk = { id: "deals", heading: "Special deals", pageUrl: "https://salon.example/",
  text: "We are currently running great deals with senior technicians who have 10+ years of experience for microblading and eyelash extensions. See current prices and deals on our booking page." };
async function reply(text: string, evidence = source) {
  const gateway = new ModelGateway({ primary: { provider: "fake", family: "fake", model: "scripted",
    adapter: new FakeModel([{ text, citedChunkIds: [evidence.id] }]) } });
  return answer("Are there special deals currently running?", [evidence], gateway);
}
it("rewrites the exact failing attributed active-deals claim as a historical mention with booking directions", async () => {
  const result = await reply(failing);
  expect(result.kind).toBe("answer");
  expect(result.text).toBe("The website mentioned great deals with senior technicians who have 10+ years of experience for microblading and eyelash extensions. You can see the details and current deals on their booking page.");
  expect(result.citations.map(c => c.id)).toEqual([source.id]);
});
it("keeps the exact passing v2-run2 answer byte for byte", async () => {
  expect(await reply(passing)).toMatchObject({ kind: "answer", text: passing });
});
it.each(["Great deals are currently running.", "Special offers are active now.", "Discounts are still available."])("adds only supported booking directions after rewriting: %s", async text => {
  const result = await reply(text);
  expect(result.kind).toBe("answer");
  expect(result.text).toContain("The website mentioned");
  expect(result.text).toContain("Check the booking page for current prices and deals.");
  expect(result.text).not.toMatch(/\b(?:running|active|available|now|still)\b/i);
});
it("refuses other active promotion wording rather than letting it through", async () => {
  expect(await reply("We are currently running great deals.")).toMatchObject({ kind: "refusal", refusalReason: "unsupported-promotion" });
});
it("never turns a negated or conditional promotion claim into an affirmative mention", async () => {
  for (const text of ["No deals are currently running.", "Check whether deals are active.", "Deals are running. No offers are active."]) {
    expect(await reply(text)).toMatchObject({ kind: "refusal", refusalReason: "unsupported-promotion" });
  }
});
it("does not invent a promotion mention when the cited evidence has none", async () => {
  expect(await reply("Great deals are currently running.", { ...source, text: "Eyelash care is available." }))
    .toMatchObject({ kind: "refusal", refusalReason: "unsupported-promotion" });
});
it("does not invent booking directions when the cited source has none", async () => {
  const result = await reply("Great deals are currently running.", { ...source, text: "We have mentioned great deals." });
  expect(result).toMatchObject({ kind: "answer", text: "The website mentioned great deals." });
});
it.each(["Current prices and deals are on the booking page.", "The salon is currently open.", "No current promotions are listed.", "The website mentioned past deals."])("keeps unrelated or already safe wording unchanged: %s", async text => {
  expect(await reply(text)).toMatchObject({ kind: "answer", text });
});
