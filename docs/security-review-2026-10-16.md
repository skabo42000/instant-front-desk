# Windows pilot preparation review — October 16, 2026

Local prototype review by the delegated Codex engineer. This is not independent
release approval, deployment evidence, judge calibration or customer evidence.

## Host and sources

`git log -3 --oneline` confirms HEAD `984206e`. The initial `git status --short`
already contained substantial tracked modifications and untracked pilot/MCP
implementation files. Those existing changes were preserved, not attributed to
this review. Shared records were read only.

Sources: `docs/brief.md`, project `AGENTS.md`, `CLAUDE.md`, `README.md`,
`../ai-os/AGENTS.md`, `../ai-os/context/{goals,profile,agent-routing,claims}.md`,
`../ai-os/projects/instant-front-desk.md`,
`../ai-os/projects/plans/instant-front-desk-mcp.md`, and the shared `work` skill.
The supplied worker status replaced a global status scan.

`data/`, `.env.local` and `node_modules/` exist on Windows as OneDrive reparse
points. No credentials were displayed or manually inspected. The isolated-key
probe program loaded only eval key settings. Both saved AI-reviewed bundles and
matching query caches parsed successfully: 26 cases and 26 cached queries per
site. `npm run local-status` subsequently completed successfully: salon 58 chunks,
approved question version 1; Synq 93 chunks, approved version 2, both using
`gemini-embedding-001`. A third fake-ingested record has zero chunks and no
approved version. This establishes usable local data, not full OneDrive sync.
Node is v24.21.0; npm is 11.19.0.

## Findings

| Severity | Status | Finding and evidence |
| --- | --- | --- |
| Medium | Fixed in source; checks below | `ifd_stop_calls()` previously updated only an existing budget row. A stop before first reservation disappeared. Migration 008 inserts a stopped singleton if absent and preserves an existing budget on conflict. Regression checks stop-before-reserve, repeated stop, a new budget object, and public-role denial. |
| Medium | Fixed in source; checks below | Supabase RPC read the entire response before checking its size. It now counts streamed bytes, cancels above 2,000,000 bytes, and rejects oversized declared lengths. A synthetic endless chunked response verifies early cancellation. |
| Medium | Fixed in source; checks below | The fictional MCP runner used Unix negative-PID signals on Windows, leaving its timeout child alive and hanging cleanup. Windows now uses bounded `taskkill /PID /T /F`, a direct-child fallback and bounded close wait. Added a Windows descendant cleanup regression. No assistant/provider runner was invoked. |
| Medium | October 17 coordinator local direct-SQL proof: 5/5 pass | The lost-unsaved-stop failure now has a sticky local marker and shared-stop replay before reservations. Source: `data/local-postgres-proof-fix.json`; `acceptedAfterRecovery=false`, `sharedStopped=true`. See [dated follow-up](security-review-2026-10-17.md) for remaining host/storage/race limits. This is not hosted PostgREST or cross-host atomic quota proof; this worker did not rerun it. |
| Release gate | Open | Hosted Supabase/PostgREST concurrency, actual role grants/anonymous denial, hosted `ifd_stop_calls` empty 2xx/204 void-response check, independent release acceptance, accepted quality evidence and judge calibration remain unverified. Local direct-SQL evidence does not satisfy these gates. |

Read-only inspection also covered MCP schemas, adapter scope checks, streaming
response cap, redirect/timeout settings, loopback Host/token/origin checks,
pilot disablement, SQL parameterization, `src/proxy.ts`, invitation configuration,
chat body/output limits, business allowlists, shared reservations, and migrations
005–007. No additional concrete authorization bypass was found in this pass.
MCP loopback access still depends on the configured loopback network bind; a Host
header by itself is not peer-address authentication. Browser client identity is
cookie-based and intentionally backed by business/global limits and invitation.

## Blocked live stages

`Get-Command docker,psql,postgres,pg_ctl` found none. No matching Docker/Postgres
services or processes, standard Program Files installations, or TCP listener on
5432 were found. `wsl --list --quiet` reports WSL is not installed. No available
real multi-connection local Postgres was discovered; no software was installed.
Rate-limit and budget concurrency proof was therefore not run on that Windows
session. Superseding October 17 Mac coordinator evidence is recorded above:
two connections, 24 requests with three accepts and zero errors, cross-connection
stop, saved-stop recovery and unsaved-stop replay all passed; cleanup passed.
See [operator reset procedure](pilot.md#deliberate-budget-reset-operator-only).

Executed one tiny Gemini generation attempt with the isolated eval key via:

```powershell
$env:LIVE_OK='yes'; $env:FREE_TIER_CONFIRMED='yes'
node scripts/probe-eval-quota.cjs data/security-review-2026-10-16/quota-probe.json
```

The transport failed before any HTTP status was available. The report records
`transport-unavailable`, one attempted request, `recovered:false`. Groq was not
attempted after that failure. No retries, fallback, main Gemini key, or further
model requests were used. Provider quota is **unknown**, not proven exhausted or
recovered. Synq/salon judge-v2 reruns were not started. The diagnostic probe is not
an account billing check; existing confirmed free-only authorization was used.

`git add -- db/008_budget_stop.sql tests/unit/security-review.test.ts scripts/probe-eval-quota.cjs`
failed: `.git/index.lock: Permission denied`. This sandbox exposes `.git` as
read only, so the requested local commit could not be created. No push or deploy.

## Checks

The first plain `npm test`
failed before collecting tests: 27 failed files, no tests, because Vite could not
create its cache under the sandbox's read-only system Temp. Tests were rerun with
`TEMP` and `TMP` pointing to the project's ignored review temp folder. The first
such run exposed the Windows cleanup failure and was interrupted; it is not a
passing run. A subsequent run hit the default five-second live-fixture timeout
while the build was running and was interrupted. No assertion was removed.

Final executed checks:

| Command | Actual result |
| --- | --- |
| `npx tsc --noEmit` | Exit 0, no diagnostics, rerun after code/test edits. |
| `$env:TEMP=(Resolve-Path data/security-review-2026-10-16/tmp).Path; $env:TMP=$env:TEMP; npm test -- --testTimeout=30000` | Exit 0; **330 tests passed across 27 files**, 133.42s. All files included; longer test deadline accommodates this Windows host. |
| `$env:NEXT_TELEMETRY_DISABLED='1'; npm run build` | Exit 0; Next.js 16.4.0 webpack build, type checks, 4/4 static pages, all six route entries and proxy emitted. |
| `npx vitest run tests/unit/security-review.test.ts --reporter=verbose --testTimeout=30000` with the same workspace Temp | Exit 0; **3/3 regression tests**, one file. |
| `npx vitest run tests/unit/mcp-fictional.test.ts --reporter=verbose --testTimeout=30000` with the same workspace Temp | Exit 0; **8/8 tests**, including timeout and Windows descendant cleanup, 15.01s. |
| `node --check scripts/probe-eval-quota.cjs` and `node --check scripts/demo-mcp-fictional.mjs` | Both passed. |
| `git diff --check` | Exit 0; line-ending warnings only. |
| `npm run local-status` | Exit 0; owned-site data and approved versions reported above. Earlier slow attempt was interrupted; successful retry establishes the reported state. |

No public server, push, deployment, account creation, billing change, paid
service, business contact or main Gemini key use. No new answer-quality scores
were produced. The passing offline suite verifies scripted behavior, not real
multi-connection Postgres serialization or provider quota recovery.

## Beginner explanation and optional exercise

The shared stop must survive even when no requests have happened yet. The RPC
size limit must stop reading a large reply, not merely reject it after loading it.
Windows also needs a different way to stop child processes than Unix.

Optional exercise: explain why a database row created with `stopped=true` must
still reject `reserve(60)` after constructing a new budget object. This suggested
exercise is not evidence of demonstrated learning.
