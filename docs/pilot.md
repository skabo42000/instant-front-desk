# Controlled browser pilot — Mac implementation prepared

Bosko authorized a Mac-hosted, invitation-only pilot on October 18, 2026.
The coordinator owns the live steps and tunnel; this worker has verified no live
launch or public URL. The earlier hosted proposal below is retained as reference.
Bosko delegated the 52-case source review to AI instead of doing it manually. That work
is complete and explicitly labeled AI; it does not supply human calibration or
release sign-off. Readiness currently fails by design; no release gate was forged.

## Run from this Mac

Prepared October 18, 2026 for Bosko's confirmed **Mac-hosted, invitation-only**
choice. That newer choice supersedes the hosted Render/Supabase proposal below
for this pilot. This section describes commands for the coordinator; this worker
has not started a live database, imported the owned data, launched the pilot or
created a tunnel. No live result is claimed. Source review remains AI review;
importing the corpus does not approve benchmark results or human calibration.

The production server binds to **127.0.0.1:3000**; Postgres binds to
**127.0.0.1:55432**. Cloudflare tunnel setup is a separate coordinator task.
Point it only at `http://127.0.0.1:3000`. A link alone does not authenticate:
invited testers also need username `pilot` and the private invitation password.
Never put that password into a link. The exact HTTPS tunnel origin must match
`PILOT_PUBLIC_ORIGIN`; a changed tunnel hostname requires a restart with the new
origin. Leave MCP disabled.

### Coordinator setup and start

Run these commands from the Instant Front Desk project directory, using the
installed locked dependencies (Node 22+). Stop existing local development or
benchmark processes first. No provider calls occur during init, import, proof
or build. Do not use the old `npm run live -- https://...` evaluation command:
that separate command intentionally invokes models.

1. Restore native pgvector if a fresh `npm ci` removed it. For this x64 Mac,
   the existing local build supplies these files; no download or rebuild is
   required. `live-db` refuses to start if the extension files are missing:

   ```sh
   cp "$HOME/ifd-pgbuild/src/pgvector/vector.dylib" node_modules/@embedded-postgres/darwin-x64/native/lib/postgresql/vector.dylib
   cp "$HOME/ifd-pgbuild/src/pgvector/vector.control" node_modules/@embedded-postgres/darwin-x64/native/share/postgresql/extension/
   cp "$HOME/ifd-pgbuild/src/pgvector/sql/"vector--*.sql node_modules/@embedded-postgres/darwin-x64/native/share/postgresql/extension/
   ```

   These commands assume the matching Postgres 18.4/architecture build already
   exists at that path. Missing or incompatible files remain a failed prerequisite.

2. Initialize and start the dedicated persistent database:

   ```sh
   npm run live-db -- init
   npm run live-db -- start
   npm run live-db -- status
   ```

   Init applies unchanged `db/001`–`008` in order, with a transaction and SHA-256
   ledger for each migration. A repeat init skips matching applied migrations;
   changed hashes fail for operator review. Init finishes with the database
   stopped. It preserves an existing cluster and never resets usage. The cluster
   and private socket are `~/ifd-postgres/live`; the parent, cluster and sticky
   stop directory are mode 0700, outside OneDrive. Symlinks resolving into
   OneDrive/project storage are rejected. The local operator uses a trusted
   Unix socket inside that private directory, as `ifd_owner`. The owner has no
   TCP password. TCP uses SCRAM. Runtime connects as `ifd_app`, a LOGIN role
   with no superuser, role/database creation, replication, inherited membership,
   RLS bypass, table or schema-creation privileges. It has only the four
   application RPC grants. Each runtime acquisition also checks the authenticated
   role and rejects elevated privileges or role memberships. Its random password and a generated invitation
   password are stored only in ignored, mode-0600 `.env.local`; commands omit
   raw database/process errors and never print credentials. The runtime pool is
   capped at four connections, with 3-second acquisition, 4-second statement,
   4.5-second driver query and 5-second total RPC deadlines. Failures reject
   requests; there is no process-memory fallback.

3. Import both saved owned-site corpora (including their 768-dimensional vectors):

   ```sh
   npm run live-db -- import
   ```

   Defaults: `data/benchmarks/2026-10-15/synq/ai-reviewed.json` and
   `data/benchmarks/2026-10-15/salon/ai-reviewed.json`. These are the explicitly
   permitted immutable snapshot alternative to opening the active Mac PGlite
   database. That active database is left untouched. The importer validates
   review provenance, integrity, exact owned origins and embedding space, then
   inserts both businesses in one transaction. It prints business IDs, page,
   chunk and matching-vector counts and source hashes; counts must match each
   snapshot before commit. A repeat import of the same recorded hashes checks
   counts and makes no duplicate inserts. A different snapshot is refused;
   no existing corpus, rate counter or budget is overwritten. It saves only
   `PILOT_BUSINESS_IDS`, and does not set acceptance or benchmark attestations.
   Legacy question lists/evaluation reports are not imported, so the old score
   card may be absent. To explicitly select other reviewed bundles:

   ```sh
   npm run live-db -- import --snapshots data/benchmarks/2026-10-15/synq/ai-reviewed.json data/benchmarks/2026-10-15/salon/ai-reviewed.json
   ```

4. Run the six-check proof against a **disposable** cluster, using the production
   Postgres RPC boundary and an authenticated restricted `ifd_app` login:

   ```sh
   npm run check-shared-local -- --postgres data/mac-postgres-adapter-proof.json
   ```

   Choose a fresh report filename on reruns. Required passes: two connections,
   permissions, 24-request/three-accept concurrency, persistent budget stop,
   saved-stop restart, and unsaved-stop outage replay. It uses fake HTTP quota
   only. The proof never reuses or clears `~/ifd-postgres/live`. Its output is
   local native Postgres evidence, not Supabase/PostgREST evidence. This worker
   has not executed the native proof from the sandbox.

5. Review the existing release gates and packet below. Configure ignored
   `.env.local` with the exact `PILOT_PUBLIC_ORIGIN`, isolated
   `GEMINI_EVAL_API_KEY`/`GROQ_EVAL_API_KEY`, current `FREE_TIER_CONFIRMED=yes`,
   two accepted `PILOT_BENCHMARK_HASHES`, and
   `PILOT_ACCEPTANCE_CONFIRMED=yes` **only after** the coordinator resolves the
   release-policy/evidence gates with Bosko. The script preserves these gates
   and cannot infer approval from imported AI-reviewed snapshots. Do not paste
   keys or passwords into chat or CLI arguments. Existing acceptance tooling
   still describes Supabase evidence; it does not automatically accept this new
   local proof as that hosted check. Any revised pilot acceptance must state
   the Mac scope explicitly, with retained review evidence.

6. Build once and launch production, then inspect status:

   ```sh
   npm run live -- start
   npm run live -- status
   ```

   Start forces `IFD_PILOT_MODE=yes`, both stores to `postgres`,
   `LOCAL_CHAT_MODE=real`, `LOCAL_CHAT_MAX_CALLS=60`, MCP disabled, and
   `IFD_PROVIDER_STOP_DIR=~/ifd-postgres/provider-stop`. It reads the other
   prerequisites from the environment/`.env.local`, verifies role privileges,
   builds once per explicit start and runs `next start`. Runtime model adapters
   use only eval keys. Missing gates prevent launch. Private process logs/PIDs
   live in `~/ifd-postgres`, not the repository. Status verifies process identity
   and database process state; it does **not** verify HTTP health or quality.
   Stale command locks after an interrupted command require operator inspection;
   never remove a lock while its command is still running.

Before inviting anyone, the coordinator must verify real HTTP invitation
rejection/acceptance, exact-origin denial, both business pages, citations,
unavailable-DB refusal, persistent limits/stops and tunnel TLS. Use fake model
transports for failure checks; any real answer check needs current quota and
model-call authorization. No live check is implied by a successful build.

### Stop, reset and rollback

Stop the tunnel first if immediate public isolation is needed. Stop the app
before stopping the database:

```sh
npm run live -- stop
npm run live-db -- stop
npm run live -- status
npm run live-db -- status
```

Restarts, repeat init and imports retain the persistent 60-attempt budget and
quota latch. For a deliberate reset, obtain replenishment approval and confirm
current free-account/quota status first. Stop the tunnel and **all** app
processes. Start only the DB. Using a private operator SQL connection to the
Unix socket `~/ifd-postgres/live`, port 55432, database `ifd_live`, user
`ifd_owner`, run `DELETE FROM pilot_budget;` and verify zero rows. Then remove
only `~/ifd-postgres/provider-stop/quota-stop`. Recheck both states while the app
is stopped. No reset endpoint or automatic reset command is provided. Do not
delete a cluster directory, import a stale DB or clear a marker alone to regain
quota. The earlier `data/provider-stop` reset path below applies to the old
hosted/local configuration, not this Mac launcher.

Rollback: stop the tunnel and app, preserve the live database and stop marker,
restore the previously reviewed code revision using the coordinator's normal
workflow, and rebuild/restart with the same persistent cluster. Review schema
compatibility before rollback; no downgrade or destructive reset is automatic.
Keep the prior PGlite database for offline fallback, with pilot disabled and
memory/local stores, after stopping the live app. Do not serve that fallback
through the public tunnel or use it to replenish pilot usage.

**The Mac must remain powered on, awake, connected and logged into a usable
session.** Sleep, power loss, Wi-Fi loss, OS updates and app/database crashes
make this single-host pilot unavailable. No launch-on-login, auto-recovery,
off-host replication, backup/restore verification, power-loss durability test,
high availability or Cloudflare configuration is covered here. Orderly restart
proofs do not establish power-loss recovery. Backups and a reviewed recovery
procedure are required before relying on the data beyond this small pilot.

Beginner explanation: the web app can only ask four narrow database functions
for data or permission to make a call; it cannot read or change the tables
directly. Optional exercise: with the coordinator's offline fixture setup,
predict whether an `ifd_app` table read or `ifd_read` call should succeed, then
compare the permission-test results. This is practice, not evidence of mastery.

## Earlier hosted deployment package (reference)

`render.yaml` explicitly selects a Free web service, with automatic deployments
off and no paid disk or database. Render free instances sleep after inactivity
and have ephemeral local storage, so PGlite is **not** the deployed data store.
See [Render free limits](https://render.com/docs/free) and the
[Blueprint specification](https://render.com/docs/blueprint-spec), checked October
15, 2026. Account/workspace allowances and the actual rendered configuration still
need checking before creation. No zero-cost hosting entitlement is assumed.

An isolated Supabase Free project is the proposed persistent Postgres store.
The server uses scoped RPCs over HTTPS; no new database driver is needed.
Only server credentials may invoke these functions. The browser receives no
Supabase credential and has no direct table or RPC access. Migrations revoke
PUBLIC **and explicit anon/authenticated grants**, since revoking PUBLIC alone
does not remove a role's own grant. See [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api).

Use a new, isolated project and apply `db/001_initial.sql` through
`db/008_budget_stop.sql` in order. These migrations assume pgvector is in
`public`; verify this first if it was already enabled in another schema. Do not
apply them to an existing application database. All business content has a
non-null business ID and composite scoped foreign keys. Global hashed rate
counters and the singleton provider budget are operational metadata, with
nullable business IDs; they hold no business content.

Source import SQL is generated locally from reviewed immutable bundles:

```sh
npm run benchmark -- pilot-export data/benchmarks/synq-accepted.json data/benchmarks/synq-pilot.sql
npm run benchmark -- pilot-export data/benchmarks/salon-accepted.json data/benchmarks/salon-pilot.sql
```

Draft imports were prepared in `data/benchmarks/2026-10-15/*/pilot-draft.sql`.
They deliberately raise an exception before inserting anything. After review,
regenerate without `--draft`; never remove that guard to bypass review. Imports
use transactions and plain inserts, never overwrite an existing corpus or clear
budgets. The prototype's legacy score card is not an accepted benchmark viewer;
keep the accepted evaluation artifacts with the release packet.

## Runtime controls

Pilot mode requires Supabase source data and shared rate limits, isolated provider
keys, confirmed free accounts, exactly two approved business IDs, two accepted
benchmark hashes, an HTTPS public origin, acceptance sign-off and an invitation
password of at least 32 characters. See `.env.example` and `pilot-policy.ts`.
Missing prerequisites return a generic 503 before serving the pilot.

Use username `pilot` and the private generated password in the browser's password
dialog. Do not put the password in a URL, repository, logs or chat. Pages are
marked no-store/noindex. The health endpoint is unauthenticated liveness only.
The proxy checks invitation credentials and exact POST origin before application
handling. Browser questions and replies use the existing chat page; no terminal
is needed by an invited tester. There is no public URL ingestion or admin endpoint.

Rate limiting reserves browser and business counters in one SQL transaction.
Shared-store failures reject requests, with no memory fallback. The local memory
store remains for offline/local use only. Browser-cookie identity is not a
person-level abuse guarantee: clearing cookies can renew it. Business limits and
the shared total provider-call budget bound that exposure during this small pilot.
The legacy fallback-store class is not selectable in pilot configuration.

Every embedding, answer retry and provider fallback reserves the persistent
global call budget first. The pilot cap is at most **60 provider attempts total**,
not 60 chats, and does not reset on restart. A lower configured cap lowers the
stored ceiling; a higher value cannot increase it. A quota response latches a
shared stop. A sticky local marker at `data/provider-stop/quota-stop` is written
before saving that stop and replayed before reservations after DB recovery.
This protects processes sharing the same retained working directory; it does not
close the recovery race across independent/ephemeral hosts. Render's ephemeral
disk cannot provide that durability. See the [October 17 security follow-up](security-review-2026-10-17.md)
for exact failure windows and operator reset requirements; these remain release
gates. Do not replenish counters or change account billing to keep a pilot
running. Any future budget reset requires an operator review and a deliberate
database action; there is no public reset endpoint.

### Deliberate budget reset (operator only)

Reset only after reviewing quota/free-account status and obtaining authorization
to replenish the pilot budget. A restart alone does not reset shared usage.

1. Set `PILOT_PAUSED=yes` and stop **all** application processes on **every** host,
   including development servers and workers. Keep them stopped through both
   resets so an in-memory latch cannot recreate the shared stop or local marker.
2. On the correct isolated pilot database, execute `DELETE FROM pilot_budget;`
   using the operator's SQL console. This clears both usage and the stopped flag;
   the next reservation creates a new budget using the configured cap. Preserve
   required operational evidence first. Do not alter migrations or source data.
3. In the application working directory on **every** host, remove the marker
   `data/provider-stop/quota-stop` (`rm -f data/provider-stop/quota-stop` on macOS/Linux).
   Check retained volumes, alternate working directories and replacement hosts.
   Clearing only the row or only one host's marker is insufficient.
4. Verify the row is absent and each marker is absent, confirm the intended cap,
   then restart the approved processes and unpause only after the review. Never
   copy an older database over the live database to reset usage.

While stopped, refused requests retry saving the shared stop in the background
at most once per 30 seconds, with no overlapping stop writes. The refusal does
not wait for that retry. This improves recovery in a running process; it cannot
save an event after that process and its ephemeral marker have both been lost.

Set `PILOT_PAUSED=yes` to stop the invited pilot immediately. Suspend the Render
service if necessary. Preserve reports before changes; secrets can be rotated in
provider/hosting dashboards. Redeploy the previous approved revision for rollback;
do not restore a stale database copy that replenishes usage budgets.

## Gates before requesting deployment approval

1. Dataset source review is complete as **AI review**, per Bosko's delegation.
   Do not reassign the 52-case manual task or mark it human-reviewed. The existing
   conservative release gate still expects human-validated evidence; an AI-reviewed
   prototype needs an explicitly revised release policy in the deployment approval
   packet. This review did not fabricate that approval or change the release gate.
2. Run both accepted benchmarks after free quota recovers. No execution errors or
   grounding/behavior failures; at least 90% completeness on source questions.
   Each site must retain at least ten source questions and all six trap categories.
   Keep every failed case. Partial checkpoints cannot pass readiness.
3. Compare the independent judge against at least 10 human-labeled examples,
   including passes, omissions, unsupported claims and refusals; target at least
   90% agreement and inspect each disagreement. Synthetic/assistant labels do not count.
4. Get an independent security review. Shared operating rules call for Opus on
   consequential work; that review was not available or invoked in this session.
5. Confirm hosting/database Free plans, billing limits, invitation access, source
   permissions, service-role secrecy, extension schema and anonymous RPC denial
   on the actual isolated project. Never enable paid billing to clear a block.
6. Run the real shared-database concurrency probe (no model calls):

   ```sh
   READINESS_LIVE_OK=yes npm run check-shared -- data/benchmarks/shared-postgres-proof.json
   ```

   This sends 24 simultaneous RPC requests via two clients and requires exactly
   three accepted reservations, with no errors. Random hashed probe counters
   expire after 60 seconds. It is bounded operational metadata, not business data.
   Local PGlite tests are not a substitute. Credentials must already be in the
   process environment; this tool never prints them.

   A separate local engineering proof is available on this Mac:

   ```sh
   npm run check-shared-local -- --dry-run data/local-postgres-dry.json
   npm run check-shared-local -- data/local-postgres-proof.json
   ```

   The dry run loads and hashes db/001–008 without starting a server or executing
   SQL. The live command uses embedded Postgres 18.4 and two direct SQL connections
   for the same 24-request/three-accept race, budget-stop persistence and database
   stop/restart checks. This is distinct from the Supabase PostgREST gate above;
   readiness deliberately does not accept its report as the Supabase proof.
   Native pgvector must be available to that Postgres installation to apply all
   eight migrations unchanged. The installed embedded package does not bundle it;
   missing pgvector is reported as a failed prerequisite, never silently skipped.

   Data is temporary under `~/ifd-postgres/run-<random>`, outside OneDrive and this
   project. `IFD_POSTGRES_ROOT` overrides the parent directory; project/OneDrive
   paths (including symlinks) are rejected. No existing cluster is reused. The
   cluster is retained only across the test's orderly restarts, then stopped and
   removed in cleanup. Output files are created exclusively (choose a fresh name),
   without connection credentials. No `.env.local` or provider keys are loaded.

   Each live check has a `pass` field. In particular, the unsaved-stop safety check
   fails if a fresh budget/store can reserve after recovery, or replay does not
   save `stopped=true`. The real runtime receives fake HTTP quota after DB shutdown;
   no model calls are made. Expected `acceptedAfterRecovery=false`,
   `sharedStopped=true`, `limitationObserved=false`. The coordinator's October 17
   report `data/local-postgres-proof-fix.json` records **5/5 checks passing**:
   two connections; 24 concurrent requests with exactly three accepts and zero
   errors; cross-connection budget stop; saved-stop recovery; unsaved-stop replay.
   The report records cleanup stopped/removed. This is **local direct-SQL only**,
   not hosted Supabase/PostgREST or deployment proof, and was not rerun by this worker.
   `limitationObserved` records whether the outage issue recurs. Overall exit status is
   nonzero for that safety failure or an unavailable prerequisite; a completed
   experiment does not imply the limitation is fixed. Orderly shutdown is tested,
   not machine power loss, hosted availability, browser roles or model quality.
   Hosted PostgREST still needs a void-response check for `ifd_stop_calls`
   (empty 2xx/204), actual grants/anonymous denial, and the hosted concurrency proof.
7. Prepare the acceptance JSON described below, set the deployment environment
   values to the matching hashes/IDs, and run `npm run readiness -- packet.json`.
   A pass checks local artifacts/configuration; it is not deployment authorization.
8. Present the exact revision, final configuration, proof reports and rollback
   steps for Bosko's approval. Only then push/provision/deploy. Test password
   rejection, cross-origin denial, both business pages, citations, failure handling,
   shared limits/budget persistence and deployed latency before inviting anyone.

Acceptance packet paths are private local paths; do not store credentials in it:

```json
{
  "benchmarks": ["data/benchmarks/synq-accepted.json", "data/benchmarks/salon-accepted.json"],
  "reports": ["data/benchmarks/synq-baseline.json", "data/benchmarks/salon-baseline.json"],
  "concurrencyProof": "data/benchmarks/shared-postgres-proof.json",
  "securityReview": {"reviewer": "", "at": "", "approved": false},
  "judgeCalibration": {"humanReviewed": false, "sampleSize": 0, "agreement": 0}
}
```

These are explicit operator attestations backed by retained review evidence, not
an automatic independent audit. `PILOT_ACCEPTANCE_CONFIRMED=yes` is set only after
the packet passes and its underlying evidence has been reviewed.

## Small pilot operation

Start with Bosko alone, then at most two explicitly invited testers on the owned
sites. No real business outreach. Ask testers to avoid personal or sensitive
information; free model-provider data terms must be reviewed before inviting
them. The provider still receives the question and selected public source text,
even though application logs omit it. Review host access-log behavior separately.

Capture request IDs, latency/error/refusal summaries and source-check feedback
manually. Online metadata is not answer-quality evaluation. Add useful failures
to a new reviewed benchmark version rather than editing the current baseline.
Stop on any cross-business evidence, credential exposure, invented sensitive fact,
quota stop or unexpected billing configuration. Real deployment behavior,
concurrency and monitoring remain unverified until these steps actually run.
