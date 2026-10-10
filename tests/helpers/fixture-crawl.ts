import { readFileSync } from "node:fs";
import type { CrawlOptions } from "../../src/lib/crawl/crawl";

export function fixtureCrawl(site: "bright-salon" | "maple-repair"): CrawlOptions {
  return {
    dns: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async request => {
      const file = request.url.pathname === "/" ? "index.html" : request.url.pathname.slice(1);
      if (!["index.html", "services.html", "robots.txt"].includes(file)) throw new Error("Unexpected fixture request");
      const text = readFileSync(`tests/fixtures/${site}/${file}`, "utf8");
      return { status: 200, headers: { "content-type": file.endsWith("html") ? "text/html" : "text/plain" },
        body: (async function* () { yield Buffer.from(text); })(), destroy() {} };
    },
  };
}
