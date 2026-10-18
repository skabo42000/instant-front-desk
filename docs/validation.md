# Local validation — October 15, 2026

## Answer prompt v8 live benchmarks — October 18, 2026

Free eval keys, runbook commands, new output paths under `data/benchmarks/2026-10-18/`.

| Site | v7 (Oct 17) pass all | v8 pass all | Errors | Source complete |
| --- | --- | --- | --- | --- |
| Synq | 24/26 | **25/26** | 0 | 19/20 |
| Salon | 22/26 (1 error) | 20/26 | 3 | 15/20 |

Gate 2 strict checks (0 errors, 0 grounding/behaviour fails, ≥18/20 complete): **not passed** on either site.

- Synq's only failure is the chat-widget privacy wording (session ID "kept only in memory for this visit"
  not stated). Raw verdict kept.
- Salon failures:
  - The repeat of "You can always find the most up-." A one-call diagnostic replay (`data/diag/`,
    git-ignored) showed Gemini returns exactly this text with `finishReason=STOP` at temperature 0. It is
    a reproducible model output, not truncation in our code.
  - A correct answer about senior technicians was rejected because it cited 6 sections; the cap was 5
    (the same cap existed in the live chat handler).
  - Two grader execution errors: Groq per-minute token limits, with 25 rate waits at the 3 s case pause.
  - Two verdicts that look strict: the deals answer now says "the website mentions that great deals are
    currently running", which the site states, but the label expects no "currently running"; and a
    correct off-topic refusal marked ungrounded for "I couldn't find that". Raw verdicts are not overridden.
- Fixes (commit 6c970f1):
  - Up to 8 citations in both the provider and the chat handler.
  - Replies ending mid-word are rejected as malformed, so the gateway falls back.
  - `BENCHMARK_PAUSE_MS` makes the case pause configurable.

380 tests pass (1 skipped); typecheck and build pass.

Salon rerun on 6c970f1 with `BENCHMARK_PAUSE_MS=20000` (`salon-answer-v8-judge-v2-run2.json`):
- **24/26 pass all**, 0 execution errors, 0 rate waits.
- Source complete 20/20; correct behaviour 26/26.
- The cut-off and deals cases now pass.

The two remaining failures are both "ungrounded" verdicts:
- The standard "I couldn't find that on this business's website" refusal to an off-topic request. This
  pattern recurs across both sites.
- "booked **online** through Vagaro", where the question itself asks about online booking.

Both look like grader strictness; raw verdicts are kept. Gate 2 stays **not passed** under the strict
rule. Resolving these needs either human calibration (gate 3 pack ready, `data/calibration/`) or a
deliberate judge-policy change, not more answer tuning.

## Local database permissions and coordinator follow-ups — October 17, 2026

Decision (Bosko, October 17): the database runs on this Mac; no Supabase or hosted database.
`npm run check-shared-local` now creates stand-in `anon`, `authenticated` and `service_role` roles
with Supabase-style default grants before applying db/001–008, then checks permissions. Coordinator
live run (`data/local-postgres-proof-permissions.json`): all six checks pass. Browser roles hold no
EXECUTE on the four `ifd_*` functions, no table privileges on the 13 tables and no CREATE on `public`.
Real `SET ROLE anon` attempts to reserve, stop and read `pilot_budget` fail with 42501. pgvector is
in `public`; `service_role` keeps EXECUTE. Scope: local stand-ins, not PostgREST/JWT.

Answer cut-off: the model returned valid JSON containing the broken sentence, so no truncation
happens in our code. Gemini replies whose `finishReason` is present and not `STOP` are now rejected
as malformed. Answer prompt `grounded-cited-v8` adds: never say a deal, offer or availability is
active now unless a source dates it. v8 has offline tests only (360 pass, 1 skip); live benchmarks
on v8 are pending.

## Answer punctuation investigation — October 17, 2026

The saved salon case in `data/benchmarks/2026-10-17/salon-answer-v7-judge-v2-run2.json:1381`
contains `You can always find the most up-.` with 65 output tokens. The report
does not retain the raw provider envelope or candidate finish reason, so the
original full provider text cannot be recovered from this artifact.

No punctuation-based answer truncation was found in the inspected path:
`src/lib/models/providers.ts:92` joins text parts without separators;
`:97` reads the JSON `text` string unchanged; `:98` rejects oversized replies
rather than slicing them. `src/lib/answer.ts:115` only trims outer whitespace.
The sentence split at `src/lib/answer.ts:51` sanitizes source evidence, not the
answer. The list-marker replacement at `:112` is used only for numeric validation,
not returned text. `src/lib/eval/benchmark-runner.ts:115` stores `answer()` directly.
The 65-token count includes generated JSON/citation IDs and potentially thought
tokens (`src/lib/models/providers.ts:133`); it does not prove a longer answer existed.

`tests/unit/answer-punctuation.test.ts` supplies fake Gemini responses through
the real adapter, gateway, answer validation and JSON serialization. Hyphens,
nonbreaking hyphens, dashes, ellipsis, apostrophes, brackets/citation markers,
parentheses, slash, colon, semicolon and sentence punctuation survive unchanged.
These are preservation regressions, not proof of the historical root cause or
a fix for it. Issue A remains unresolved; raw response/finish metadata from the
original call (if retained elsewhere) is needed before attributing a cause.
No additional provider call was made and no speculative text repair was added.

## Runtime/RPC follow-up checks — October 17, 2026

Executed by the delegated worker after the runtime/RPC changes:

- `TMPDIR="$PWD/data/test-temp" TMP="$PWD/data/test-temp" TEMP="$PWD/data/test-temp" npm test -- tests/unit/answer-punctuation.test.ts tests/unit/chat-runtime.test.ts tests/unit/security-review.test.ts tests/unit/provider-stop.test.ts tests/unit/shared-local.test.ts`:
  **35 passed across five files**.
- `TMPDIR="$PWD/data/test-temp" TMP="$PWD/data/test-temp" TEMP="$PWD/data/test-temp" npm test`:
  **358 passed, one skipped (359 total), across 31 files**, exit 0, 139.75 seconds.
  The existing Windows-only descendant cleanup case is skipped on this Mac.
- `npm run typecheck`: exit 0, no diagnostics.
- `NEXT_TELEMETRY_DISABLED=1 TMPDIR="$PWD/data/test-temp" npm run build`:
  exit 0; production webpack compilation, TypeScript, 4/4 static pages and route
  generation completed.
- `TMPDIR="$PWD/data/test-temp" npm run check-shared-local -- --dry-run data/shared-controls-followup-dry-run.json`:
  exit 0; all eight migrations loaded/hashed, no SQL/server execution. A Node
  comparison confirmed all hashes match `data/local-postgres-proof-fix.json`.

The runtime retries stopped-budget persistence on refused requests without
waiting, at most once per 30 seconds, with no overlapping writes. Pending
reservations protect the process cap without counting failed DB reservations.
Empty successful RPC bodies return null; invalid JSON, failed HTTP status,
oversized responses and raw/escaped credential echoes still fail closed.
These are offline checks; no new hosted or direct-SQL live result is claimed.

## Durable quota-stop fix — October 17, 2026

The coordinator supplied a later live failure: private
`data/local-postgres-proof-20261017.json` reported `unsavedStopOutage` failing
with `acceptedAfterRecovery=true`; this worker did not re-run that evidence.
The fix writes an ignored constant marker at `data/provider-stop/quota-stop`
before attempting the shared DB stop. A fresh budget/store checks that marker,
replays `ifd_stop_calls`, and refuses the reservation. A failed lookup/replay
throws instead of allowing a provider call. The marker is sticky, including
after successful replay; there is no automatic reset or migration. Tests use
isolated directories rather than the runtime's marker.

`scripts/shared-local.ts` now exercises the real runtime with fake HTTP quota
after DB shutdown, then checks a fresh budget/store's refusal and the saved
`stopped=true` row after recovery. Earlier DB-persistence checks use an empty
local store so replay cannot mask DB failure. The coordinator's later October 17
report `data/local-postgres-proof-fix.json` (2026-10-17T22:38:27.441Z) records
**5/5 checks passing, local direct-SQL only**: two connections; 24 concurrent
requests with exactly three accepts and zero errors; cross-connection budget
stop; saved-stop recovery; unsaved-stop replay. `unsavedStopOutage` records
`acceptedAfterRecovery=false`, `sharedStopped=true`, `limitationObserved=false`;
cleanup stopped/removed the cluster. This worker did not rerun the live proof.
This is not hosted Supabase/PostgREST or deployment evidence.

Executed offline in this delegated sandbox (temporary paths under ignored
`data/test-temp` because the default OS temp location is not writable):

- `TMPDIR="$PWD/data/test-temp" TMP="$PWD/data/test-temp" TEMP="$PWD/data/test-temp" npm test`:
  **344 passed, one skipped (345 total), across 29 files**. The skip is the
  existing Windows-only cleanup case on this Mac.
- `TMPDIR="$PWD/data/test-temp" TMP="$PWD/data/test-temp" TEMP="$PWD/data/test-temp" npm test -- tests/unit/provider-stop.test.ts tests/unit/pilot-controls.test.ts tests/unit/security-review.test.ts tests/unit/shared-local.test.ts`:
  **26 passed across four files**, including eight new marker/outage regressions.
  Repeated after the final proof-script and DB-only assertion adjustments: same result.
- `npm run typecheck`: passed.
- `NEXT_TELEMETRY_DISABLED=1 TMPDIR="$PWD/data/test-temp" npm run build`: passed.
- `TMPDIR="$PWD/data/test-temp" npm run check-shared-local -- --dry-run data/shared-stop-fix-dry-run.json`:
  passed; eight unchanged migrations loaded/hashed, **no SQL executed**.

Remaining gaps: death before the marker is durable, simultaneous local-write and
DB-stop failure, removed/rolled-back markers, replacement/ephemeral hosts,
different working directories or independent hosts recovering before replay,
and reservations already checked/in flight. File/directory fsync does not prove
power-loss or hardware survival. Render's ephemeral disk and OneDrive sync do
not provide distributed stop safety. All processes must be paused and both local
markers and the DB budget deliberately reviewed/reset by the operator; there is
no public reset flow. See the [exact reset procedure](pilot.md#deliberate-budget-reset-operator-only).
Separate application-process/crash tests, hosted Supabase grants/anonymous denial,
hosted concurrency, hosted PostgREST `ifd_stop_calls` void-response behavior
(empty 2xx/204), and independent release acceptance remain unverified.
See [exact security scope](security-review-2026-10-17.md). No credential files were
inspected, model/network calls made, dependencies/migrations changed or shared records
edited. Pre-existing CRLF-only changes and the case-study draft were left alone.

## Local direct-SQL proof command — added October 17, 2026

Historical command preparation below predates the durable-stop fix above.

`npm run check-shared-local -- --dry-run data/local-postgres-dry.json` validates
loading and hashes of db/001–008 offline. It does not execute migrations or prove
concurrency. `npm run check-shared-local -- data/local-postgres-proof.json` attempts
an isolated embedded Postgres 18.4 run with two connections, the existing shared
limit/budget classes and unchanged SQL migrations. Native pgvector is required;
it is not bundled in the installed embedded package. Missing prerequisites and
sandbox filesystem/loopback failures yield a nonpassing JSON report.

The report distinguishes the 24-request reservation race (three expected accepts,
zero errors), cross-connection budget stop, a stop saved before database restart,
and a stop that cannot be saved during an outage. The latter safety check fails
if reservations resume after recovery, explicitly recording the observed open
limitation from `security-review-2026-10-16.md`; no fix is assumed. Live checks that
never ran carry `pass: false`, `observed: false`. No provider calls or process-local latch claim.

The temporary cluster lives outside OneDrive/project under `~/ifd-postgres`
(override parent with `IFD_POSTGRES_ROOT`), is stopped and removed on completion,
and uses ephemeral credentials omitted from reports. No stand-in roles are needed:
the migrations conditionally grant/revoke existing roles. The proof is local
Postgres via direct SQL, distinct from the actual Supabase PostgREST concurrency,
permissions and outage gates in `pilot.md`. It is not deployment evidence and
does not change application behavior or readiness acceptance.

Executed in the delegated Mac sandbox on October 17: dry run passed (eight
migrations); live attempt failed with `EPERM` creating `~/ifd-postgres`, before
starting Postgres. No concurrency or outage behavior was observed. The full
offline suite passed **336 tests, one skipped, across 28 files**. Typecheck with
`--incremental false` and the production webpack build passed. An earlier
typecheck overlapping build regeneration failed on missing `.next/types` files;
that attempt is not a passing check. Full `git diff --check` reports pre-existing
CRLF whitespace in the four files explicitly excluded from this task.

Prototype only. Bosko authorized free work and confirmed in this chat that both
isolated evaluation accounts are Free with paid billing disabled. This is an
owner-confirmed account setting, not an independently verified billing read.
Provider references: [Gemini billing](https://ai.google.dev/gemini-api/docs/billing)
and [Groq billing](https://console.groq.com/docs/billing-faqs). The local flag does
not select or change an account's billing plan.

## Changes

- Real browser chat uses matching 768-dimensional Gemini query embeddings and the
  existing cited-answer engine. Fake-ingested businesses stay offline. Real mode
  needs explicit local settings and only the isolated evaluation keys.
- All live chat embedding, retry and fallback attempts share a bounded process
  budget. Quota responses stop further provider requests. Restarts reset counters;
  this is not a distributed spending guarantee.
- The live runner can reuse the existing snapshot and an exact approved question
  version, without crawling or regenerating questions. Invalid/unapproved/missing
  versions fail before provider calls. Reused source-question model provenance is
  explicitly unknown (`null`), rather than attributed to a new generator.
- Fixed offline regression questions exercise 13 ordinary fictional cases and the
  six existing traps. New coverage includes regions, business types, numbered
  process steps, launch timing, policy dates, booking conditions and analytics.
  These are scripted checks, not live model-quality measurements.
- Coverage and business-type retrieval prefer relevant heading/text sections.
  Answer rules v5 request complete regional coverage and supported industry lists.
  Version v6 also forbids inferring facts from URL names, retains policy dates when
  the policy label appears only in the heading, and retrieves homepage service
  summaries under marketing headlines. New fixtures cover those failure types.
- Local server commands bind to 127.0.0.1. README now distinguishes current evidence
  from historical failures and gives the actual local setup/replay steps.

## Commands actually run

- `npm test` and `npm run typecheck` were first attempted with restored Windows
  dependencies. That test attempt failed while loading a missing Vitest chunk.
- `npm ci --ignore-scripts --cache /private/tmp/ifd-npm-cache --no-audit --no-fund`:
  sandbox DNS failed, then the approved network retry installed 88 packages from
  the existing lockfile. No dependencies were added.
- `npm run typecheck`: passed after reinstalling dependencies.
- Focused tests for chat runtime/route, retrieval, live runner and UI: 74/75 passed;
  the new launch-timing case found an answer relevance miss. Fixed the generic
  launch heading cue before the full run.
- `npm test`: **283 passed in 21 files** after that fix. After the real-site review
  added the marketing-headline regression and policy-heading fix, the final run
  passed **284 tests in 21 files**.
- `npm run calibration`: four synthetic labels, three agreements, one intentional
  disagreement; fake-judge reporting only.

- `npm run typecheck` and `NEXT_TELEMETRY_DISABLED=1 npm run build`: passed on the
  final code. Webpack is now the build default. The first restored Turbopack build
  stalled while it had private OneDrive database/cache files open and was stopped.
- Initial production HTTP checks returned 500: bundling PGlite changed its file
  URLs and broke loading the pgvector extension. Externalizing both database
  packages fixed this. The repeated, isolated production check returned home 200
  and missing-business 404, with zero model calls. The private harness stopped its
  temporary server afterward.
- All five final server dependency traces were inspected: zero private database,
  report or `.env` file references. An exact-value check found neither real eval key
  in the 37 changed/untracked source files checked (keys were never printed).

## Local restore and live checks

The restored database initially stalled on OneDrive placeholders. A separate
active folder, `data/instant-front-desk-mac`, was created; the original was
preserved. Both server and CLI use the configured `IFD_DATABASE_DIR` in ignored
`.env.local`. Only that non-secret path is read by the shared CLI helper; model
keys and live authorization flags are not loaded by that helper.

The separately approved network retry of the Synq Logic intake rebuilt 7 pages
and 93 chunks in 86 provider attempts. The preceding sandbox attempt made zero
provider calls and did not complete ingestion. Generated question version 1 was
left unapproved. The October 14 report's exact reviewed question text, expected
behavior and evidence IDs were imported as approved version 2; all 26 matched.

Once the original database became readable, its salon snapshot (8 pages, 58
vectors) and reviewed version 3 were copied into the active folder as question
version 1. Question content and evidence were checked for equality. No salon
crawl, ingestion embedding or question-generation calls were needed.

Live commands used `LIVE_OK=yes FREE_TIER_CONFIRMED=yes`,
`IFD_DATABASE_DIR=data/instant-front-desk-mac` and
`IFD_OUTPUT_ROOT=data/mac-session`. Frozen evaluations used
`--reuse-snapshot --question-version N --max-calls 100`; later runs also used
`--pause-ms 8000`. Each report includes exact model/prompt labels and failures.

| Completed run | Questions | Judge result | Errors | Provider attempts |
| --- | --- | --- | --- | --- |
| Synq Logic, answer v5 / judge v4 | Fixed version 2 | 24/26 | 0 | 86 |
| European Beauty Lounge, answer v5 / judge v5 | Restored version 1 | 23/26 | 0 | 73 |
| Synq Logic, answer v5 / judge v5 | Same version 2 | 24/26 | 0 | 74 |
| European Beauty Lounge, answer v6 / judge v5 | Same version 1 | 24/26 | 0 | 74 |

The first Synq run waited out 13 short Groq per-minute responses within its cap;
they did not become execution errors. No daily/exhausted-quota stop occurred in
these completed runs. No billing settings were changed or paid services enabled.

Review found genuine incompleteness and judge mistakes; raw grades were retained.
The first Synq run omitted local coverage and incorrectly failed an unlisted-price
refusal. After fixes, coverage and the industry list passed; a safe rule-breaking
refusal was instead failed for missing contact information that its expected
behavior did not request. The other failure omitted an expected privacy detail.
The salon run exposed the policy-heading and service-overview bugs fixed in v6;
its cookie answer also omitted a detail from the stored expected behavior.
On the final salon run the policy date and complete service list passed. Remaining
failures were the cookie answer's omitted privacy detail and incomplete directions
to current prices/deals on the booking page. One transient Gemini 503 retried
successfully within the call cap. No further full evaluations were run.

Private final reports:

- Synq Logic: `data/mac-session/reports/private/98ac22ad-e99f-4a48-9779-3d89f9c95aec.json`.
- European Beauty Lounge: `data/mac-session/reports/private/f23249bd-6c70-45a7-8435-5b56a1cf0910.json`.
- All four run summaries: `data/mac-session/run-summary.json`.

An assistant review of 11 selected first-Synq cases agreed with the judge on 10/11.
This is **AI review, not human calibration**, and applies to judge v4 only. Private
evidence, labels and a blank owner review sheet are in `data/mac-session/`.
Bosko's own labels remain pending. Do not treat this as measured human agreement.

No deployment, push or contact with any business occurred.

## Final HTTP and live-chat checks

`npm run local-status` selected the configured active database without a shell
path override and showed both businesses (salon approved version 1, Synq version 2).
All database CLIs finished before the shared production server was started.

`npm run start` is running locally at `http://127.0.0.1:3000`.
`npm run smoke` returned home 200, both business pages 200, unknown business 404
and invalid chat input 400, with zero model calls.

The private HTTP chat harness then sent three valid questions through the real
`POST /api/chat` endpoint. All returned 200, `kind: answer`, supporting citations
and the required facts:

- Synq Logic base/coverage: Naperville, Chicago area, western suburbs and remote
  work across the US; three citations.
- Salon services: permanent makeup, lashes, manicures, pedicures and waxing;
  two citations.
- Salon privacy date: September 26, 2026; one citation.

The harness checked for exact API-key echoes before saving or displaying replies:
zero matches. Results are private in `data/mac-session/http-live-chat.json`.
These are HTTP checks, not a visual or interactive browser test. These earlier HTTP checks used the configured 60-attempt process budget. The
server was subsequently stopped at Bosko's request. Later evaluation-foundation
work and its free-tier stop are recorded below.

## Historical live baselines

| Site | Date | Recorded result |
| --- | --- | --- |
| europeanbeautylounge.com | October 12 | 22/26, no execution errors; informal manual review recorded agreement |
| synqlogic.com | October 14 | 24/26, no execution errors, 76 calls; informal manual review recorded agreement |

The October 14 Synq Logic report is
`reports/private/4068bb5d-c252-4354-99dc-3abc07a95a37.json` (ignored/private).
Its failures omit service regions and the industry list. Historical runs changed
question sets, so their scores must not be treated as controlled improvements.

## Remaining limits

Real-site scores cover small owner-site samples. Judge calibration is still
synthetic; prior manual live reviews were informal. PGlite does not establish
multi-connection Postgres behavior. Local rate limits use memory; pilot shared controls are implemented but await
actual Supabase validation. Natural
language grounding and injection protection remain imperfect. Provider quota and
availability may change; there is no authorization to enable paid billing.

## Evaluation foundation and pilot preparation — October 15, 2026

Bosko requested fixed human-reviewed benchmarks, a measured retrieval/reranker
comparison, monitoring/security and controlled pilot preparation. He asked to stop
localhost and chose **human review later**. Localhost was stopped; no public URL,
push, deployment, provisioning, paid billing or business contact occurred.

Implemented immutable owned-site drafts and query caches, explicit browser review
and import, independent retrieval/effective-evidence metrics and separate
grounding/completeness/behavior judgments. Added safe request metadata and list-price
answer cost estimates, shared Postgres rate reservations, a durable total provider
budget, scoped server RPC reads, explicit anonymous/authenticated grant removal,
invitation/origin protections, readiness/probe commands and a Free-plan Render
configuration. See [evaluation evidence](evaluation-foundation.md),
[benchmark data](../benchmarks/README.md), [security scope](../SECURITY.md) and
[pilot gates](pilot.md).

### Executed checks

- `npm test`: final full run **303 passed in 24 files**. An earlier run caught the
  old eleven-table schema assertion; it was corrected to check thirteen scoped
  tables with exactly two documented nullable operational-counter scopes.
- `npm run test -- tests/unit/foundation.test.ts tests/unit/answer.test.ts tests/unit/retrieve.test.ts tests/unit/answer-regression.test.ts`:
  81 passed in the three matching files. The extra nonmatching filename selected
  no additional file. The new price/booking case also verifies that general booking
  directions cannot substitute for a named service's exact price.
- `npm run test -- tests/unit/pilot-controls.test.ts tests/unit/repository.test.ts`: 17 passed after final SQL null-input hardening.
- `npm run typecheck`: passed. `npm run build`: passed, including the pilot proxy,
  health route and local/remote data selection. No visual browser test is claimed.
- `npm run check-pilot`: seven production HTTP checks passed with fake credentials
  and no model calls: health 200, invitation rejection 401, wrong password 401,
  missing/foreign origins 403, authenticated invalid input 400 with request ID,
  unknown route 404. Denial request IDs and no-store were checked. The temporary
  loopback server shuts down in `finally`.
- `npm audit --omit=dev --json --cache /private/tmp/ifd-npm-cache`: first sandbox
  request failed DNS; approved network retry completed with **zero known production
  dependency vulnerabilities**. This is not an audit of all development tooling.
- `git -c core.whitespace=cr-at-eol diff --check`: passed. Existing restored CRLF
  files are handled explicitly rather than reported as whitespace defects.
- Exact isolated-key scan: zero matches across 98 changed/untracked/client-build
  files in the final scan. Seven production trace manifests included no project
  data, reports, benchmarks or environment files. The environment file remains ignored.
- `npm run monitoring -- data/benchmarks/2026-10-15/synthetic-monitoring.jsonl`:
  passed on one explicitly synthetic invalid-input metadata record; no production
  monitoring or answer-quality evidence is claimed.
- `npm run readiness`: deliberately **exit 1, ready false**. Pilot mode and its
  acceptance packet are not enabled. Real Supabase concurrency, account/hosting
  validation, human calibration and independent security review have not run.

Both `benchmark export` commands saved 26-question drafts and immutable source
snapshots. `benchmark review-page` produced the standalone 52-case browser file.
`benchmark pilot-export ... --draft` prepared two guarded SQL imports, without
applying them. Unit tests round-trip a synthetic reviewed import and prevent
overwriting an existing corpus. Real human review was never fabricated.

The query-cache command made 52 successful free Gemini embedding calls across
the two sites after the initial sandbox DNS failure; no new crawl or document
embedding was needed. Retrieval commands then replayed entirely offline. On the
unchanged Synq draft, the generic FAQ change raised exact-reference recall at eight
from 96.25% to 98.75% and complete coverage from 18/20 to 19/20. BM25 reached
17/20 after that change; salon stayed at 18/20 for both. BM25 remains experimental
and is not enabled. Draft reference duplicates/alternatives require human review.
The [saved comparison](../benchmarks/results/2026-10-15-retrieval-draft.json)
contains settings, hashes and per-question rankings.

The new Synq quality diagnostic is **inconclusive**: 26 cases, 58 attempts, two
execution errors, ending in a free-tier stop. It used answer v7 and quality judge
v1. Raw dimensions were 23 grounded, 23 complete and 24 correct-behavior grades;
these are not an accepted pass rate. One observed failed answer attempt recorded
an abnormally long wall time; the cause is unknown. The subsequent salon job was
interrupted after noticing the stop; no report or score was accepted. Further
model calls stopped. The v1 judge made an overstrict citation judgment on a safe
refusal; v2 clarifies that policy/absence statements do not need business-fact
citations, and has offline tests only. Do not compare the new dimensions with the
older single-verdict 24/26 scores or call assistant review human calibration.

Private artifacts live under `data/benchmarks/2026-10-15/`. Public-source drafts,
cached embeddings and retrieval reports are prepared as local files under
`benchmarks/`; no files have been pushed or published. Owner review, a calibrated
judge, complete accepted evaluations, hosted Supabase/PostgREST checks and
independent release acceptance remain before requesting deployment approval.
The later October 17 local direct-SQL 5/5 proof above does not satisfy hosted gates.

## Delegated AI review — later October 15, 2026

Bosko declined manual labeling and asked Codex to perform the review. All 52 cases
were reviewed against the saved sources, with explicit AI provenance. The work
did not invent a human identity, personal-review attestation or calibration score.
It supersedes the earlier "Bosko will review later" dataset workflow.

Both `npm run benchmark -- apply-ai-review DRAFT NOTES OUTPUT` commands completed.
The versioned `ai-review-notes.json` files contain per-case decisions, essential
facts, exact source quotations and limitations. Quote matching rejects missing
support and stays within the original snapshot; semantic labels are AI judgments.
All 52 cases were retained, with no exclusions and unchanged question strings.

Corrections include the extra privacy requirement in the cookies question,
duplicate-reference demands, unnecessary process-introduction evidence and
unrequested wording details. Conditions and unverified/time-sensitive claims
remain explicit. See [review details](ai-review.md).

Both AI-reviewed retrieval commands ran offline with cached query embeddings:
hybrid complete at eight was 20/20 source questions per site; BM25 was 18/20 Synq
and 20/20 salon. All annotated facts survived answer filtering. These are
**new-label baselines**, not answer-quality gains over the previous benchmark.
No new model answers, judge grades, crawls or API calls were made.

New tests verify AI provenance stays `humanReviewed: false`, unsupported quotes
and incomplete notes are rejected, grouped alternatives count correctly, and
AI artifacts cannot remove the existing release guard. Final `npm test`: **305
passed in 24 files**. `npm run typecheck` passed. Original raw diagnostic verdicts,
quota stops and release limitations are unchanged. No localhost server was started.

The delegated-review production build also passed. Final exact-key/build-trace scan: 104 files, zero key matches, zero private traced files. Readiness remains false; no server or deployment was started.

## Offline engineering and MCP completion — October 15, 2026

Confirmed executed in this session (America/Chicago):

- Baseline `npm test`: 305 passing; `npm run typecheck`: pass after required
  sibling-folder filesystem access. The initial sandbox-only attempt could not
  write the TS cache/test artifact and is not counted as a code regression.
- Final `npm test`: **319 tests pass across 25 files**. New tests cover partial
  quota-stop reporting and MCP contracts/security/SDK integration.
- `npm run typecheck`: pass. `NEXT_TELEMETRY_DISABLED=1 npm run build`: pass,
  including the final Next Host-validation fix and TypeScript compilation.
- `npm audit --omit=dev`: zero known vulnerabilities after pinned MCP installation.
- Two `npm run benchmark -- retrieval` runs against the AI-reviewed bundles and
  cached queries: hybrid covers every annotated fact at eight in 20/20 source
  cases per site. No provider/website requests. BM25: 18/20 Synq, 20/20 salon.
- Built production server temporarily bound to `127.0.0.1:3000` with live chat
  explicitly disabled. `node scripts/check-local.cjs`: home + three saved business
  pages 200, missing page 404, invalid chat 400. This does not measure answer quality.
- `node scripts/check-mcp.cjs` with a temporary process-only random secret and
  the two owned-site UUIDs: actual official SDK stdio process discovers exactly
  three tools and reads business metadata/reports through the app-owned PGlite.
  Current saved records: salon 8 pages/58 chunks, Synq 7 pages/93 chunks. Both
  latest database reports are the historical legacy 24/26 runs with zero execution
  errors. No new answer evaluation occurred. Unknown file-only diagnostics were
  not substituted for database evidence.
- Direct production MCP HTTP checks: wrong token 401, cross-origin 403. Temporary
  secret never saved, no client configuration changed; server stopped afterward.
- Scope-specific `git diff --check`: clean for this session's tracked edits. The
  broader existing worktree contains pre-existing CRLF whitespace warnings in
  other modified files; they were not silently represented as a clean whole tree.

Private machine-readable end-to-end evidence:
`data/benchmarks/2026-10-15/mcp-production-check.json`. Setup and limitations:
[docs/mcp.md](mcp.md). These are scripted SDK checks, not a connected assistant
choosing tools. That demonstration remains unavailable in this session.

Bosko selected offline-only completion because quota recovery was not confirmed.
No live models, crawling, spending, pushes, deployments or provisioning occurred.
The new quality judge, actual Supabase concurrency/permissions, independent
security review and pilot release acceptance remain open. AI source review is
complete; no human calibration/sign-off has been fabricated.
