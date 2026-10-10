import "server-only";
import { safeFetch, nodeTransport, type SafeFetchOptions, type Transport } from "./safe-fetch";
import { parsePublicUrl } from "./url-policy";
import { parseRobots } from "./robots";
import { extractHtml, type ExtractedHtml } from "./extract";

export const DEFAULT_CRAWL_LIMITS = {
  maxPages: 15, maxDepth: 2, maxResponseBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024, maxRequests: 30,
  fetchTimeoutMs: 10_000, totalTimeoutMs: 120_000,
} as const;
export type CrawlLimits = { [K in keyof typeof DEFAULT_CRAWL_LIMITS]: number };
export interface CrawlOptions {
  limits?: Partial<CrawlLimits>;
  dns?: SafeFetchOptions["dns"];
  transport?: Transport;
}
export interface CrawledPage extends ExtractedHtml { url: string; depth: number }
export interface CrawlResult {
  pages: CrawledPage[]; requests: number; bytes: number;
  status: "completed" | "stopped";
  errors: { url: string; message: string }[];
}

// Query variants share one visit key to avoid calendars/search loops. Fetch the
// first encountered variant, but check robots against its actual query string.
function visitKey(url: URL): string { return url.origin + url.pathname; }

export async function crawl(input: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const start = parsePublicUrl(input);
  const limits: CrawlLimits = { ...DEFAULT_CRAWL_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === "maxDepth" ? 0 : 1)) throw new Error(`Invalid ${name} limit.`);
  }
  const deadline = performance.now() + limits.totalTimeoutMs;
  const result: CrawlResult = { pages: [], requests: 0, bytes: 0, status: "completed", errors: [] };
  let allowed: ((url: URL) => boolean) | undefined;
  const visited = new Set<string>();
  const transport: Transport = async (request) => {
    if (performance.now() >= deadline) throw new Error("Crawl time limit exceeded.");
    if (request.url.origin !== start.origin) throw new Error("External origin ignored.");
    if (allowed && !allowed(request.url)) throw new Error("Robots disallow.");
    if (result.requests >= limits.maxRequests) throw new Error("Crawl request limit exceeded.");
    if (result.bytes >= limits.maxTotalBytes) throw new Error("Crawl byte limit exceeded.");
    result.requests++;
    const response = await (options.transport ?? nodeTransport)(request);
    return { ...response, body: (async function* () {
      for await (const chunk of response.body) {
        result.bytes += chunk.byteLength;
        // Report all observed bytes, including the chunk that crossed the cap.
        if (result.bytes > limits.maxTotalBytes) throw new Error("Crawl byte limit exceeded.");
        yield chunk;
      }
    })() };
  };
  const fetchPage = (url: string) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error("Crawl time limit exceeded.");
    return safeFetch(url, { dns: options.dns, transport, maxBytes: Math.min(limits.maxResponseBytes, limits.maxTotalBytes - result.bytes),
      timeoutMs: Math.min(limits.fetchTimeoutMs, remaining) });
  };
  const fail = (url: string, error: unknown) => {
    result.status = "stopped";
    result.errors.push({ url, message: error instanceof Error ? error.message : "Crawl failed." });
  };
  const robotsUrl = new URL("/robots.txt", start).href;
  try {
    const robots = await fetchPage(robotsUrl);
    if (robots.status === 404) allowed = () => true;
    else if (robots.status === 200) allowed = parseRobots(robots.body.toString("utf8"));
    else throw new Error(`Robots fetch failed (${robots.status}).`);
  } catch (error) { fail(robotsUrl, error); return result; }

  const queue = [{ url: start, depth: 0 }];
  const scheduled = new Set([visitKey(start)]);
  // Sequential by design: one active safeFetch at a time.
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (visited.has(visitKey(item.url)) || !allowed(item.url)) continue;
    if (result.pages.length >= limits.maxPages) { fail(item.url.href, new Error("Crawl page limit exceeded.")); break; }
    visited.add(visitKey(item.url));
    try {
      const response = await fetchPage(item.url.href);
      const finalUrl = new URL(response.url);
      if (visitKey(finalUrl) !== visitKey(item.url) && visited.has(visitKey(finalUrl))) continue;
      visited.add(visitKey(finalUrl));
      if (response.status !== 200) { result.errors.push({ url: finalUrl.href, message: `Page status ${response.status}.` }); continue; }
      const contentType = response.headers["content-type"];
      if (typeof contentType !== "string" || !/^text\/html(?:;|$)/i.test(contentType)) continue;
      const extracted = extractHtml(response.body.toString("utf8"));
      if (performance.now() >= deadline) throw new Error("Crawl time limit exceeded.");
      result.pages.push({ ...extracted, url: finalUrl.href, depth: item.depth });
      if (item.depth >= limits.maxDepth) continue;
      for (const link of extracted.links) {
        try {
          const url = parsePublicUrl(new URL(link, finalUrl));
          if (url.origin === start.origin && !visited.has(visitKey(url)) && !scheduled.has(visitKey(url))) {
            scheduled.add(visitKey(url));
            queue.push({ url, depth: item.depth + 1 });
          }
        } catch { /* Unsupported links are not crawl targets. */ }
      }
    } catch (error) { fail(item.url.href, error); break; }
  }
  return result;
}
