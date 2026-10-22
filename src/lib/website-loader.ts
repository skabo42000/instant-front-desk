import "server-only";
import type { PGlite } from "@electric-sql/pglite";
import { stableId } from "./chunk";
import { parsePublicUrl } from "./crawl/url-policy";
import type { CrawlOptions } from "./crawl/crawl";
import { businessRepository } from "./db/repository";
import { getChatServices, type ChatRuntime } from "./chat-runtime";
import { ingest, IngestionError } from "./ingest";
import { localIngestRequestAllowed } from "./local-ingest-policy";
import { ProviderError } from "./models/providers";
import { rememberWebsiteLoad, type WebsiteLoadSummary } from "./website-load-summary";

export interface WebsiteLoadResult extends WebsiteLoadSummary { slug: string }

export function websiteRoot(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2048 || !input.trim()) throw Error("Invalid URL");
  const url = parsePublicUrl(input.trim());
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) throw Error("Private host");
  return new URL("/", url.origin);
}

export function createWebsiteLoader(getDatabase: () => Promise<PGlite>,
  runtime: ChatRuntime = getChatServices, crawlOptions?: CrawlOptions) {
  return async (url: URL): Promise<WebsiteLoadResult> => {
    // Use the exact adapter used by live chat, including its shared call cap/stop.
    const adapter = runtime("gemini-embedding-001").embeddings;
    if (adapter.model !== "gemini-embedding-001" || adapter.dimensions !== 768) throw Error("Wrong embedding space");
    const db = await getDatabase();
    // Keep old CLI practice snapshots separate rather than mixing vector spaces.
    const id = stableId(`${url.origin}\n${adapter.model}`);
    const repo = businessRepository(db, id);
    const slug = `site-${id}`;
    if (!await repo.getBusiness()) await repo.createBusiness({ slug, name: url.hostname,
      sourceUrl: url.origin, phone: null, contactUrl: null, embeddingModel: adapter.model,
      embeddingDimensions: adapter.dimensions });
    const result = await ingest(url.href, repo, { adapter, crawlOptions: { ...crawlOptions, policy: "tolerant" }, batchEmbeddings: true });
    const summary = { pages: result.pages, skipped: result.skipped ?? 0, truncated: result.truncated ?? false };
    rememberWebsiteLoad(slug, summary);
    return { slug, ...summary };
  };
}

export interface WebsiteLoadLock { loading: boolean }
const local = globalThis as typeof globalThis & { frontDeskWebsiteLoadLock?: WebsiteLoadLock };
export const websiteLoadLock = local.frontDeskWebsiteLoadLock ??= { loading: false };

async function readUrl(request: Request): Promise<URL> {
  if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) throw Error("Invalid body");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw Error("Body too large"); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return websiteRoot(JSON.parse(Buffer.concat(parts).toString("utf8"))?.url);
}

export function createWebsiteLoadHandler(load: (url: URL) => Promise<WebsiteLoadResult>,
  env: Readonly<Record<string, string | undefined>> = process.env, lock = websiteLoadLock) {
  return async (request: Request): Promise<Response> => {
    const reply = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
    if (!localIngestRequestAllowed(request, env)) return reply("Not found", 404);
    // Next can use its bind address in request.url even when the browser uses localhost.
    const browserUrl = new URL(request.url);
    browserUrl.host = request.headers.get("host")!;
    if (request.headers.get("origin") !== browserUrl.origin ||
      request.headers.get("sec-fetch-site") === "cross-site") return reply("Please load websites from the local home page.", 403);
    if (lock.loading) return reply("A website is already loading. Please wait for it to finish.", 409);
    lock.loading = true;
    try {
      let url: URL;
      try { url = await readUrl(request); }
      catch { return reply("Enter a public website address starting with http:// or https://.", 400); }
      const { slug, pages, skipped, truncated } = await load(url);
      return Response.json({ location: `/b/${encodeURIComponent(slug)}`, pages, skipped, truncated }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof ProviderError && error.code === "LOCAL_CALL_LIMIT") return reply("Not enough free calls remain in this session to load this website. The remaining calls are still available for chat.", 409);
      if (error instanceof Error && error.name === "FreeTierExhausted") return reply("Free daily limit reached, try again tomorrow. The local safety limit may also need an operator review.", 503);
      if (error instanceof IngestionError) return reply({
        robots: "This site blocks automated reading (robots.txt).",
        empty: "No readable pages found.",
        incomplete: "Could not finish reading this site within the safety limits. Any previously saved pages were kept.",
        unreachable: "Could not reach the site.",
      }[error.reason], 422);
      return reply("Could not load the website. Please try again later.", 503);
    } finally { lock.loading = false; }
  };
}
