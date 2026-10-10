# Instant Front Desk (working name)

Local prototype, 2026-10-10. Includes bounded website collection, local Postgres
(PGlite) storage, fake embeddings, retrieval, a guarded answer engine and a minimal
chat UI. No real model adapters, completed score cards, real-site evaluations,
customer results or deployment evidence. See `docs/brief.md` for scope and decisions.

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
empty answer-check area. There are no website collection or evaluation endpoints.
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
retrieval and gateway modules are marked `server-only`. Real provider support is
still pending; setting MODEL_MODE=real does not enable real calls in this UI.
The brief selects Gemini for answers/embeddings and Groq (Llama family) for an
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
multi-connection concurrency safety. No live service readiness has been checked.

Beginner explanation: the page sends one question and a business name to the server.
The server looks only in that business's saved pages, then returns an answer or a
refusal. An empty score means checks have not run, not that answers passed.
Exercise: change the rate limit in a local test from one to two, predict which
request receives 429, and run `npm run test -- tests/unit/chat-route.test.ts`.
This is practice, not evidence of mastery.
