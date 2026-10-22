import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { seedChatDatabase } from "../helpers/chat-database";
import { ChatAnswer } from "../../src/components/Chat";
import { businessRepository } from "../../src/lib/db/repository";
import { rememberWebsiteLoad } from "../../src/lib/website-load-summary";
let db: PGlite;
const requestHeaders = vi.hoisted(() => ({ value: new Headers({ host: "localhost:3000" }) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.value }));
vi.mock("../../src/lib/local-businesses", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/local-businesses")>(), getLocalDatabase: () => Promise.resolve(db),
}));
import Home from "../../src/app/page";
import BusinessPage from "../../src/app/b/[slug]/page";
describe("local pages", () => {
  beforeEach(() => {
    vi.stubEnv("LOCAL_CHAT_MODE", "real"); vi.stubEnv("FREE_TIER_CONFIRMED", "yes");
    vi.stubEnv("PILOT_ACCESS_TOKEN", ""); vi.stubEnv("IFD_PILOT_MODE", ""); vi.stubEnv("IFD_DATA_STORE", "local");
    requestHeaders.value = new Headers({ host: "localhost:3000" });
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeAll(async () => {
    db = await seedChatDatabase();
    await businessRepository(db, "00000000-0000-0000-0000-000000000099").createBusiness({
      slug: "new-live-site", name: "New fictional website", sourceUrl: "https://new.test", phone: null,
      contactUrl: null, embeddingModel: "gemini-embedding-001", embeddingDimensions: 768,
    });
  }, 30000);
  afterAll(async () => { await db?.close(); });
  it("lists seeded businesses and the local Add a website form", async () => {
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain("Add a website");
    expect(html).toContain('type="url"');
    expect(html).toContain("Load website");
    expect(html).toContain("up to 15 public pages");
    expect(html).toContain("/b/bright-salon");
    expect(html).toContain("/b/maple-repair");
    expect(html).not.toContain("npm run ingest");
  });
  it.each(["pilot", "token", "remote", "forwarded", "fake"])("hides the form for %s requests", async mode => {
    if (mode === "pilot") vi.stubEnv("IFD_PILOT_MODE", "yes");
    if (mode === "token") vi.stubEnv("PILOT_ACCESS_TOKEN", "synthetic-invitation");
    if (mode === "remote") requestHeaders.value = new Headers({ host: "public.example" });
    if (mode === "forwarded") requestHeaders.value.set("x-forwarded-for", "192.168.1.20");
    if (mode === "fake") vi.stubEnv("LOCAL_CHAT_MODE", "fake");
    expect(renderToStaticMarkup(await Home())).not.toContain("Add a website");
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
        expect(html).toContain("No quality test yet for this site");
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
  it("renders a newly added live-model business without a score card", async () => {
    const html = renderToStaticMarkup(await BusinessPage({ params: Promise.resolve({ slug: "new-live-site" }) }));
    expect(html).toContain("New fictional website");
    expect(html).toContain("Live website answers are enabled");
    expect(html).toContain("Your question");
    expect(html).toContain("No quality test yet for this site");
  });
  it("shows loaded/skipped/truncated counts on the chat page after redirect, without error details", async () => {
    rememberWebsiteLoad("new-live-site", { pages: 15, skipped: 2, truncated: true });
    const html = renderToStaticMarkup(await BusinessPage({ params: Promise.resolve({ slug: "new-live-site" }) }));
    expect(html).toContain("Loaded 15 pages from new.test");
    expect(html).toContain("more pages may be available; only these pages were used");
    expect(html).toContain("2 pages were skipped");
    expect(html).not.toMatch(/External origin ignored|deadline exceeded|Crawl page limit/);
    vi.stubEnv("IFD_PILOT_MODE", "yes");
    expect(renderToStaticMarkup(await BusinessPage({ params: Promise.resolve({ slug: "new-live-site" }) }))).not.toContain("Loaded 15 pages");
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
