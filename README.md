# Instant Front Desk (working name)

Local prototype, 2026-10-10. Includes bounded website collection, local Postgres
(PGlite) storage, fake embeddings, retrieval, a guarded answer engine and a minimal
chat UI, offline evaluation runner, score cards and injectable Gemini/Groq adapters.
No real-site evaluations,
customer results or deployment evidence. See `docs/brief.md` for scope and decisions.

## Local evaluation question review

Milestone 8 adds stored question lists and a local CLI, dated 2026-10-10. Stop the
web server before using this CLI (the same single-process PGlite restriction applies).
No network or model credentials are used. With an already ingested business UUID:

```powershell
npm run questions -- <business-uuid> generate
npm run questions -- <business-uuid> list
npm run questions -- <business-uuid> show 1
npm run questions -- <business-uuid> edit 1 <question-uuid> data/replacement.json
npm run questions -- <business-uuid> approve 2
```

Replace the angle-bracket values with actual IDs from ingestion/list output. The
replacement file is a JSON object with `question`, `expectedBehavior`, and
`evidenceChunkIds` (an array of that business's stored chunk UUIDs). Traps may use
an empty evidence array. Keep private review files under ignored `data/`.

The fake generator creates 20 section-based questions plus six fixed traps. These
are repetitive review scaffolding, not measured model-generated question quality.
Malformed replies or unknown/foreign references remain visible as validation flags
and prevent approval. Editing copies the whole list into a new unapproved version;
the previous version remains available. Approval means a human reviewed that
version, not that any answers passed. The database rejects new eval runs using
unapproved lists and results referencing another question version. The eval runner
and completed score cards now use that approval gate. Historical chunk evidence
is protected by foreign keys: later ingestion that removes referenced chunks can
fail rather than silently destroy review history.

Offline question tests use two fictional businesses in PGlite, including shared
local chunk IDs, malformed fake replies, all six trap kinds, version edits, approval
gates and direct SQL checks. No real-site question quality or multi-connection
concurrency is established. Beginner explanation: each edit saves a fresh copy,
so a later evaluation can identify exactly which reviewed questions it used.
Exercise: edit one question, predict which version remains approved, then inspect
both versions with `show`. This is practice, not proof of mastery.

## Local use

Use Node.js 22 LTS or newer. After dependencies are installed:

```powershell
npm run dev
```

Open http://localhost:3000. The setup page lists businesses in
`data/instant-front-desk` (ignored by Git). To add an approved website, stop the
server first, run the following command, then restart the server and refresh:

```powershell
npm run ingest -- https://approved-site.example/
npm run dev
```

The CLI and web server use the same local database folder. Do not run them together:
PGlite is intended here for one process and one connection. The setup page explains
these steps; it does not start website collection. `/b/<slug>` has only chat and an
answer-check area showing the latest saved run (or an empty state). There are no website collection or evaluation endpoints.
Unknown businesses return 404.

The chat uses the existing fake gateway by default, with no credentials or network
model calls. Its default script has no replies, so it refuses questions; this is
not evidence of live answer quality. Offline tests inject scripted replies to
exercise supported answers and citations. Fake embeddings measure word overlap,
not meaning. Questions and answers are not persisted; the UI holds only its latest
answer in memory. Do not add credentials to website text or browser code.

## Chat limits and deployment limitations

`POST /api/chat` accepts a business slug and a question. Questions are limited to
2,000 characters, streamed request bodies to 12,000 bytes, and answer text to 4,000
characters. At most five citations are returned, with bounded headings and URLs.
Oversized or malformed input returns 400. Unsupported/oversized answers produce
refusals; internal failures return a generic 503 without internal error text.
Only answer text, kind and citations are returned, never gateway logs or settings.

In-memory limits allow 10 requests per client and 60 per business per minute;
429 responses include Retry-After. The limiter is shared across routes/reloads in
one server process, with expired entries removed and a bounded map. A client is
identified by an HttpOnly, SameSite cookie, not untrusted forwarded IP headers.
Clearing/changing cookies bypasses the client bucket; the business bucket remains.
These are local prototype limits: **before deployment**, use a shared limiter across
processes and a trusted client identity at the hosting boundary. Process restarts
reset limits. No deployment is authorized by this milestone.

## Settings and offline checks

`.env.example` lists optional settings; local credentials belong only in ignored
`.env.local`. No credentials are required by this UI. Server configuration, database,
retrieval and gateway modules are marked `server-only`. Injectable real adapters
are implemented; setting MODEL_MODE=real does not enable real calls in this UI.
The brief selects Gemini for answers/embeddings and Groq (openai-oss family) for an
independent judge and fallback. Provider limits remain unverified.

```powershell
npm run typecheck
npm run test
$env:NEXT_TELEMETRY_DISABLED = '1'
npm run build
```

The fixtures are fictional `bright-salon` and `maple-repair` websites. Tests run
without network access or paid resources. The UI tests render the actual pages
against two seeded in-memory databases, check separation and the unknown-business
boundary, and use synthetic credential markers to check rendered output. Route
tests exercise citations, refusals, both rate buckets, invalid/oversized input,
output caps and generic errors. They do not simulate browser interaction or prove
that arbitrary sensitive website content is safe. PGlite does not establish
multi-connection concurrency safety. Live model availability was checked by the coordinator on 2026-10-10 (details
below); this does not establish service readiness or real-site answer quality.

Beginner explanation: the page sends one question and a business name to the server.
The server looks only in that business's saved pages, then returns an answer or a
refusal. An empty score means checks have not run, not that answers passed.
Exercise: change the rate limit in a local test from one to two, predict which
request receives 429, and run `npm run test -- tests/unit/chat-route.test.ts`.
This is practice, not evidence of mastery.

## Offline evaluation and provider setup (2026-10-10)

Stop the web server first, approve a reviewed question version, then use the local CLI:

```powershell
npm run eval -- <business-uuid> <approved-version> <crawl-run-uuid>
npm run calibration
```

The eval CLI uses empty fake answer/judge scripts by default, so it records execution
errors; it does not manufacture a passing quality score. Tests inject fixed scripts.
`src/lib/eval/runner.ts` accepts a gateway, embeddings and an independent judge for
an authorized harness. Reports are stored in the business-scoped database and in
ignored `data/eval-reports/<run-uuid>.json`. They contain the exact reviewed questions,
answers, citations, model/family logs, verdicts and answer/judge prompt versions.
The share page displays the latest score and every failure/error. Reports contain
private website data: keep them local. The ignored folder is not an access-control
boundary or encryption; Windows file permissions are inherited from the workspace.
A score measures only the reviewed sample. Execution failures and missing verdicts
never count as passes. A Groq openai-oss fallback answer cannot be judged by the Groq openai-oss judge;
it becomes an execution error until a separately approved independent judge exists.

The four engineer hand-labelled synthetic calibration cases live in
`tests/fixtures/judge-calibration.json`. The scripted fake judge agrees on 3/4 and
disagrees on the unsupported competitor comparison (1 disagreement). Running
`npm run calibration` writes the complete labelled report to
`data/eval-reports/calibration-fixture.json`. This deliberately includes a disagreement
to check reporting. It is fixture-only evidence of plumbing, not measured Groq judge
accuracy or business quality. Labels have not been reviewed by Bosko. Calibration
judge errors count as disagreements. PGlite checks do not establish real Postgres
multi-connection behavior, and no two-site validation or provider quota check ran.

Real adapters in `src/lib/models/providers.ts` have no default network transport;
call `evaluationProviders(env, transport)` with a fake transport for offline work.
They use Gemini for answers, questions and 768-dimensional embeddings, and Groq
openai/gpt-oss-120b (openai-oss family) for fallback/judging. Responses with the wrong embedding length fail loudly;
the existing business/chunk metadata stores model and dimension and rejects mixed
spaces. Defaults are verified live 2026-10-10, may change, per the coordinator
check recorded in `../ai-os/projects/instant-front-desk.md`: Gemini answers/questions
use gemini-3.5-flash-lite; gemini-2.5-flash-lite is closed to new users. Groq no
longer lists a Llama chat model on the checked key; llama-3.3-70b-versatile failed.
Embeddings stay gemini-embedding-001: every call explicitly requests
outputDimensionality 768 (verified live); its provider default is 3072.
`evaluationProviders` accepts GEMINI_ANSWER_MODEL, GEMINI_QUESTION_MODEL (defaults
to the answer model), and GROQ_MODEL from the supplied env object. Constructor
overrides also work; validation keeps models within their declared family.
This update was tested offline; no new live check was performed. Real retrieval thresholds still need calibration.
Malformed replies, non-2xx responses and deadlines return safe errors. A 429 latches
that adapter off, stops gateway retries/fallback and stops remaining eval work;
it never enables billing. A later run/session also requires an explicit quota check.
HTTP tests use synthetic keys and fake responses, including echoed key rejection.
They do not establish real provider behavior or arbitrary sensitive-content safety.

Before a separately authorized live session, Bosko's personal setup steps are:

1. In Google AI Studio, create an isolated evaluation key with eligible free quota;
   keep billing disabled and keep the existing widget key untouched. Enter it locally
   as `GEMINI_EVAL_API_KEY` in ignored `.env.local`, never in chat.
2. In Groq Console, confirm free quota and billing disabled; create an evaluation key
   and enter it locally as `GROQ_EVAL_API_KEY`. Current limits remain unverified.
3. Review the approved site URLs and question versions with the coordinator before
   any live ingest/eval. No account, network call, paid service or deployment is
   authorized by these setup notes. CLI adapters do not automatically load env files.

Beginner explanation: an approved list is a saved exam. Each answer gets a verdict,
and crashes remain visible instead of raising the score. Exercise: change one fake
verdict in `tests/unit/eval.test.ts`, predict the new numerator while the denominator
stays seven, then run that test. This is practice, not evidence of mastery.
