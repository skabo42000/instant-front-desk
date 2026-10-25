# Local read-only MCP extension

Implemented October 15, 2026, with AI coding agents. Local prototype; no public
hosting, customer use, or personal hand-coding claim. The official TypeScript
SDK v2 is pinned to `@modelcontextprotocol/server` and `client` 2.3.1; Zod 4.6.7
validates both sides. Node 22+ is the existing app requirement.

## Architecture and tools

MCP client → stdio adapter → authenticated loopback HTTP → the running Next app's
shared PGlite connection. The adapter never opens the database or invokes models.
Do not run a database CLI alongside the app. The local HTTP API is disabled by
default and always disabled in public pilot mode.

Exactly three tools are advertised:

| Tool | Input | Saved output |
| --- | --- | --- |
| `list_businesses` | optional limit/cursor | Only allowlisted business UUIDs, names, slugs and source URLs |
| `get_business` | business UUID | Public metadata, page/chunk counts and latest successful crawl date |
| `get_evaluation_report` | business UUID; optional limit/cursor/reportId | Latest database report, version/snapshot/model/prompt metadata, error-inclusive counts, failure details |

These reports are the **legacy single-verdict database reports**. File-only
three-dimension benchmark diagnostics are not imported or silently substituted.
A missing report is `null`, never zero. Latest saved evidence does not establish
current health, human-calibrated accuracy or comparability across question sets.
Example questions for a connected assistant: “Which approved businesses are saved?”
and “What failed in the salon's latest saved evaluation?”

## Setup

1. With the app stopped, run `npm run local-status` to choose approved owned-site UUIDs.
2. In ignored `.env.local`, set `IFD_MCP_ENABLED=yes`, `IFD_MCP_ORIGIN=http://127.0.0.1:3000`,
   `IFD_MCP_BUSINESS_IDS` to the comma-separated UUIDs, and `IFD_MCP_TOKEN` to a newly
   generated random 32-byte secret (64 hex characters). Never paste the secret in
   chat, commit it, or place it in an example configuration.
3. Start the app locally with `npm start` after `npm run build`, or `npm run dev`.
   Both default to binding `127.0.0.1`. Keep this binding; the API does not make a
   remotely bound app safe. Set `LOCAL_CHAT_MODE=fake` for provider-free checks.
4. Configure a local MCP client's stdio server to execute the **absolute Node path**
   with `scripts/run-mcp.cjs`, with its working directory set to this project.
   Supply `IFD_MCP_ORIGIN`, `IFD_MCP_TOKEN`, and `IFD_MCP_BUSINESS_IDS` through the
   client's private environment configuration. The adapter does not read `.env.local`.
   Do not supply model-provider keys to it. No client configuration was changed here.
5. With those same three variables in the terminal environment, `npm run mcp:smoke`
   runs SDK discovery and calls all tools. `npm run mcp` starts the stdio server.
   Its stdout is reserved for protocol messages, so do not wrap it in a command
   that prints banners. Stop the app after testing if no local server is wanted.

## Bounds and isolation

Inputs and outputs reject unexpected properties. Business UUID allowlists are
independently enforced in both processes, including returned business IDs.
The API checks the actual HTTP Host against the fixed loopback origin; Next may
internally reconstruct `Request.url` with localhost, which is not used as an
external destination. Requests with an Origin header, cross-site browser context,
missing/wrong credentials, invalid IDs or bodies over 4 KiB are rejected. Responses
are no-store. Authentication was updated October 24, 2026 to address local-server
impersonation (F1). Restart both app and adapter together; old token-header clients
are rejected. The private `IFD_MCP_TOKEN` setting stays the same, but its value is
never transmitted.

Each call starts with a fresh random 32-byte client nonce and the tool input,
without a credential. The app returns a fresh server nonce and an HMAC-SHA256
server proof. The adapter verifies this proof before sending its client proof.
Proofs use distinct server/client/result labels and bind the protocol version,
configured origin, tool, exact JSON body and both nonces. Comparisons are constant
time. A client proof authorizes only that request; the app consumes its challenge
before database access, so a captured proof cannot be replayed. Challenges expire
after five seconds and storage is capped at 256 pending entries per handler.
The Next route retains one handler across requests. Restarting it invalidates all
pending challenges. This local process design is unsuitable for load balancing.

The response carries a separate HMAC over that same context and the exact result
body. The adapter verifies it before parsing or trusting tool results. An impostor
at the configured port receives only public inputs and a fresh nonce; fabricated
challenges/results and stale proofs fail closed. Even a relay of a genuine
challenge cannot change the request or fabricate an accepted result. This does
not encrypt inputs/results, prevent local denial of service, or protect against
a process that can read the private configuration. Use a random secret as above;
weak passwords permit offline guessing from observed proofs.

The adapter uses a fixed numeric loopback origin, rejects redirects, has a five-second
whole-operation deadline, and caps streamed responses at 128 KiB. Pages contain at
most 10 entries; report text is limited to 2,000 characters and model labels to
200. `truncated` discloses clipped fields; `nextCursor` discloses another page.
Subsequent failure pages require the saved `reportId`; a changed latest report
rejects the page instead of mixing runs. Website text remains untrusted data.
No arbitrary URL, SQL, file path, write operation, gateway log or embedding is
accepted or exposed. Errors contain fixed labels, not raw exceptions or secrets.

## Verification and limits

`npm test` includes SDK client/server tests through linked transports and the HTTP
handler with fictional fixtures. They cover scope, credentials, Host/Origin,
strict schemas, pagination, null reports, execution errors, text/response limits,
unavailable/malformed API replies, timeouts and redirects. Read tools preserve
the stored evaluation rows in the fixture.

`tests/unit/mcp-auth.test.ts` reproduces impostor services using injected HTTP
and linked SDK transports: no sockets, credentials or saved database are needed.
It checks absence of reusable credentials, rejected forged results, fresh nonces,
relayed/tampered and replayed replies, one-use request proofs, role/request binding,
challenge expiry/capacity, and unchanged disabled/pilot behavior. These simulations
do not establish OS-level listener ownership or actual cross-user port takeover.

`npm run mcp:smoke` uses a **real stdio child process** against the running app and
saved owned-site records. This is scripted protocol evidence, not an assistant
choosing tools. A connected-assistant demonstration remains unavailable in this
session; no MCP host was reconfigured. It is not claimed as completed.

The extension does not resolve pending live answer/judge tests, actual Supabase
concurrency/permissions, independent security review, or deployment approval.
The project's conservative pilot gates remain in force.

SDK references: https://github.com/modelcontextprotocol/typescript-sdk and
https://modelcontextprotocol.io/docs/develop/build-server (checked October 15).

## Fictional-only walkthrough (October 16, 2026)

This separate learning demo uses **Maple Street Dental, an invented business**.
Its `.test` website is only a label and is never fetched. Dates, saved answers,
model labels and verdicts are invented examples. Nothing here measures a real
business, model quality, current health or production readiness.

1. MCP (Model Context Protocol) lets an assistant discover tools and request
   information. `list_businesses` supplies the business identifier (its unique
   label); `get_business` supplies saved page/chunk counts; and
   `get_evaluation_report` supplies saved totals and failure reasons.
2. From this project's terminal, run `npm run typecheck`, then
   `npm test -- tests/unit/mcp.test.ts tests/unit/mcp-fictional.test.ts`.
   Expect a successful type check and passing tests. They check fictional scope,
   unchanged records after reads, blocked database settings and process cleanup.
3. Run `node scripts/demo-mcp-fictional.mjs --smoke`. No setup or `.env.local`
   is needed. The runner starts an empty database in memory, seeds only the fixture,
   and connects the existing tools through stdio (process input/output pipes) and
   loopback HTTP (an API listening only on this computer at a temporary
   `127.0.0.1` port). It generates a secret password privately in memory; it is
   never printed, saved or put in command arguments. Expect all three tool names,
   3 total / 1 passed / 2 failed, including 1 execution error, `modelCalls: 0`,
   `agentDemonstration: false` and `processesStopped: true`.
4. The coordinator can run `node scripts/demo-mcp-fictional.mjs --assistant`.
   This starts one temporary Codex client using existing ChatGPT subscription
   authentication and a required ChatGPT login, with no API-key environment or
   provider fallback. It sends only the fictional goal and tool results to that
   service. The assistant chooses tools itself. Expect an explanation of the
   omitted Saturday hours and the invented judge execution error. This mode
   uses subscription inference and is not offline; no Gemini/Groq calls occur.
   Missing authentication, allowance or incompatible client options fail the run.
5. After that successful assistant run, run
   `node scripts/demo-mcp-fictional.mjs --verify`. Expect `verified: true` only
   when saved tool events show all three successful tools, the fictional IDs,
   correct totals and an answer stating the evidence limits. Missing events,
   unrelated actions or unexpected records fail verification. A smoke result
   cannot substitute for an assistant result. Evidence is saved privately under
   `data/mcp-fictional-demo/`; starting another run replaces that evidence.
6. The runner stops its child process groups on success, failure, interruption
   or the three-minute deadline; the database is discarded. It does not start
   Next, use saved business data, load `.env.local` or change client settings.
   The smoke run proves the scripted connection; assistant selection remains
   unverified until `--assistant` and `--verify` actually succeed.

What each file teaches:

| File | What it does and why |
| --- | --- |
| `tests/fixtures/mcp-maple-street-dental.json` | Holds invented records so the demo needs no real business data. |
| `scripts/mcp-fictional-api.ts` | Seeds an in-memory database and bridges local HTTP requests to the existing read handler, keeping the real database separate. |
| `scripts/run-mcp-fictional-api.cjs` | Loads that TypeScript service in Node without starting the web app. |
| `scripts/demo-mcp-fictional.mjs` | Runs the smoke or assistant connection, checks evidence and stops temporary processes. |
| `tests/unit/mcp-fictional.test.ts` | Checks isolation, counts, read preservation, cleanup and evidence rejection offline. |
| `docs/mcp.md` | Explains the commands and their limits so a successful connection is not mistaken for model accuracy. |

Optional exercise: predict which tool supplies the failure reasons, then compare
your prediction with the recorded call. Receiving this example does not establish
that you have learned to implement MCP yourself.
