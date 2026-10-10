import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { seedChatDatabase } from "../helpers/chat-database";
import { ChatAnswer } from "../../src/components/Chat";
let db: PGlite;
vi.mock("../../src/lib/local-businesses", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/local-businesses")>(), getLocalDatabase: () => Promise.resolve(db),
}));
import Home from "../../src/app/page";
import BusinessPage from "../../src/app/b/[slug]/page";
describe("local pages", () => {
  beforeAll(async () => { db = await seedChatDatabase(); }, 30000);
  afterAll(async () => { await db?.close(); });
  it("lists seeded businesses and CLI instructions", async () => {
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain("npm run ingest");
    expect(html).toContain("/b/bright-salon");
    expect(html).toContain("/b/maple-repair");
    expect(html).toContain("Stop the local server");
  });
  it("renders businesses independently without controls or synthetic secrets", async () => {
    const markers = { DATABASE_URL: "synthetic-db-marker", GEMINI_API_KEY: "synthetic-model-marker", GROQ_API_KEY: "synthetic-judge-marker" };
    for (const [key, value] of Object.entries(markers)) vi.stubEnv(key, value);
    try {
      for (const [slug, other] of [["bright-salon", "maple-repair"], ["maple-repair", "bright-salon"]]) {
        const tree = await BusinessPage({ params: Promise.resolve({ slug }) });
        const html = renderToStaticMarkup(tree);
        expect(html).toContain(slug);
        expect(html).not.toContain(other);
        expect(html).toContain("No checks have been run yet");
        expect(html).toContain("Your question");
        expect(html).not.toMatch(/npm run|crawl|ingest|evaluation/i);
        for (const marker of Object.values(markers)) {
          expect(html).not.toContain(marker);
          expect(JSON.stringify(tree)).not.toContain(marker);
        }
      }
      const home = renderToStaticMarkup(await Home());
      for (const marker of Object.values(markers)) expect(home).not.toContain(marker);
    } finally { vi.unstubAllEnvs(); }
  });
  it("unknown share slug uses Next's 404 boundary", async () => {
    await expect(BusinessPage({ params: Promise.resolve({ slug: "missing" }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
  it("renders citations and refusals as escaped text", () => {
    const html = renderToStaticMarkup(createElement(ChatAnswer, { reply: { kind: "refusal", text: "<script>fake</script>", citations: [
      { id: "source", pageUrl: "https://bright-salon.test/", heading: "Hours" },
    ] } }));
    expect(html).toContain("The website doesn&#x27;t say");
    expect(html).toContain('href="https://bright-salon.test/"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
