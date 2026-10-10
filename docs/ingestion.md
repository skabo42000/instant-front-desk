# Local ingestion and retrieval (prototype)

Milestone 5, 2026-10-10. This is offline fixture evidence, not a live-site evaluation.
No provider calls, customer results or deployment are demonstrated here.

For a site Bosko has approved, run:

```powershell
npm run ingest -- https://approved-site.example/
```

The command uses the existing crawler and safe fetch boundary, including robots,
exact-origin traversal, private-address blocking and resource caps. It stores a
local PGlite database under ignored `data/instant-front-desk`. A business is keyed
by its origin, so repeated commands use the same business. Ingest the site's root
URL to get its intended page scope. The command replaces the business's current
page snapshot; ingesting a narrower entry point can remove previously stored pages.
Incomplete crawls are rejected without replacing a successful snapshot. A newly
created business may remain empty when its first crawl fails.

Chunks stay within a heading section, have at most 800 characters of text and
approximately 80 characters of overlap. SHA-256 hashes determine stable chunk
UUIDs from page URL, ordinal, heading and text. Repeated unchanged ingestions keep
page/chunk counts and citation IDs stable. Crawl runs are separate audit records.
Changed pages remove obsolete chunks in the same transaction. Existing evaluation
foreign keys can block removing cited chunks; that safely rolls back ingestion
rather than silently breaking saved citations. Versioned evidence is future work.

The fake adapter hashes tokens into normalized vectors; it measures token overlap,
not semantic meaning. Every chunk stores model and dimension metadata. This local
schema accepts 768 dimensions only; a real model with another size needs a schema
migration and re-embedding, never a mixed-space fallback.

`retrieve(question, repository)` returns `status`, `chunks` in the shape accepted
by `answer`, and contacts extracted literally from current page text, with page
URLs. Contacts are separate from relevant answer chunks, so an unsupported query
can still show a sourced contact without treating it as answer evidence. Retrieval
defaults to five nearest chunks and a maximum Euclidean distance of 1.25 on fake
normalized vectors. No close chunks produces `insufficient evidence`. Real-model
thresholds require separate calibration in milestone 10. Literal contact extraction
does not establish that a website's claims are true or that hostile text is safe.

Offline checks:

```powershell
npm run typecheck
npm run test
```

The database tests use actual in-memory PGlite/pgvector, not a mocked repository.
They do not verify multi-connection Postgres concurrency. In a restricted Windows
sandbox, set `TEMP` and `TMP` to an ignored `data/test-temp` folder if Vitest cannot
write to the system temporary directory.

Beginner explanation: ingestion stores small website excerpts; retrieval selects
nearby excerpts for one business. Stable IDs let answers cite the same unchanged
excerpt after another crawl.

Exercise: change the fictional salon's hours in a fixture, predict which chunk ID
changes, and run `npm run test -- tests/unit/ingest.test.ts`. Explain why the contact
chunk should keep its ID. This exercise is not evidence of mastery.
