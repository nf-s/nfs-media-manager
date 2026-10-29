# Historical Job Split

Repair retained multi-item scrape jobs into one job per item, without scraping, resetting provider safety, or deleting job IDs. Only terminal multi-item jobs are eligible. Existing single-item jobs remain unchanged.

## Run

From the repository root, preview first:

```sh
pnpm --filter @repo/server exec tsx scripts/split-job-history.ts --report=/absolute/path/job-split-preview.json
```

Review counts, the complete item-to-job mapping, blockers, unresolved retry links, unattributed history and foreign-key references. Before applying, create and verify a **full PostgreSQL database backup** using `pg_dump`. Keep the backup and reports outside the repository. The CLI does not create or verify the backup; this is an operator prerequisite.

With the backup complete and the preview reviewed, use a different, fresh report path:

```sh
pnpm --filter @repo/server exec tsx scripts/split-job-history.ts --apply --report=/absolute/path/job-split-apply.json
```

Dry-run is the default. `--apply` explicitly enables mutation. `--report=<path>` is mandatory in both modes. Existing files and symlinks are refused; reports are created with mode `0600`. The complete plan is written and synced before any database mutation. The saved report is a **pre-mutation plan**, not proof of commit; the CLI's `applied` result confirms transaction success. Each run allocates fresh proposed child IDs, so preview and apply mappings can differ.

## Preservation

The earliest item by `(createdAt, id)` retains its original job ID. Other items receive new IDs generated with `nanoid`. Each resulting scope contains exactly one media ID, its actual media type and `limit: 1`. The original batch ID is retained, or the original job ID becomes the batch ID.

Items, attempts, messages and raw payloads are retained. Job/item timestamps retain database precision. Parent timestamps, dismissals and options carry forward; original scope, status, error, options and item status are saved under `options.jobHistorySplit`. Per-item job errors come from item messages; successful jobs have no error. Stale queued/running items under terminal parents become cancelled, never queued for execution.

Snapshots keep their IDs, payloads, checksums and timestamps; `scrapeJobId` follows the matching media item. Item-specific logs follow `metadata.mediaItemId`. All original log IDs survive. Shared logs remain on the original job and are copied to children with explicit legacy-batch audit context. Provider current state and cooldown/reset history are untouched. Database foreign keys are inspected, including legacy `provider_cooldown_reset.scrape_job_id` references; no job IDs are deleted.

## Limits And Safety

The service runs atomically with queue advisory lock `614104`. Apply also briefly locks affected tables against concurrent writers and refuses lock contention after five seconds. Use a quiet maintenance window. It imports no queue, worker or provider code.

Queued/running multi-item parents, missing media identities and duplicate media identities block the entire apply. Retry links are resolved by media identity and provider; unknown or mismatched links are removed from split jobs but retained in original-options provenance. If splitting would make an inbound retry link from an untouched job incorrect, apply refuses rather than editing that single-item job. Resolve these cases separately.

Unattributed snapshots and other foreign keys retain their original job ID and are reported. Unmatched item-scoped logs are retained as legacy batch context and reported. Shared log copies do not establish item-specific success or failure. No inference is made about undocumented option relationships.

Rerunning after a successful split makes no changes and reports zero split counts. A failure rolls back database changes; its pre-mutation report may still exist. Review the error and use a new report path for another attempt.
