# Controlled browser pilot — prepared, not deployed

Localhost is stopped at Bosko's request. No public URL has been created. Hosting,
database provisioning, pushes and deployment still need his approval. Bosko
delegated the 52-case source review to AI instead of doing it manually. That work
is complete and explicitly labeled AI; it does not supply human calibration or
release sign-off. Readiness currently fails by design; no release gate was forged.

## Deployment package

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
shared stop. Do not replenish counters or change account billing to keep a pilot
running. Any future budget reset requires an operator review and a deliberate
database action; there is no public reset endpoint.

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
   fails if a new budget can reserve after recovery: `limitationObserved` records
   whether the open outage issue was actually reproduced. Overall exit status is
   nonzero for that safety failure or an unavailable prerequisite; a completed
   experiment does not imply the limitation is fixed. Orderly shutdown is tested,
   not machine power loss, hosted availability, browser roles or model quality.
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
