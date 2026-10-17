# Evaluation foundation — October 15, 2026

The benchmark is versioned and reproducible. Bosko subsequently declined manual
labeling and delegated it to Codex: **52 explicit AI source reviews are complete**.
Original drafts are preserved. AI provenance remains distinct from human review;
there is no human-calibrated quality score or calibrated new judge. See
[the AI review record](ai-review.md). No customer use or production traffic is claimed.

## Offline regression and online monitoring

The split follows [LangChain's evaluation types](https://docs.langchain.com/langsmith/evaluation-types):
curated reference data compares changes before release; production monitoring
observes real requests and supplies examples for later, separately reviewed datasets.
No LangSmith subscription or SDK is needed here.

The [owned-site drafts](../benchmarks/README.md) freeze 52 questions, 15 saved pages,
151 chunks, stored vectors and 52 query embeddings. Files have content hashes.
Review records contain corrected expectations, required facts and source IDs,
with explicit decisions and human/AI provenance. Exclusions remain visible. A review import
cannot replace the snapshot, change a case's identity/kind or borrow another
business's evidence. A changed test set gets a new hash and cannot silently
replace the comparison baseline.

## Measurements

Retrieval reports recall at 1, 5 and 8, mean reciprocal rank, complete annotated
evidence coverage and full-pool recall. It also measures the evidence surviving
answer filtering. Trap questions with no gold IDs are excluded from retrieval
averages. The original hybrid can return more than eight chunks; full-pool results
are reported separately from the fair eight-chunk reranker comparison.

The new answer runner separates:

- Grounding: claims supported by the **cited** evidence.
- Completeness: answers the question and reviewed required facts.
- Correct behavior: answers supported questions and safely refuses traps.
- Citation-ID validity: a deterministic structural check, not proof of grounding.
- Execution errors, retrieval/answer/judge timings, provider attempts and known
  answer-token cost estimates. Errors never pass.

Gold reference sections go to the completeness judge separately. They are never
injected into the answer or counted as retrieved evidence. The judge's family
must differ from the actual answer family, including fallback answers. Reports
record prompt/model versions and hashes. The comparison command rejects differing
benchmarks, snapshots, query caches, judge configurations or case identities.

## Retrieval experiment

One CPU-only BM25 candidate reranks the same hybrid candidate pool. It does not
see gold IDs, expected answers or required facts. This is a lexical reranker;
no neural cross-encoder was evaluated. No inference service or new dependency
was added. The candidate remains isolated from production chat.

Prespecified promotion rule: human-reviewed benchmark, at least a five percentage
point gain in complete reference coverage at eight chunks, no answer/safety
regressions and at most 100 ms added p95. An answer comparison is required before
promotion even when retrieval improves. A candidate that fails retrieval need
not consume additional model quota for an answer comparison.

Provisional measurements on the unchanged draft questions and cached real Gemini
queries (October 15, recorded local runs):

| Site and implementation | Hybrid recall @8 | Hybrid complete @8 | BM25 recall @8 | BM25 complete @8 |
| --- | --- | --- | --- | --- |
| Synq, before FAQ heading improvement | 96.25% | 18/20 | 87% | 16/20 |
| Synq, after FAQ heading improvement | 98.75% | 19/20 | 89.5% | 17/20 |
| Salon | 90% | 18/20 | 90% | 18/20 |

Added BM25 p95 ranged from about 0.3 to 1.5 ms in local runs, with concurrent checks
affecting timing. This measures local reranking CPU time, not deployed request
latency. The benchmark has duplicate/alternative
evidence among some draft references; missing one annotated ID may still leave
the needed fact in another chunk. Human review must resolve this before adoption.
**Decision: retain hybrid search.** These results do not justify the candidate's
extra complexity. They establish no conclusion about neural rerankers.
The [machine-readable reports](../benchmarks/results/2026-10-15-retrieval-draft.json)
retain provenance and per-question rankings for both sites.

Generic fixes retain FAQ sections for technical-skill questions, keep booking-page
directions available for price questions, and ask the answer model to preserve
explicit privacy exclusions when answering collection questions. No business IDs,
gold chunk IDs or benchmark-specific answers enter production retrieval rules.
Remaining answer omissions are not declared fixed until reviewed evaluation passes.

## Live diagnostic limitations

The new Synq diagnostic used the frozen draft, cached queries, answer prompt v7
and quality judge v1: 26 cases, 58 provider attempts, **two execution errors**.
Raw dimensions: 23 grounded, 23 complete and 24 correct-behavior judgments out
of 26; these are **inconclusive diagnostics**, not an accepted pass rate. One
observed failed answer attempt had an abnormally long recorded wall time; its
cause is unverified. The final judge call exhausted free quota. Further model
work stopped; the salon diagnostic was interrupted without an accepted report.

The judge incorrectly demanded evidence for the policy statement in a safe
"not found" refusal. It also treated a missing state abbreviation as incomplete.
Both need human calibration; raw verdicts were preserved. Judge prompt v2 now
explicitly distinguishes policy statements and absent facts from business claims.
It has offline tests only and has not been rerun live. Earlier 24/26 legacy scores
used a different single-verdict judge and cannot be compared numerically to this
three-dimension diagnostic.

Future live runs checkpoint every completed case and save fixed provider failure
labels/quota details. Interrupted reports remain partial, never accepted. Output
paths are checked before model calls so an existing filename cannot waste quota.

## Commands after human review and quota recovery

For the AI-reviewed provisional run authorized in the October 17 task brief,
use the [gate 2 runbook](pilot-gate-2-runbook.md). Both expected accepted-input
bundles and reviewed caches now exist; its pinned live commands use fresh answer
output paths and require no embedding calls. This does not mark the dataset
human-reviewed or change the release gate. The commands below are historical
templates, not an instruction to overwrite the prepared files.

Do not run these live commands until the owner has confirmed quota has reset;
both accounts must remain Free with paid billing disabled. Keys stay in ignored
`.env.local`. Only isolated evaluation keys are loaded by the CLI.

```sh
# Reuse unchanged queries; only edited questions need new embeddings.
LIVE_OK=yes FREE_TIER_CONFIRMED=yes npm run benchmark -- cache-queries data/benchmarks/synq-accepted.json data/benchmarks/synq-reviewed-queries.json benchmarks/owned-sites/2026-10-15/synq/queries.json
LIVE_OK=yes FREE_TIER_CONFIRMED=yes npm run benchmark -- answer data/benchmarks/synq-accepted.json data/benchmarks/synq-reviewed-queries.json data/benchmarks/synq-baseline.json
# Candidate runs use the identical accepted bundle and query cache.
npm run benchmark -- compare data/benchmarks/synq-baseline.json data/benchmarks/synq-candidate.json data/benchmarks/synq-comparison.json
```

The candidate file must come from a real subsequent run; comparison does not
generate or alter answers. Use `--top8` on both runs for an equal-budget comparison,
and `--bm25` only for the experimental reranker. Do not promote it based on the
current negative retrieval result. Run the same process for the second site.

## Monitoring boundary

Chat JSON logs contain a generated request ID, business ID, fixed failure/refusal
reason, timings, evidence counts, models, attempts and token/cost metadata. The
ID is returned in `X-Request-ID`, including invalid requests and failures. Raw
questions, answers, source text, cookies, IPs, keys and provider exceptions are
not logged. Log sink failures cannot break an answer. No user conversation store
or background evaluation of visitors was added.
Pilot invitation/origin denials use separate `pilot.denied` events and their own
request IDs; monitoring lists those counts separately from chat requests.

`npm run monitoring -- /path/to/exported-logs.jsonl` summarizes p50/p95, errors,
rate limits, refusals and missing cost data. It does not infer answer quality.
No real production monitoring results exist yet. Host access logs are separate
from this application schema and need review before inviting anyone.

Price catalog `public-list-usd-2026-10-15` estimates standard text equivalent paid
usage at Gemini 3.5 Flash-Lite $0.30/$2.50 and GPT-OSS 120B $0.15/$0.60 per million
input/output tokens, verified against [Google](https://ai.google.dev/gemini-api/docs/pricing)
and [Groq](https://console.groq.com/docs/models). These are not invoices on the
owner's confirmed free accounts. Missing usage/prices remain null. Embedding,
judge and failed-call billing is incomplete; a known answer-cost subtotal is
never labeled total cost. Gemini thinking tokens are included when returned.

AI Squad's **planned**, not completed, Phase 3 informed request IDs, structured
logs and explicit input/output policy boundaries. No claim is made that its
guardrail phase was already implemented or copied. Here the policy is in
`answer.ts`, input/body/origin limits in `chat-handler.ts`, provider budgets in
`shared-controls.ts` and security/deployment gates in [pilot readiness](pilot.md).

## Offline completion check — October 15, 2026

The runner now stops immediately after a global quota/budget latch. It preserves
completed attempts and marks the report partial, with expected/completed/unattempted
counts, instead of inventing error rows for questions it never attempted. Failed
answer/judge stages retain elapsed timing. Partial reports cannot be compared as
completed runs. A fictional regression test exercises a judge quota stop.

Fresh cached retrieval runs on both AI-reviewed bundles found every annotated fact
in the hybrid top eight for 20/20 source questions per site. Both full effective
evidence pools also covered every annotated fact. BM25 covered 18/20 Synq and
20/20 salon source questions at eight. This reproduces the AI-reviewed evidence
baseline; it is not new answer-quality evidence or human calibration. Private
artifacts: `data/benchmarks/2026-10-15/{synq,salon}/retrieval-completion-check.json`.

Bosko confirmed quota recovery was **not checked** and requested offline work in
this session. No model calls were made; live three-dimension answer/judge testing
remains deferred. Existing release gates were preserved.
