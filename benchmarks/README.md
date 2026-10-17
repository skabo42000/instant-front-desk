# Fixed owned-site benchmarks

These files contain the owner's public website text, stored chunk embeddings and
cached query embeddings. They contain no visitor conversations or credentials.
Exported October 15, 2026 from the saved local corpora: Synq Logic (7 pages, 93
chunks) and European Beauty Lounge (8 pages, 58 chunks). Original fetch dates are
not preserved by this export; the salon corpus was restored rather than crawled
again. Both use `gemini-embedding-001`, explicitly 768 dimensions.

**Status: all 52 cases have AI review notes; no human review.** Bosko delegated
label review to Codex on October 15 rather than doing it manually. Original drafts
remain unchanged. Each site's `ai-review-notes.json` contains explicit decisions,
required facts, matching source quotations and limitations. The importer always
records `method: "ai"`, `humanReviewed: false` and provisional reports. Database
approval or AI review is not evidence of human judgment or calibrated accuracy.

Rebuild the AI-reviewed bundles entirely offline:

```sh
npm run benchmark -- apply-ai-review benchmarks/owned-sites/2026-10-15/synq/draft.json benchmarks/owned-sites/2026-10-15/synq/ai-review-notes.json /tmp/synq-ai-reviewed.json
npm run benchmark -- apply-ai-review benchmarks/owned-sites/2026-10-15/salon/draft.json benchmarks/owned-sites/2026-10-15/salon/ai-review-notes.json /tmp/salon-ai-reviewed.json
npm run benchmark -- retrieval /tmp/synq-ai-reviewed.json benchmarks/owned-sites/2026-10-15/synq/queries.json /tmp/synq-ai-retrieval.json
```

Each required fact has a group of alternative evidence chunks. One supporting
alternative suffices; duplicate footers no longer count as separate required
facts. Quotations must match the frozen same-business source. This validates
quote provenance, not the semantic correctness of an AI label. The new label
hashes differ from the drafts, so their scores cannot be treated as model gains
against the old labels. Details: [AI review record](../docs/ai-review.md).

The [recorded retrieval comparison](results/2026-10-15-retrieval-draft.json) includes
both sites' hashes, settings, timings and per-question rankings. It is provisional
and keeps hybrid search as the default. These files are local changes prepared
for version control; publishing or pushing them still requires owner approval.

`snapshotHash` covers the business, pages, chunks and vectors. `draftHash` ties
review imports to the original questions and references. Accepted benchmark hashes
also cover reviewed questions, required facts, include/exclude decisions and the
review attestation. Exclusions retain their reasons and counts. Reports must have
the same benchmark, snapshot, query-cache hash and judge configuration to compare.

Run retrieval experiments **without network or keys**:

```sh
npm run benchmark -- retrieval benchmarks/owned-sites/2026-10-15/synq/draft.json benchmarks/owned-sites/2026-10-15/synq/queries.json /tmp/synq-retrieval.json --draft
npm run benchmark -- retrieval benchmarks/owned-sites/2026-10-15/salon/draft.json benchmarks/owned-sites/2026-10-15/salon/queries.json /tmp/salon-retrieval.json --draft
```

Outputs are write-once; choose a fresh filename for another run. Removing
`--draft` requires completed human review. No fake embedding substitution is
allowed against real vectors. The query cache hashes exact question text: edited
questions need new embeddings, while unchanged questions can reuse their vectors.

Open `review.html` after generating it with:

```sh
npm run benchmark -- review-page /tmp/ifd-review.html benchmarks/owned-sites/2026-10-15/synq/draft.json benchmarks/owned-sites/2026-10-15/salon/draft.json
```

The file runs entirely in your browser, with no server or external connections.
Read the saved sections, correct the question/expectation, list essential facts,
correct reference IDs, explicitly include or exclude every case, enter your name
and attest personal review. Download each site's reviewed JSON. Then import it:

```sh
npm run benchmark -- import-review benchmarks/owned-sites/2026-10-15/synq/draft.json /path/to/synq-reviewed.json data/benchmarks/synq-accepted.json
```

Reference-ID recall is distinct from semantic fact coverage. Several draft
references repeat facts available in other chunks; a retrieval miss against
that particular ID does not prove the answer lacked the fact. Correct this during
human review rather than tuning search to particular gold IDs. IDs must belong
to the same saved business. Trap cases with no reference IDs are ineligible for
retrieval recall; they are not counted as perfect retrieval.

The implementation also reports evidence surviving answer filtering. Independent
answer grades separate grounding against cited evidence, completeness against
reviewed required facts, and correct answer/refusal behavior. These are model
judgments requiring human calibration; deterministic citation checks alone do not
establish factual grounding.
