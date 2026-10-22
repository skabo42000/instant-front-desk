import type { WebsiteLoadSummary } from "@/lib/website-load-summary";

export function WebsiteLoadNote({ summary, host }: { summary: WebsiteLoadSummary; host: string }) {
  const { pages, skipped, truncated } = summary;
  const details = [truncated ? "more pages may be available; only these pages were used" : "",
    skipped ? `${skipped} ${skipped === 1 ? "page was" : "pages were"} skipped` : ""].filter(Boolean);
  return <p role="status">Loaded {pages} {pages === 1 ? "page" : "pages"} from {host}{details.length ? ` (${details.join("; ")})` : ""}.</p>;
}
