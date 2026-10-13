import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { ingest } from "../../src/lib/ingest";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { extractContacts, retrieve } from "../../src/lib/retrieve";
import { answer } from "../../src/lib/answer";
import { fixtureCrawl } from "../helpers/fixture-crawl";
const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
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
  }, 30000);
  afterAll(async () => { await db?.close(); });
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
