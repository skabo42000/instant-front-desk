import { localDatabasePath, openDatabase } from "../src/lib/db/client";
import { businessRepository } from "../src/lib/db/repository";
import { stableId } from "../src/lib/chunk";
import { parsePublicUrl } from "../src/lib/crawl/url-policy";
import { FakeEmbeddings } from "../src/lib/models/embeddings";
import { ingest } from "../src/lib/ingest";

export async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Usage: npm run ingest -- https://approved-site.example/");
  const url = parsePublicUrl(args[0]);
  const businessId = stableId(url.origin);
  const adapter = new FakeEmbeddings();
  const db = await openDatabase(localDatabasePath());
  try {
    const repo = businessRepository(db, businessId);
    if (!await repo.getBusiness()) await repo.createBusiness({ slug: `site-${businessId}`, name: url.hostname,
      sourceUrl: url.origin, phone: null, contactUrl: null, embeddingModel: adapter.model });
    console.log(JSON.stringify({ businessId, ...await ingest(url.href, repo, { adapter }) }));
  } finally { await db.close(); }
}

