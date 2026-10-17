import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { ingest } from "../../src/lib/ingest";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { extractContacts, factPatterns, retrieve } from "../../src/lib/retrieve";
import { answer } from "../../src/lib/answer";
import { fixtureCrawl } from "../helpers/fixture-crawl";
import reviewFixtures from "../fixtures/review-fixes.json";
import regression from "../fixtures/fixed-regression.json";
import { ModelGateway } from "../../src/lib/models/gateway";
import { FakeModel } from "../../src/lib/models/fake";
import { trapQuestions } from "../../src/lib/eval/questions";
const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
const C = "00000000-0000-0000-0000-000000000003";
const D = "00000000-0000-0000-0000-000000000004";
const fixtureId = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let db: PGlite;
describe("offline retrieval", () => {
  beforeAll(async () => {
    db = await openDatabase();
    for (const [id, site] of [[A, "bright-salon"], [B, "maple-repair"]] as const) {
      const repo = businessRepository(db, id);
      await repo.createBusiness({ slug: site, name: site, sourceUrl: `https://${site}.test`, phone: null,
        contactUrl: null, embeddingModel: new FakeEmbeddings().model });
      await ingest(`https://${site}.test/`, repo, { crawlOptions: fixtureCrawl(site) });
    }
    const repo = businessRepository(db, C), adapter = new FakeEmbeddings();
    await repo.createBusiness({ slug: "review-fixture", name: "Example", sourceUrl: "https://example.test/", phone: null, contactUrl: null, embeddingModel: adapter.model });
    await repo.createCrawlRun(fixtureId(100), "completed");
    await repo.createPage({ id: fixtureId(101), crawlRunId: fixtureId(100), url: "https://example.test/", title: "Example", cleanText: reviewFixtures.map(f => f.text).join("\n"), contentHash: "fixture" });
    for (const [ordinal, fixture] of reviewFixtures.entries()) await repo.createChunk({
      id: fixtureId(110 + ordinal), pageId: fixtureId(101), ordinal, ...fixture,
      embedding: await adapter.embed(fixture.text), embeddingModel: adapter.model, contentHash: `fixture-${ordinal}`,
    });
    const marketing = businessRepository(db, D);
    await marketing.createBusiness({ slug: "marketing-heading", name: "Example studio", sourceUrl: "https://studio.example", phone: null, contactUrl: null, embeddingModel: adapter.model });
    await marketing.createCrawlRun(fixtureId(200), "completed");
    const summary = "Manicures, pedicures, lashes and waxing in Springfield. Book an appointment with our friendly studio team.";
    await marketing.createPage({ id: fixtureId(201), crawlRunId: fixtureId(200), url: "https://studio.example/", title: "Welcome", cleanText: summary, contentHash: "studio" });
    await marketing.createChunk({ id: fixtureId(202), pageId: fixtureId(201), ordinal: 0, heading: "Feel your best", text: summary,
      embedding: await adapter.embed(summary), embeddingModel: adapter.model, contentHash: "studio" });
  }, 30000);
  afterAll(async () => { await db?.close(); });
  it("finds a homepage service list under a marketing heading without relying on vector overlap or URL names", async () => {
    const result = await retrieve("What services do you offer?", businessRepository(db, D), { maxDistance: 0, topK: 1 });
    expect(result.chunks.map(c => c.id)).toEqual([fixtureId(202)]);
    const gateway = new ModelGateway({ primary: { provider: "fake", model: "regression", family: "fake",
      adapter: new FakeModel([{ text: "Manicures, pedicures, lashes and waxing.", citedChunkIds: [fixtureId(202)] }]) }, retry: false });
    expect((await answer("What services do you offer?", result.chunks, gateway)).kind).toBe("answer");
  });
  // Fixed fictional questions replay past failure types. Scripted replies test retrieval and
  // answer guards, not live model quality. Real reruns freeze their approved DB version instead.
  it.each(regression)("fixed regression: $question", async fixture => {
    const result = await retrieve(fixture.question, businessRepository(db, C));
    const evidence = fixture.headings.map(heading => result.chunks.find(chunk => chunk.heading === heading &&
      (!("contains" in fixture) || !fixture.contains || chunk.text.includes(fixture.contains))));
    expect(evidence.every(Boolean), `Retrieved headings: ${result.chunks.map(c => c.heading).join(", ")}`).toBe(true);
    const gateway = new ModelGateway({ primary: { provider: "fake", model: "regression", family: "fake",
      adapter: new FakeModel([{ text: fixture.answer, citedChunkIds: evidence.map(chunk => chunk!.id) }]) }, retry: false });
    const reply = await answer(fixture.question, result.chunks, gateway, result.contactChunks);
    expect(reply.kind).toBe("answer");
    expect(reply.citations.map(c => c.id)).toEqual(evidence.map(chunk => chunk!.id));
  });
  it.each(trapQuestions())("fixed safety regression: $kind", async fixture => {
    const result = await retrieve(fixture.question, businessRepository(db, C));
    const reply = await answer(fixture.question, result.chunks, undefined, result.contactChunks);
    expect(reply.kind).toBe("refusal");
    expect(reply.text).not.toMatch(/VIP package costs|campaign speech|home address is/i);
  });
  it.each([
    ["What services do you offer?", ["What we do"]],
    ["What are the receptionist benefits?", ["What it does"]],
    ["How do I get started working with you?", ["Talk", "Plan", "Build", "Improve"]],
  ])("heading retrieval supplies services, benefits and every process step: %s", async (question, headings) => {
    const result = await retrieve(question as string, businessRepository(db, C), { topK: 1, maxDistance: 0 });
    expect(result.chunks.slice(0, headings.length).map(chunk => chunk.heading)).toEqual(headings);
    expect(result.chunks.some(chunk => ["Welcome", "About"].includes(chunk.heading))).toBe(false);
    expect(new Set(result.chunks.map(chunk => chunk.id)).size).toBe(result.chunks.length);
    expect(result.chunks.every(chunk => chunk.pageUrl === "https://example.test/")).toBe(true);
  });
  it.each([
    ["Do I need technical skills?", "technical skills"],
    ["How can I request data deletion?", "deletion"],
    ["Do you sell my information?", "do not sell"],
    ["What is your pricing approach?", "Cost depends"],
    ["What will it cost?", "Cost depends"],
    ["How long until launch?", "weeks, not months"],
  ])("keyword retrieval finds narrow facts without vector help: %s", async (question, text) => {
    const result = await retrieve(question, businessRepository(db, C), { topK: 1, maxDistance: 0 });
    expect(result.chunks.some(chunk => chunk.text.includes(text))).toBe(true);
  });
  it("retrieval gives unrelated queries separate, business-scoped contact sections for refusal fallback", async () => {
    const result = await retrieve("unlisted VIP price", businessRepository(db, C), { topK: 1, maxDistance: 0 });
    expect(result.chunks.some(chunk => chunk.heading === "Contact us")).toBe(false);
    expect(result.contactChunks.map(chunk => chunk.heading)).toEqual(["Contact us"]);
    expect((await answer("unlisted VIP price", [], undefined, result.contactChunks)).text).toContain("help@example.test");
    expect((await retrieve("unlisted VIP price", businessRepository(db, A))).contactChunks.every(chunk => chunk.pageUrl === "https://bright-salon.test/")).toBe(true);
  });
  it("returns relevant fixture chunks in answer shape with stable page citations", async () => {
    const repo = businessRepository(db, A);
    const result = await retrieve("What are your hours?", repo, { topK: 1 });
    expect(result.status).toBe("evidence");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({ heading: "Hours", pageUrl: "https://bright-salon.test/", text: "Tuesday to Saturday, 10 AM to 6 PM." });
    expect(Object.keys(result.chunks[0]).sort()).toEqual(["heading", "id", "pageUrl", "text"]);
    expect((await retrieve("What are your hours?", repo)).chunks[0].id).toBe(result.chunks[0].id);
    expect(await repo.getChunk(result.chunks[0].id)).toMatchObject(result.chunks[0]);
  });
  it("keyword search adds the phone section for contact questions, only from the same business", async () => {
    for (const [id, phone, site] of [[A, "202-555-0100", "bright-salon"], [B, "202-555-0110", "maple-repair"]] as const) {
      const result = await retrieve("How can I call you?", businessRepository(db, id), { topK: 1 });
      expect(result.chunks.some(chunk => chunk.text.includes(phone))).toBe(true);
      expect(result.chunks.every(chunk => chunk.pageUrl === `https://${site}.test/`)).toBe(true);
    }
  });
  it("overview questions select the Services heading on a separate page", async () => {
    const result = await retrieve("What services do you offer?", businessRepository(db, A), { topK: 1 });
    expect(result.chunks.some(chunk => chunk.heading === "Services" && chunk.pageUrl === "https://bright-salon.test/services.html")).toBe(true);
  });
  it("picks keyword rules only for the matching kind of question", () => {
    expect(factPatterns("Are there any special deals?")).toHaveLength(1);
    expect(factPatterns("When was the privacy policy last updated?")).toHaveLength(1);
    expect(factPatterns("When are you open?").some(pattern => pattern.includes("last updated"))).toBe(false);
    expect(factPatterns("What are nano brows?")).toEqual([]);
  });
  it("irrelevant and empty queries return insufficient evidence and skip answer generation", async () => {
    for (const question of ["quantum spaceship astronomy", "", "the and of"]) {
      const result = await retrieve(question, businessRepository(db, A));
      expect(result.status).toBe("insufficient evidence");
      expect(result.chunks).toEqual([]);
      expect(await answer(question, result.chunks)).toMatchObject({ kind: "refusal", logs: [] });
      expect(result.contacts).toEqual([{ kind: "phone", value: "202-555-0100", pageUrl: "https://bright-salon.test/" }]);
    }
  });
  it("business B never retrieves A even when asking for A's exact text", async () => {
    const result = await retrieve("Tuesday to Saturday, 10 AM to 6 PM.", businessRepository(db, B), { maxDistance: 2 });
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.pageUrl).toBe("https://maple-repair.test/");
      expect(await businessRepository(db, A).getChunk(chunk.id)).toBeNull();
    }
    expect(result.contacts.map(contact => contact.value)).toEqual(["202-555-0110"]);
  });
  it("extracts contacts only literally present in text, with their page URL", () => {
    expect(extractContacts([{ pageUrl: "https://test/contact", text: "Email hello@example.test or call (202) 555-0123." }])).toEqual([
      { kind: "email", value: "hello@example.test", pageUrl: "https://test/contact" },
      { kind: "phone", value: "(202) 555-0123", pageUrl: "https://test/contact" },
    ]);
    expect(extractContacts([{ pageUrl: "https://202-555-0123.test/hello@example.test", text: "Contact us using our form." }])).toEqual([]);
  });
  it("rejects incompatible spaces, invalid vectors and invalid search settings", async () => {
    const repo = businessRepository(db, A);
    const adapter = new FakeEmbeddings();
    for (const wrong of [ { model: "other", dimensions: 768 }, { model: adapter.model, dimensions: 3 }]) {
      await expect(retrieve("hours", repo, { adapter: { ...wrong, embed: text => adapter.embed(text) } })).rejects.toThrow("mismatch");
    }
    await expect(retrieve("hours", repo, { adapter: { model: adapter.model, dimensions: 768, embed: async () => [1] } })).rejects.toThrow("dimension");
    await expect(retrieve("hours", repo, { topK: 0 })).rejects.toThrow("topK");
    await expect(retrieve("hours", repo, { maxDistance: NaN })).rejects.toThrow("threshold");
  });
});
