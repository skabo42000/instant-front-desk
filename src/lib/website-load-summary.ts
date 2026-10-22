import "server-only";

export interface WebsiteLoadSummary { pages: number; skipped: number; truncated: boolean }
const local = globalThis as typeof globalThis & { frontDeskWebsiteSummaries?: Map<string, WebsiteLoadSummary> };
const summaries = local.frontDeskWebsiteSummaries ??= new Map<string, WebsiteLoadSummary>();

export function rememberWebsiteLoad(slug: string, summary: WebsiteLoadSummary): void {
  summaries.delete(slug);
  summaries.set(slug, summary);
  // Feedback is local process memory, not a benchmark or permanent quality claim.
  if (summaries.size > 100) summaries.delete(summaries.keys().next().value!);
}
export function websiteLoadSummary(slug: string): WebsiteLoadSummary | undefined { return summaries.get(slug); }
