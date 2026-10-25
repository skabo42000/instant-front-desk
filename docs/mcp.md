# Local MCP prototype

Updated October 24, 2026. Built with AI coding agents; no customer use or deployment
claim. Node 22+; official MCP TypeScript SDK client/server 2.3.1 and Zod 4.6.7.

## Two-minute fictional demo

After cloning and installing locked dependencies with `npm ci`, run:

```sh
npm run mcp:demo
```

This single command starts a real stdio child process, discovers four tools with
the official SDK client, calls each, checks a cited answer, an unsupported-price
refusal and rejected empty input, then closes the child and discards its fixture.
It prints the captured results and generates [mcp-demo-transcript.md](mcp-demo-transcript.md).
`npm run mcp:smoke` runs the same session without rewriting the transcript.

Maple Street Dental is invented. Its `.test` URL is a citation label, never fetched.
The three-question saved evaluation is invented too: 1 pass, 2 failures, including
1 judge execution error. `FakeEmbeddings` performs token hashing; `FakeModel`
supplies a fixed Saturday-hours response. Unsupported prices and question
injections use the real answer engine's refusals. This proves protocol plumbing
and checks, not semantic retrieval quality, live model accuracy or production use.

No keys, `.env.local`, saved business records or database service are needed.
The fixture uses disposable in-memory PGlite with project migrations. The stdio
adapter uses the same HMAC API handler through an injected in-process HTTP
transport, so this path opens **no network listener** and makes no network calls.
The real-app path below uses TCP loopback HTTP. Optional
`node --conditions=react-server scripts/run-mcp-fictional.cjs --loopback` starts
the fictional API on a temporary numeric loopback port instead; it needs a host
that permits local listeners. TCP listener startup was blocked by sandbox `EPERM`
in this implementation session and is not verified here.

## Connect Claude Desktop or Claude Code

Generate a ready-to-paste **Claude Desktop** JSON configuration with this command
from the clone. It prints your absolute Node/script paths and contains no secret:

```sh
node scripts/run-mcp-fictional.cjs --print-config
```

Paste the printed `mcpServers` entry into Claude Desktop's developer MCP
configuration, preserving any other servers, then restart Claude Desktop.
The entry has this shape (the generator fills in both absolute paths):

```json
{
  "mcpServers": {
    "ifd-fictional": {
      "command": "/absolute/path/to/node",
      "args": ["--conditions=react-server", "/absolute/path/to/instant-front-desk/scripts/run-mcp-fictional.cjs"]
    }
  }
}
```

For **Claude Code**, paste this command from the clone:

```sh
claude mcp add --transport stdio ifd-fictional -- node --conditions=react-server "$PWD/scripts/run-mcp-fictional.cjs"
```

The launcher selects the project working directory itself, ignores inherited app
settings and generates a random authentication secret only in memory. Each MCP
host gets its own disposable fixture. Stdout contains protocol messages only.
Closing the host input or sending SIGINT/SIGTERM closes the API and database.

Try: “Use ifd-fictional to find Maple Street Dental. Ask its Saturday hours and
cite the source. Then ask its exact checkup price. Explain the refusal and the
limits of this fictional evidence.” Tool selection by Claude, actual Desktop GUI
setup and Claude Code configuration are **not verified in this session**. The
offline demo uses a scripted SDK client, not subscription inference.

## Tools and architecture

Real app: MCP client → stdio adapter → HMAC-authenticated numeric loopback HTTP →
Next route → app-owned database. The adapter never opens a database or invokes a
provider directly. Exactly four tools are advertised:

| Tool | Input | Output |
| --- | --- | --- |
| `list_businesses` | Optional limit/cursor | Allowlisted UUIDs, names, slugs and source URLs |
| `get_business` | Business UUID | Public metadata, page/chunk counts and latest successful crawl date |
| `get_evaluation_report` | Business UUID, optional limit/cursor/reportId | Latest legacy report, versions, error-inclusive counts and failures |
| `ask_business` | Allowlisted business UUID, nonblank question up to 2,000 characters | Business UUID, `kind` (`answer` or `refusal`), text and citations (`id`, `pageUrl`, `heading`) |

`ask_business` resolves the scoped business then calls the **same chat handler**
used by `/api/chat`: business-scoped retrieval, source-instruction filtering,
grounded answer checks, cited source URLs, contact fallbacks and output limits.
No raw chunks, provider logs or settings leave this path. A refusal is a successful
tool result with `kind: refusal`; infrastructure/auth/rate/budget failures are
`isError: true` with a fixed label, never fabricated site answers.

Browser and MCP calls share the existing singleton chat runtime, business rate
bucket and provider reservations. Each MCP handler also has one stable client
bucket. Limits remain 10 requests per client and 60 per business per minute;
local counters reset on process restart. Real-mode embeddings, retries and
fallbacks consume the same `LOCAL_CHAT_MAX_CALLS` budget as browser chat (default
60 per process; configured range 1–300). Shared provider reservations apply when
the existing runtime is configured for them; MCP remains disabled in pilot mode.
The fictional path consumes rate limits but has no paid/live provider budget to
charge. Offline tests separately exercise reservation/cap wiring with injected
HTTP and a FakeModel reply; no provider is contacted.

Tools cannot ingest or edit business/evaluation data. `ask_business` consumes
existing accounting limits and can produce varying answers; its MCP annotation
therefore has `idempotentHint: false`. All tools have `readOnlyHint: true` and
`destructiveHint: false`. No web-chat policy, pilot gate or database migration changed.

Reports remain **legacy single-verdict database reports**. File-only
three-dimension benchmark diagnostics are not substituted. Missing reports are
`null`, never zero. Saved scores do not establish current health, calibrated
accuracy or comparability across question sets.

## Real-app setup (separate from the offline demo)

1. With the app stopped, `npm run local-status` lists records so the owner can
   explicitly choose business UUIDs. Do not run a database CLI alongside the app.
2. Configure ignored `.env.local` privately: `IFD_MCP_ENABLED=yes`,
   `IFD_MCP_ORIGIN=http://127.0.0.1:3000`, `IFD_MCP_BUSINESS_IDS` (comma-separated
   UUIDs) and `IFD_MCP_TOKEN` (new random 32-byte secret, preferably 64 hex characters).
   Never put the secret in chat, a tracked file or an example. Set
   `LOCAL_CHAT_MODE=fake` for provider-free work; live chat needs separate authority.
3. Start the app with `npm run dev`, or the existing build/start commands. Bind
   `127.0.0.1`; the API cannot make a remotely bound app safe.
4. Configure the host to execute your absolute Node path with the absolute
   `scripts/run-mcp.cjs` path and this project as working directory. Pass only
   `IFD_MCP_ORIGIN`, `IFD_MCP_BUSINESS_IDS`, `IFD_MCP_TOKEN` through the host's
   private environment. The adapter does not load `.env.local` or need provider keys.
5. `npm run mcp:smoke:local` checks discovery, saved-data reads and an injection
   refusal against the running app using those environment variables. On a real
   embedding space, retrieval may consume a query-embedding call even for a
   question the answerer refuses. Its JSON reports `modelCalls: "unmeasured"`:
   the client cannot observe the app process's embedding or answer attempts.
   This is not the no-provider fictional check.

Real-ingested businesses require the existing authorized chat runtime; fake
businesses stay fake. Merely setting keys does not enable real calls. No live
provider calls or app-owned saved database were used for this change.

## Authentication and bounds

The API is disabled by default and unavailable in pilot mode. Both sides enforce
business UUID allowlists and strict input/output schemas. The API checks actual
Host against the configured numeric loopback origin and rejects Origin headers
and cross-site browser contexts. Request bodies are capped at 4 KiB, including
UTF-8 encoding/JSON overhead; this can reject a multibyte question below 2,000
characters. Responses are no-store and capped at 128 KiB. Redirects are rejected.

The October 24 HMAC challenge-response design remains on **all four tools**:

1. Adapter sends public input plus a fresh random 32-byte client nonce.
2. API returns a fresh server nonce and HMAC-SHA256 server proof. The adapter
   verifies it before sending a client proof; the reusable secret never travels.
3. Proofs bind protocol version, role, origin, tool, exact JSON body and both
   nonces. Constant-time comparison and distinct server/client/result roles
   reject impostors and changed requests. Challenges expire after five seconds,
   with at most 256 pending per handler, and are consumed before data/model work.
4. API signs the exact result body too; adapter verifies it before parsing or
   returning data. A captured client proof is single-use.

The three saved-data tools retain a five-second adapter deadline. `ask_business`
has 60 seconds for retrieval plus the existing gateway's bounded retries/fallbacks;
challenge expiry remains five seconds. A client timeout does not roll back
already reserved calls and can leave authorized bounded work finishing server-side.
Answer text is capped at 4,000 characters with at most eight citations. Saved
report pages have at most 10 entries, 2,000-character text fields and 200-character
labels; `truncated` and `nextCursor` disclose limits. Failure pagination pins the
report ID to avoid mixing runs.

This design does not encrypt local inputs/results, prevent denial of service,
or protect a secret readable by another local process. It requires a strong
random secret. Challenge state is process-local and unsuitable for load balancing.
Website text and tool output remain untrusted data, never assistant instructions.

## Verification and remaining limits

`npm test` includes the real child-process stdio integration test. CI installs
the locked dependencies and runs typecheck and the full offline suite on Node 22
without secrets or external services. Installing dependencies in a fresh clone
needs a package registry or local cache; the checks/demo themselves use no network.

Unit tests cover answer/refusal parity, missing/unknown citations, unsupported
numbers, shared rate limits, fail-closed stores, embedding/answer budget accounting,
auth rejection, input tampering/replay, allowlists, strict schemas and output
limits. Existing auth regressions cover impostor proofs/results, roles, expiry,
capacity and disabled/pilot modes. The new stdio test discovers all four tools,
calls each, and verifies a cited answer, refusal and rejected input through the
fictional HMAC handler. Its API transport is in-process; it does not verify TCP,
Next HTTP routing, cross-user port ownership or OS listener security.

Not verified here: GitHub-hosted CI execution, clean-clone installation over a
network, Claude GUI/tool selection, live providers, real-site answer quality or
deployment readiness. Historical assistant-mode evidence remains separate in
[mcp-case-study.md](mcp-case-study.md); the legacy `--assistant` path uses a remote
subscription service and is outside this offline demo. Existing pilot gates remain.

Repository privacy limit: earlier tracked `benchmarks/owned-sites/` snapshots
contain the owner's real public website text and embeddings (see
[benchmark provenance](../benchmarks/README.md)). This change adds only fictional
demo data and does not remove those existing evaluation artifacts. The portfolio
brief's stricter “no real business pages tracked” check therefore remains unmet;
publishing this repository requires a separate decision on those fixtures.

Exercise: predict whether the exact-price question will return `isError: true`
or `kind: refusal`, run the demo, and explain the difference from its rejected
empty question. A generated solution does not prove learning.
