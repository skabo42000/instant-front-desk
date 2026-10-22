import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { isBusinessOverview, isLegalSource } from "../../src/lib/question-intents";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { stableId } from "../../src/lib/chunk";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { retrieve } from "../../src/lib/retrieve";
import { answer, prepareAnswerEvidence } from "../../src/lib/answer";
import { ModelGateway } from "../../src/lib/models/gateway";
import type { ModelRequest } from "../../src/lib/types";

const A = stableId("overview-fixture"), B = stableId("empty-overview"), C = stableId("legal-only-overview");
const home = "https://overview.test/";
const leading = [
  { heading: "Welcome", text: "Bright Studio is a beauty salon." },
  { heading: "Look your best", text: "We offer haircuts and lash treatments." },
  { heading: "Visit", text: "We are based in Springfield." },
  { heading: "Book", text: "Book online or call 202-555-0100." },
];
const adapter = new FakeEmbeddings();
let db: PGlite;
async function page(businessId: string, url: string, sections: { heading: string; text: string }[]) {
  const repo = businessRepository(db, businessId), run = stableId(businessId + url + "run"), pageId = stableId(url);
  await repo.createCrawlRun(run, "completed");
  await repo.createPage({ id: pageId, crawlRunId: run, url, title: "Fixture", cleanText: sections.map(c => c.text).join("\n"), contentHash: "fixture" });
  for (const [ordinal, section] of sections.entries()) await repo.createChunk({
    ...section, ordinal, id: stableId(url + ordinal), pageId, embedding: await adapter.embed(section.heading + " " + section.text),
    embeddingModel: adapter.model, contentHash: "fixture",
  });
}
beforeAll(async () => {
  db = await openDatabase();
  for (const [id, origin] of [[A, "https://overview.test"], [B, "https://empty.test"], [C, "https://legal-only.test"]]) {
    await businessRepository(db, id).createBusiness({ slug: `site-${id}`, name: "Fictional business", sourceUrl: origin,
      contactUrl: null, phone: null, embeddingModel: adapter.model });
  }
  await page(A, home, [...leading, { heading: "Privacy policy", text: "Our privacy policy describes personal data processing." }]);
  await page(A, "https://overview.test/about", [{ heading: "Who we are", text: "Our team runs a local beauty studio." }]);
  await page(A, "https://overview.test/services", [
    { heading: "Our services", text: "Haircuts, lashes and brow styling are available." },
    { heading: "Our services", text: "We also provide manicures." },
  ]);
  await page(A, "https://overview.test/contact", [{ heading: "Contact and location", text: "Book online. Our contact email is hello@overview.test." }]);
  await page(A, "https://overview.test/privacy", [{ heading: "About our privacy policy", text: "We protect personal data under this privacy policy. Email privacy@overview.test." }]);
  await page(A, "https://overview.test/terms", [{ heading: "Our services", text: "These terms apply to using the website." }]);
  await page(A, "https://overview.test/cookie-policy", [{ heading: "What we do", text: "Cookies collect anonymous website statistics." }]);
  await page(C, "https://legal-only.test/privacy", [{ heading: "About our company privacy policy", text: "Contact privacy@legal-only.test for personal data requests." }]);
}, 30000);
afterAll(async () => { await db?.close(); });

describe("business overview intent", () => {
  it.each([
    "summarize me this business", "Summarise this company", "Give me a summary", "Business overview",
    "Tell me about this business", "Tell me about the company", "Tell me about your salon", "Tell me about you",
    "What is this business?", "What is your company?", "What do you do?", "Who are you?",
    "O čemu se radi?", "o cemu se radi", "Šta radite?", "šta radite", "Što radite?", "Ko ste?", "Tko ste?",
  ])("recognizes EN/SR/HR overview: %s", question => expect(isBusinessOverview(question)).toBe(true));
  it.each([
    "what are your prices", "What services do you offer?", "Where are you located?", "When are you open?",
    "What is your privacy policy?", "What do you do with my data?", "Who are your customers?", "How can I book?",
    "What is this business's cancellation policy?", "Tell me about your prices", "Tell me about your company prices", "Koliko košta šišanje?",
  ])("leaves a non-overview question alone: %s", question => expect(isBusinessOverview(question)).toBe(false));
  it.each([
    { pageUrl: "https://example.test/privacy-policy.html", heading: "About" },
    { pageUrl: "https://example.test/terms-of-service", heading: "Our services" },
    { pageUrl: "https://example.test/cookies", heading: "Who we are" },
    { pageUrl: "https://example.test/legal", heading: "Our services" },
    { pageUrl: home, heading: "Changes to this policy" },
  ])("recognizes legal paths and homepage headings: %j", source => expect(isLegalSource(source)).toBe(true));
});

describe("overview evidence and answer path", () => {
  it("takes short homepage chunks first in page order, supplements other pages, deduplicates and caps at eight", async () => {
    const embed = vi.spyOn(adapter, "embed");
    try {
      const result = await retrieve("summarize me this business", businessRepository(db, A), { adapter, topK: 1, maxDistance: 0 });
      expect(result.status).toBe("evidence");
      expect(result.chunks.slice(0, 4).map(c => c.id)).toEqual(leading.map((_, ordinal) => stableId(home + ordinal)));
      expect(result.chunks.slice(0, 4).every(c => c.pageUrl === home)).toBe(true);
      expect(result.chunks.some(c => c.pageUrl.endsWith("/about"))).toBe(true);
      expect(result.chunks.some(c => c.pageUrl.endsWith("/services"))).toBe(true);
      expect(result.chunks.some(c => c.pageUrl.endsWith("/contact"))).toBe(true);
      expect(result.chunks).toHaveLength(8); expect(new Set(result.chunks.map(c => c.id)).size).toBe(8);
      expect(result.chunks.some(isLegalSource)).toBe(false); expect(result.contactChunks.some(isLegalSource)).toBe(false);
      expect(result.contacts.some(contact => contact.value === "privacy@overview.test")).toBe(false);
      expect(embed).not.toHaveBeenCalled();
    } finally { embed.mockRestore(); }
  });
  it("retains legal evidence only when the overview explicitly asks about it", async () => {
    const result = await retrieve("Give me an overview of your business and privacy policy", businessRepository(db, A));
    expect(result.chunks.some(isLegalSource)).toBe(true);
    expect(prepareAnswerEvidence("Give me an overview of your business and privacy policy", result.chunks).some(isLegalSource)).toBe(true);
  });
  it("keeps privacy-policy questions on the original vector/fact retrieval and prompt path", async () => {
    const repo = businessRepository(db, A); const search = vi.spyOn(repo, "searchChunks");
    const embed = vi.spyOn(adapter, "embed");
    try {
      const result = await retrieve("What is your privacy policy?", repo, { adapter, maxDistance: 2 });
      expect(search).toHaveBeenCalledTimes(1); expect(embed).toHaveBeenCalledTimes(1);
      const privacy = result.chunks.find(c => c.pageUrl.endsWith("/privacy"))!;
      expect(privacy).toBeDefined();
      let received: ModelRequest | undefined;
      const gateway = new ModelGateway({ retry: false, primary: { provider: "fake", model: "fixture", family: "fake", adapter: {
        async generate(request) { received = request; return { text: "We protect personal data under this privacy policy.", citedChunkIds: [privacy.id] }; },
      } } });
      expect((await answer("What is your privacy policy?", result.chunks, gateway)).kind).toBe("answer");
      expect(received?.systemInstruction).not.toContain("For a business overview");
    } finally { search.mockRestore(); embed.mockRestore(); }
  });
  it("preserves all relevant overview evidence and requests a short cited summary without invented details", async () => {
    const result = await retrieve("Šta radite?", businessRepository(db, A));
    const relevant = prepareAnswerEvidence("Šta radite?", result.chunks);
    expect(relevant.map(c => c.id)).toEqual(result.chunks.map(c => c.id));
    let received: ModelRequest | undefined;
    const gateway = new ModelGateway({ retry: false, primary: { provider: "fake", model: "fixture", family: "fake", adapter: {
      async generate(request) {
        received = request;
        return { text: "Bright Studio is a beauty salon offering haircuts and lash treatments in Springfield. Book online.",
          citedChunkIds: result.chunks.slice(0, 4).map(c => c.id) };
      },
    } } });
    const reply = await answer("Šta radite?", result.chunks, gateway);
    expect(reply.kind).toBe("answer"); expect(reply.citations.map(c => c.id)).toEqual(result.chunks.slice(0, 4).map(c => c.id));
    expect(received?.systemInstruction).toContain("short plain-English summary");
    expect(received?.systemInstruction).toContain("main services or products");
    expect(received?.systemInstruction).toContain("location or service area if stated");
    expect(received?.systemInstruction).toContain("how to contact or book if stated");
    expect(received?.sources.some(isLegalSource)).toBe(false);
  });
  it.each([B, C])("refuses empty/only-legal sites without invoking an answer model or citing legal fallback: %s", async businessId => {
    const result = await retrieve("Who are you?", businessRepository(db, businessId));
    const generate = vi.fn(); const gateway = new ModelGateway({ primary: { provider: "fake", model: "fixture", family: "fake", adapter: { generate } } });
    expect(result.status).toBe("insufficient evidence"); expect(result.chunks).toEqual([]);
    const reply = await answer("Who are you?", result.chunks, gateway, result.contactChunks);
    expect(reply).toMatchObject({ kind: "refusal", logs: [], citations: [] }); expect(generate).not.toHaveBeenCalled();
  });
  it("also excludes legal contact fallback when answer is invoked directly with legal-only evidence", async () => {
    const legal = { id: "legal", pageUrl: "https://example.test/privacy", heading: "Privacy policy", text: "Email privacy@example.test." };
    expect(await answer("Who are you?", [legal], undefined, [legal])).toMatchObject({ kind: "refusal", citations: [], logs: [] });
  });
});
