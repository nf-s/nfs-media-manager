# Job Worker Lifecycle

`apps/server/src/services/job-worker.ts` owns worker startup and shutdown. The
dispatcher remains in `services/jobs.ts`; its `shouldDispatch` predicate stops
new claims while already-started work drains.

## Ownership

`await startJobWorker({ onFatal, pollIntervalMs? })` returns a worker with an
idempotent `stop(): Promise<void>`. The default poll interval is two seconds.
Startup checks out a dedicated connection from `db.$client` and obtains PostgreSQL
session advisory lock `614105`. This consumes one pool connection for the worker's
whole lifetime. A second worker fails startup without recovering or dispatching
anything. There is no standby takeover loop or automatic reconnect.

The lock is scoped to the database, not a search path. All server instances for
the database must use this worker entrypoint. Do not invoke the dispatcher directly
from another process. Legacy workers do not participate in this lock: stop them
before deploying this lifecycle. Do not run mixed old/new workers.

The dedicated connection is probed on polling ticks, including while a dispatcher
is active, with a five-second query timeout. Connection errors, unexpected session
closure, failed probes, dispatch errors, or an unexpectedly missing lock during
shutdown disable dispatch and invoke `onFatal` once. The callback must terminate
the application immediately. The server uses exit status 1, not a graceful drain,
when ownership is unsafe. No distributed lock can retract a provider request
already sent before connection loss; normal job-row write fences protect retained
database results against later recovery/cancellation.

## Interrupted Jobs

Before scheduling any dispatch, the owner recovers jobs with status `running` in
one transaction on the ownership connection. Recovery locks each parent job row
for update, using the same parent-row fence as provider-result writes and
cancellation. A completion committed before that lock is acquired is preserved.
Loss of the ownership connection rolls back the recovery transaction.

Each interrupted parent and its still-`queued`/`running` items becomes `failed`, with a
finish timestamp and an interruption reason. One error audit log per parent uses
`metadata.reason = "worker_interrupted"`. Attempts, payloads, start timestamps,
options (including dismissal metadata), original logs, completed items, snapshots,
current provider state, and provider budgets/cooldowns/halts/leases are preserved.
Existing terminal item messages are retained. Queued items keep attempt count zero
and their null start timestamp. If every item already succeeded before the crash,
recovery instead finalizes the parent as `succeeded` and appends an informational
`worker_recovered_completed` log, without changing items or saved results.

Queued parents and all their items are not rewritten. Explicit manual retry of an
interrupted job must create a new job. Existing genuinely queued jobs remain eligible for normal polling after
startup. Recovery itself never calls providers, queues retries, or resets provider
safety. Repeating startup does not append more interruption logs or alter already
recovered jobs. Only items belonging to a running parent are recovery candidates.

## Shutdown

On SIGINT or SIGTERM, the server disables dispatch, stops accepting HTTP
connections, and waits for both active requests and the dispatcher to finish. The
worker retains ownership through the drain, then unlocks and destroys its dedicated
connection. Finally the server closes the pool. Repeated stop calls share the same
promise. Shutdown does not cancel jobs or reset provider limits, and it has no
forced drain deadline. An external forced termination leaves running work for the
next owner's recovery.

## Verification

### Job Response JSON

`GET /api/v1/scrape/jobs/:id/data` requires authentication and reads saved data
only. It returns snapshots linked by `provider_snapshot.scrape_job_id`, failure
diagnostics from that job's logs, and legacy successful item payloads where no
snapshot is linked. It never substitutes the item's current provider state or a
different attempt's snapshot. Deleted media IDs may be null.

The jobs page loads these blobs on expansion rather than including them in list
polling. Failed jobs do not necessarily have snapshots: response diagnostics must
have been captured before the adapter threw. Old failed jobs without retained
responses cannot be reconstructed; viewing their JSON must not trigger a retry.

Serply records each search query, HTTP status and response JSON before validating
the result or reporting a lookup miss. These diagnostics are credential-redacted
and bounded: each response entry is at most 48 KiB, and a job's diagnostic
collection is at most 128 KiB. Truncation and unavailable bodies are explicitly
marked. HTTP error-body reads use the existing 16 KiB helper limit. If the request
gateway fails before returning a response, there is no response body to retain;
the normal error log remains the evidence. This adds no requests or retries.

### Lifecycle Tests

Run the isolated tests from the repository root:

```sh
corepack pnpm --filter @repo/server exec vitest run --config vitest.integration.config.ts integration/job-worker.integration.ts
```

The suite creates/drops a uniquely named temporary database, mocks dispatch, and
forbids outbound fetches. It checks preservation and idempotence, exclusive
ownership, stop/drain ordering, connection-loss fatal handling, row-lock races,
late-write fencing, and recovery rollback. Connection-loss testing terminates only
the advisory-lock session in that temporary database. It neither starts the server
nor recovers or changes jobs in the configured application database.
