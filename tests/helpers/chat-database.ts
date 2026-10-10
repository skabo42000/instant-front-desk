import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { businessRepository } from "../../src/lib/db/repository";
import { FakeEmbeddings } from "../../src/lib/models/embeddings";
import { ingest } from "../../src/lib/ingest";
import { fixtureCrawl } from "./fixture-crawl";
export async function seedChatDatabase(): Promise<PGlite> {
  const db = await openDatabase();
  for (const [id, site] of [["00000000-0000-0000-0000-000000000001", "bright-salon"],
    ["00000000-0000-0000-0000-000000000002", "maple-repair"]] as const) {
    const repo = businessRepository(db, id);
    await repo.createBusiness({ slug: site, name: site, sourceUrl: `https://${site}.test`, phone: null,
      contactUrl: null, embeddingModel: new FakeEmbeddings().model });
    await ingest(`https://${site}.test/`, repo, { crawlOptions: fixtureCrawl(site) });
  }
  return db;
}
