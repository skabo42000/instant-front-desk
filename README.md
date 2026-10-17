# Instant Front Desk (working name)

Local prototype, updated October 15, 2026. Collect an approved business website,
ask questions grounded in its saved pages, and inspect an answer score card.
Built with Next.js, TypeScript, Tailwind, local Postgres (PGlite + pgvector),
Gemini answers/embeddings and an independent Groq judge. No public deployment or
customer-use evidence. Scope and dated decisions: [project brief](docs/brief.md).

The evaluation foundation now has [versioned owned-site snapshots and query caches](benchmarks/README.md),
separate retrieval/grounding/completeness checks, a browser-only human-review file,
and same-benchmark comparisons. **All 52 questions now have an explicit AI source
review**, delegated by Bosko instead of manual labeling; this is not human review
or independent judge calibration. See [the review record](docs/ai-review.md).
Localhost is intentionally stopped; there is no public testing URL yet.

Hybrid search remains the default: a BM25 reranker reduced complete reference
coverage on the Synq draft and showed no gain on the salon draft. Shared Postgres
rate limits, persistent provider-call budgets, request metadata, safe cost
estimates and invitation-only pilot controls are implemented. See
[evaluation evidence and limitations](docs/evaluation-foundation.md) and the
[controlled pilot package and gates](docs/pilot.md). Nothing has been deployed.

## Local MCP extension

Three read-only MCP tools now expose explicitly approved business metadata and
saved legacy evaluation reports through the running app's shared database. The
API is disabled by default, loopback-only by configuration and unavailable in
pilot mode. See [MCP setup, security bounds and verification](docs/mcp.md). This
extension makes no model calls. A connected-assistant demonstration is pending.

## Legacy live evidence

| Website | Recorded complete live run | Result | Limits |
| --- | --- | --- | --- |
| European Beauty Lounge | October 15, 2026 | 24/26, no execution errors, 74 provider attempts | Fixed restored question set; remaining misses concern a privacy detail and where current prices/deals are listed. |
| Synq Logic | October 15, 2026 | 24/26, no execution errors, 74 provider attempts | Fixed question set; one missing privacy detail and one judge error on a safe refusal. |

These are small samples on the owner's sites, not customer results. Questions
were regenerated between older runs; October 15 reruns freeze approved lists and
the active snapshots. Private reports retain questions, answers, citations, verdicts, errors,
model labels and prompt versions. New frozen reruns reuse both the stored site
snapshot and an exact approved question version.

Those scores use the older single-verdict judge. The new three-dimension Synq
diagnostic hit free-tier exhaustion and had two execution errors, so it is
inconclusive. Do not compare its grades with the legacy pass rates. Further model
calls stopped; the new judge still needs human calibration and quota recovery.

October 15 changes connect real local browser chat to matching Gemini embeddings,
add process-wide call/quota stops, improve coverage/list retrieval and policy-date
handling, fix database packaging at runtime, and add fixed fictional regression cases. See
[validation notes](docs/validation.md) for commands and new live results.

## Open the local app

Use Node.js 22 LTS or newer. Install the existing locked dependencies with
`npm ci`, then run:

```sh
npm run dev
```

Open http://127.0.0.1:3000. The home page lists saved businesses. Each
`/b/<slug>` page has chat and its latest saved score card with failures/errors.
The server binds to this machine. No public ingestion, question-editing or
administration endpoints exist.

Stop the server with Ctrl+C before any database CLI command. The CLI and server
share `data/instant-front-desk`; PGlite supports only one process here.

`IFD_DATABASE_DIR` can select another local folder without replacing the default
database. Both the web server and CLI read this setting from `.env.local`; a
process-environment override takes precedence. On this restored Mac, the active
folder is `data/instant-front-desk-mac`. An optional output-root override keeps
the current validation reports together:

```sh
export IFD_OUTPUT_ROOT=data/mac-session
```

```sh
npm run local-status
npm run ingest -- https://approved-site.example/
```

`local-status` prints business IDs, page slugs, embedding models, chunk counts and
latest approved question versions, using no keys or network. Ordinary `ingest`
uses fake embeddings for offline practice. Real ingestion uses the separately
authorized live runner below; the two vector spaces are never mixed.

## Free-only local live chat

By default, chat uses an empty fake answer script and refuses questions. Adding
keys alone does not enable real calls. For real-ingested businesses, Next.js reads
these settings from ignored `.env.local`:

```dotenv
LOCAL_CHAT_MODE=real
FREE_TIER_CONFIRMED=yes
LOCAL_CHAT_MAX_CALLS=60
```

Keep the isolated `GEMINI_EVAL_API_KEY` and `GROQ_EVAL_API_KEY` there too. Never use
the widget key. No Supabase account, database URL, production model keys, Docker
or paid subscription is needed for this local mode. `MODEL_MODE` belongs to the
older scaffold config; it does not control local chat.

Set `FREE_TIER_CONFIRMED=yes` only after checking that the Gemini project and Groq
account are Free with paid billing disabled. This is a manual account confirmation,
not an API-enforced billing guarantee. Model availability and free quota can change.
Current account settings take precedence over old successful runs.

The 60-call default (configurable from 1 to 300) counts embeddings, retries and
fallback attempts across all live chats in one server process. The first quota
response stops all subsequent live provider requests. There is no automatic paid
upgrade. Counters survive development reloads but reset on process restart; check
quota before restarting after a stop. They are not a distributed spending limit.
Fake-ingested businesses remain offline even when real chat is enabled.

Answers use Gemini; transient failures may use the configured Gemini fallback list
or the existing Groq answer fallback. All attempts share the cap. A model-family
fallback cannot judge itself in evaluations. Provider failures return a generic
503, rather than pretending a website lacks the answer. Chat questions/answers
are not saved by this app; providers receive live questions and retrieved text.

## Review and rerun a fixed question list

All commands below require the server to be stopped. Substitute the actual IDs and
versions printed by `local-status`; do not enter the angle brackets literally.

```sh
npm run questions -- <business-uuid> list
npm run questions -- <business-uuid> show <version>
npm run questions -- <business-uuid> edit <version> <question-uuid> data/replacement.json
npm run questions -- <business-uuid> approve <version>
```

A replacement contains `question`, `expectedBehavior` and `evidenceChunkIds`.
Edits save a new unapproved version; old versions remain. Unknown or foreign
references prevent approval. Approval records that an operator accepted a list
for a run, not answer quality. Automatic approval of generated questions does not
establish human review of each question. Website text and model replies are untrusted data.

For a free-only rerun after reviewing the saved list, on this Mac:

```sh
LIVE_OK=yes FREE_TIER_CONFIRMED=yes npm run live -- https://synqlogic.com/ --reuse-snapshot --question-version <approved-version> --max-calls 100
```

The frozen mode makes no crawl, ingestion-embedding or question-generation calls.
It requires an existing snapshot and approved list for that exact origin and
embedding model, and never approves a different list. Query embeddings, answers
and judging still consume free provider quota. The call cap includes retries.
A short, explicitly identified per-minute limit can be waited out (up to three
waits of at most 21 seconds); daily/unknown limits stop the run.

For initial real ingestion or an intentionally new question set:

```sh
LIVE_OK=yes FREE_TIER_CONFIRMED=yes npm run live -- https://approved-site.example/ --max-calls 120
```

This stops after generating questions for review. `--approve-generated` is an
explicit alternative for approving unflagged generated questions and immediately
evaluating them; do not use it for a frozen comparison. The CLI loads only eval
keys from `.env.local`; authorization and model overrides come from the process
environment. Overrides: `GEMINI_TEXT_MODEL`, `GEMINI_ANSWER_MODEL`,
`GEMINI_QUESTION_MODEL`, `GEMINI_TEXT_FALLBACK_MODELS` and `GROQ_MODEL`.

Reports stay in ignored `reports/private/` and `data/eval-reports/` and in the local
database. They are not encrypted or access-controlled by Git ignore rules.
Missing verdicts and execution errors never count as passes. An independent
judge also sees the source sections used to write each question, so missed
retrieval does not make a refusal correct.

## Offline checks and limitations

```sh
npm run typecheck
npm test
NEXT_TELEMETRY_DISABLED=1 npm run build
npm run calibration
```

With the server running separately, `npm run smoke` checks the home page, saved
business pages, 404 behavior and invalid chat input over HTTP. It makes no model
calls. The database packages remain external Node dependencies so their WASM and
pgvector files can load correctly at runtime. Webpack is used for local builds to
avoid the restored Turbopack build that stalled while reading OneDrive files.

Tests use fictional websites, scripted model replies and injected HTTP transports;
they make no live model or website requests. Fixed regression cases cover lists,
process steps, contact facts, policies, coverage, business types and six trap kinds.
Scripted success establishes plumbing and guards, not real model quality.
`IFD_OUTPUT_ROOT` sends test reports to a temporary directory.

The four synthetic calibration cases intentionally give the fake judge 3/4
agreement. That is not measured live-judge accuracy. Earlier manual reviews are
small, informal checks; a separately saved, hand-labelled live calibration set is
still needed for stronger judge evidence.

Crawler safeguards cover public-address validation, exact-origin scope,
robots.txt and page/size/time caps. These layers and the answer checks do not prove
resistance to every injection or every unsupported natural-language claim.
Real retrieval thresholds still need calibration.

Local chat limits are 10 requests per client and 60 per business per minute,
using an HttpOnly SameSite cookie and bounded memory. Clearing cookies bypasses
the client bucket; the business bucket remains. Pilot configuration requires
shared Postgres counters and a persistent global provider-call cap, and rejects
requests if shared storage fails. Browser identity is still cookie-based, so
pilot access also requires a private invitation. The real Supabase concurrency
probe, independent security review and accepted quality benchmarks remain gates.
PGlite tests do not establish real Postgres multi-connection concurrency behavior.

### Live run 2026-10-10 and answer rules v2

Historical context: the first salon run stopped at a free limit and refused every
question it reached. Rules v1 required excessive word overlap and copied lines.
Subsequent changes allowed cited rewording, hybrid retrieval, clearer refusal
reasons, exact citation IDs and numbered-list formatting. Dated run records above
supersede the old “no real-site evaluations” status. Historical decisions remain
in `docs/brief.md` and the AI OS project card.
