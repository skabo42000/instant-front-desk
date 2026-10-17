# Lost quota stop follow-up — October 17, 2026

Scope: delegated offline engineering fix, not independent acceptance or deployment.
The coordinator's supplied October 17 live evidence (`data/local-postgres-proof-20261017.json`,
private, not re-run here) reported `unsavedStopOutage` failing with
`acceptedAfterRecovery=true`; the other four checks passed.

`src/lib/provider-stop.ts` writes the constant `quota-stop-v1` marker to
`data/provider-stop/quota-stop` (ignored, outside public assets). No credentials,
URLs, questions, responses or provider error bodies are stored. The path is fixed
by server code, never request input. The directory is operator-owned; its parent
directories must also be trusted. Directory and file creation request modes 0700
and 0600; existing permissions are not rewritten. The final directory cannot be
a symlink, marker writes use exclusive creation without following links, and any
existing marker (even empty/damaged) means stopped. File and directory fsync are
attempted for a new marker. A local lookup failure refuses the reservation.

`PostgresProviderBudget.stop()` latches in memory and writes locally **before**
awaiting the database stop. It still attempts the DB stop if the local write fails.
`reserve()` checks the marker first; if present it replays `ifd_stop_calls` and
returns false, or throws if replay fails. It never invokes the reservation RPC
on that path. Fresh budget/store objects, including processes sharing the same
working directory/filesystem, see the same marker. Once replay succeeds, the DB
stop also protects processes without that filesystem. There is no migration or
automatic marker deletion; keeping it sticky avoids a concurrent reset/delete
race. An operator must review quota, pause **all** processes and deliberately
reset both the database stop/budget and local markers before resuming. A DB reset
alone cannot clear the local stop.

`scripts/shared-local.ts` now reserves through the real chat runtime, returns a
fake quota response only after stopping Postgres, exercises the failed stop and
outage reservation, restarts Postgres, then uses fresh budget/store objects to
replay the marker. It checks both rejection and the saved DB `stopped=true` row.
Earlier saved-stop checks use a separate empty local directory so the marker
cannot hide a DB persistence regression. All resets are confined to its disposable
cluster/directory. The fake HTTP transport makes no provider calls.

Expected live result: all five checks pass, `unsavedStopOutage` has
`quotaRejected=true`, `stopRejected=true`, `reservationRejected=true`,
`connectionRejected=true`, `sharedStopped=true`, `acceptedAfterRecovery=false`
and `limitationObserved=false`. No live result is claimed here. The coordinator
must run `npm run check-shared-local -- data/local-postgres-proof-fix.json`.

## Exactly what remains uncovered

- Process termination/host loss before marker creation, and power/storage failure
  before durable file and directory writes complete. fsync cannot guarantee
  survival of hardware/filesystem failure; platforms without directory fsync may
  report a local-write error despite an existing marker.
- Simultaneous failure of the local write and DB stop: only the current budget
  and runtime retain the in-memory latch. Another process cannot recover an event
  that neither store recorded. Local filesystem repair alone is not a quota reset.
- Independent hosts, different working directories, erased/rolled-back markers,
  ephemeral host replacement or unsynchronized filesystems **before** replay saves
  the shared stop. Another host can reserve first after DB recovery. OneDrive sync
  is not a distributed locking/consensus mechanism. Render's ephemeral filesystem
  does not supply this durability; cross-host/replacement safety remains a release
  gate, requiring durable shared storage or another reviewed design.
- Calls already reserved/in flight, or a reservation whose local check preceded
  marker creation, cannot be retracted. The provider response, filesystem and DB
  do not form one atomic transaction.
- Offline tests use fake HTTP/RPC or single-connection PGlite. The proof script
  uses fresh objects, not a separate application OS process, and orderly database
  restarts, not machine crashes. Actual Postgres rerun, Supabase permissions,
  independent review and other pilot acceptance gates remain pending.

Beginner explanation: the marker is a persistent stop sign. After the database
comes back, the app copies that stop sign into the database before allowing any
new reservation. Optional exercise: explain why clearing only the database stop
does not resume calls. This suggestion does not establish demonstrated learning.
