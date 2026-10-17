# Provisional owned-site answer benchmarks — October 17, 2026

Prepared offline for the coordinator. No provider calls, credentials, server,
deployment or release approval were used during preparation. The coordinator's
task brief reports Gemini/Groq quota probes returned 200 on October 17; this
worker did not repeat or independently verify them.

“Accepted” filenames identify the AI-reviewed dataset inputs, **not accepted
answer results or release evidence**. All bundles and caches explicitly retain
`reviewMethod=ai`, `humanReviewed=false`, `provisional=true`. The actual bundle
review method remains `ai`. Human calibration and the release policy in
[pilot gates 1–3](pilot.md#gates-before-requesting-deployment-approval) are unchanged.

## Prepared inputs and provenance

| Site | Accepted bundle | Reviewed query cache | Benchmark hash |
| --- | --- | --- | --- |
| Synq | `data/benchmarks/synq-accepted.json` | `data/benchmarks/synq-reviewed-queries.json` | `91c0ff511defba39a261801aef8198b5d799e185e71d8639ba98442c1789fb88` |
| Salon | `data/benchmarks/salon-accepted.json` | `data/benchmarks/salon-reviewed-queries.json` | `a1494474eab61e2c6a9e6d4dc6818739e6d36a3fa96990b7266b55800b0537ad` |

Each bundle preserves its corresponding
`data/benchmarks/2026-10-15/{synq,salon}/ai-reviewed.json` cases, snapshot,
review identity/date/notes hash and benchmark hash. Source review notes are
`benchmarks/owned-sites/2026-10-15/{synq,salon}/ai-review-notes.json`;
the matching versioned `queries.json` supplies every vector unchanged.
Both sites retain 20 source questions and all six trap categories, with zero
exclusions. All 26 query vectors per site match question fingerprints and the
snapshot/model, have 768 finite components, and are reused without re-embedding.
**Questions needing new embedding calls: none (both sites).**

The following preparation commands were executed successfully. They write
exclusively and must not be repeated with these existing output names. For a
fresh reconstruction, choose new bundle/cache names together:

```sh
npm run benchmark -- prepare-accepted data/benchmarks/2026-10-15/synq/ai-reviewed.json benchmarks/owned-sites/2026-10-15/synq/queries.json data/benchmarks/synq-accepted.json data/benchmarks/synq-reviewed-queries.json
npm run benchmark -- prepare-accepted data/benchmarks/2026-10-15/salon/ai-reviewed.json benchmarks/owned-sites/2026-10-15/salon/queries.json data/benchmarks/salon-accepted.json data/benchmarks/salon-reviewed-queries.json
```

The offline plan command loads an isolated **in-memory** snapshot and runs real
retrieval and answer prechecks with a synthetic empty answer adapter. It never
reads `.env.local`, selects a real provider, grades quality or calls the network.
Executed successfully for both sites:

```sh
npm run benchmark -- plan-answer data/benchmarks/synq-accepted.json data/benchmarks/synq-reviewed-queries.json data/benchmarks/2026-10-17/synq-answer-plan.json
npm run benchmark -- plan-answer data/benchmarks/salon-accepted.json data/benchmarks/salon-reviewed-queries.json data/benchmarks/2026-10-17/salon-answer-plan.json
```

These plan outputs already exist. Their per-case counts identify the four
deterministic refusals per site: `ignore-your-rules`, `prompt-injection`,
`off-topic`, `price-not-listed`. All 20 source cases and the other two traps
reach the answer adapter. The plan measures routing, not whether real answers
will pass the judge.

## Ordered live commands — coordinator only, not executed here

Run from the project root with existing isolated evaluation credentials securely
available to the process or in ignored `.env.local`. Do not source the entire
file. `scripts/live.ts:evalKeysFromFile` parses only the two eval key names;
`evaluationProviders` uses only those names. Process eval keys override file
eval keys. Main Gemini/widget key names are never selected by this path.
No credential values were read or compared here, so account ownership, distinct
key values and billing state remain the coordinator's verified prerequisites.

The explicit model assignments below override inherited model settings and
disable optional intra-Gemini model fallbacks. Answer prompt is
`grounded-cited-v7`; the **quality** judge is `grounding-completeness-v2`
(`GroqQualityJudge`, not the legacy single-verdict judge). Embeddings are
`gemini-embedding-001`, 768 dimensions, read solely from the prepared cache.
The CLI still configures Groq as the answer gateway's final fallback. Its
`openai-oss` answers cannot be judged by the same family: they are execution
errors and cannot pass gate 2.

1. Run Synq:

   ```sh
   LIVE_OK=yes FREE_TIER_CONFIRMED=yes GEMINI_ANSWER_MODEL=gemini-3.5-flash-lite GEMINI_TEXT_MODEL=gemini-3.5-flash-lite GEMINI_TEXT_FALLBACK_MODELS= GROQ_MODEL=openai/gpt-oss-120b npm run benchmark -- answer data/benchmarks/synq-accepted.json data/benchmarks/synq-reviewed-queries.json data/benchmarks/2026-10-17/synq-answer-v7-judge-v2.json
   ```

2. Inspect Synq's final JSON before continuing. Require `partial` absent/false,
   `stopReason=null`, 26 completed results, zero execution errors, no grounding
   or behavior failures, and at least 18/20 complete source answers. Preserve
   failures. A successful CLI exit alone is insufficient. If any quota/cap stop
   occurs, stop the batch; do not start salon or automatically retry.

3. If quota remains available and Synq did not stop, run salon:

   ```sh
   LIVE_OK=yes FREE_TIER_CONFIRMED=yes GEMINI_ANSWER_MODEL=gemini-3.5-flash-lite GEMINI_TEXT_MODEL=gemini-3.5-flash-lite GEMINI_TEXT_FALLBACK_MODELS= GROQ_MODEL=openai/gpt-oss-120b npm run benchmark -- answer data/benchmarks/salon-accepted.json data/benchmarks/salon-reviewed-queries.json data/benchmarks/2026-10-17/salon-answer-v7-judge-v2.json
   ```

4. Apply the same checks to salon. Keep both provisional reports for review.
   Passing these checks does not satisfy human calibration or authorize release.

Both proposed final paths and their `.partial.json` siblings were absent at
preparation time. The CLI rechecks both before loading credentials/provider
calls and refuses existing paths. Do not run `cache-queries` again: its expected
output already exists and all embeddings are present. Do not use `--draft`,
`--top8` or `--bm25` for these full-hybrid baseline runs. No candidate comparison
is required for this gate.

## Provider call budget and stop behavior

Counts apply independently to **each site**, under the pinned configuration:

| Stage | Expected successful first-attempt calls |
| --- | ---: |
| Gemini `gemini-3.5-flash-lite` answers | 22 |
| Groq `openai/gpt-oss-120b` quality judges | 26 |
| Gemini query/source embeddings | 0 |
| Total | 48 |

Across both sites the nominal total is 96: 44 answers, 52 judges, zero embeddings.
These are predicted attempts, not calls already made or guaranteed availability.

`ModelGateway` allows two primary Gemini routes then one Groq fallback route.
`guardedTransport` permits one transient retry per adapter request and at most
three short per-minute rate waits **across that request**, giving at most two
HTTP attempts without rate waits, or five including them. Optional Gemini model
fallbacks are disabled by the commands. Upper bounds ignoring deadlines:

- No rate waits: 140 HTTP attempts per site. Two Gemini routes can use 88
  attempts; 26 judges can use 52. Replacing a judge with a Groq fallback costs
  the same maximum two attempts, since a fallback-family result is not judged.
- With rate waits: 350 HTTP attempts per site (220 Gemini attempts plus 130
  Groq judge attempts, or an equivalent mixture of Groq fallbacks and judges).
- The actual enforced maximum is **100 total HTTP attempts per answer process**;
  this cap overrides both larger bounds. Timeouts or errors may end work earlier.
  Stage maxima are not additive with fallback maxima: Groq fallback and judging
  are mutually exclusive for that case. The plan's bounds assume no added model
  fallbacks and may decrease under the 22/65-second gateway deadlines.

429/quota responses latch `FREE_TIER_EXHAUSTED`, except an explicitly identified
per-minute limit with numeric Retry-After <=20 seconds: the guard permits up to
three waits of Retry-After+1 seconds per adapter request, counting every retry
against the cap. Daily, unknown, longer or persistent minute limits stop the run.
The cap latches `REQUEST_CAP_REACHED`. Neither enables billing or makes further
HTTP calls after the latch. The CLI guard is process-local; starting another
process would reset it, so the operator must stop the whole batch on a latch.

Completed cases are checkpointed at `OUTPUT.partial.json`. An orderly quota/cap
stop writes the final `OUTPUT` with `partial=true`, fixed error/limit details,
attempt logs, expected/completed/unattempted counts, then removes the checkpoint.
A process interruption can leave only the checkpoint. Unattempted cases do not
receive invented error rows. Partial results never pass readiness or comparison.
Non-quota execution errors may allow later cases; those runs still fail gate 2.

## Checks actually executed

- `npm run typecheck`: passed, including after the new tests were added.
- `TMPDIR="$PWD/data/test-tmp" npm test -- tests/unit/accepted-inputs.test.ts tests/unit/foundation.test.ts tests/unit/providers.test.ts tests/unit/gateway.test.ts tests/unit/live.test.ts`:
  **62 passed across five files**. Covers source-note reconstruction, preserved
  AI provenance/hashes/vectors, precise changed-query lists, mismatched caches,
  key isolation, prompt/judge behavior, retries, family independence and quota stops.
  The first attempt without TMPDIR failed before running any tests because the
  sandbox could not create Vite's cache in the OS temp directory. The project
  temp directory was created with `mkdir -p data/test-tmp` before the passing run.
- Both `prepare-accepted` and both `plan-answer` commands above passed offline.
- `npm run benchmark -- retrieval data/benchmarks/synq-accepted.json data/benchmarks/synq-reviewed-queries.json data/benchmarks/2026-10-17/synq-accepted-retrieval.json`
  and the equivalent salon command passed: 26 cases each, 20 retrieval-eligible
  source questions each, zero exclusions, hybrid complete at eight **20/20 each**,
  effective evidence recall 1. BM25 complete at eight: Synq 18/20, salon 20/20.
  These are retrieval checks against AI labels, not live answer-quality results.
- `git diff --check -- scripts/benchmark.ts docs/evaluation-foundation.md`:
  passed. The whole-tree `git diff --check` failed on existing CRLF whitespace
  in `src/lib/chat-limits.ts`, `tests/helpers/chat-database.ts`,
  `tests/unit/chat-route.test.ts`, `tests/unit/ui.test.ts`; those files and the
  pre-existing `docs/mcp-case-study.md` draft were left untouched. Git printed
  sandbox temp-cache warnings but returned status/diff results.
- No production build or full-suite rerun is claimed for this bounded change.
  No security/runtime/shared-control files or migrations were edited.

Beginner explanation: the questions, source facts and saved vectors are ready;
the next stage asks two independent model families to answer and grade them.
An optional learning exercise is to find one deterministic refusal in an offline
plan and explain why it still needs a judge call. This is a suggestion, not a
claim of demonstrated learning or a required task for Bosko.
