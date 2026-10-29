# Retired Spotify audio features

This removes existing values, rather than only hiding columns. Do not run apply until the database has a verified restorable backup and the dry-run report has been reviewed. Source library JSON and the old repository are read-only; neither command below reads or rewrites those files. No provider registry, scraper, import runner or job queue is loaded.

## Audit

From the workspace root:

```sh
pnpm --filter @repo/server exec tsx scripts/remove-spotify-audio-features.ts --dry-run
```

Dry run is also the default with no arguments. It uses a read-only database transaction and writes only a JSON report to stdout. The report includes `changedRows` and per-table `scanned`, `changed`, `updated`, `columns` and `removed` counts; it contains no titles, provider payloads or private identifiers. Counts are removed keys/containers or filter/sort clauses, not individual numbers nested inside deleted audio-feature containers.

The scan includes album `media_item.metadata`, `album.metadata`, `track.metadata`, album provider-reference metadata, album overrides, provider snapshots/current state, and album job-item payloads. It also includes detached Spotify snapshots, music library-context snapshots, smart-playlist definitions and orphaned legacy records with a Spotify payload. Films and unrelated fields are excluded. Archived album rows are included because hiding a row is not deletion of its held values.

## Apply And Restore

Take a full Postgres backup first and retain it unchanged. Then choose a new directory under ignored local runtime data. The following path is relative to `apps/server` because pnpm executes there:

```sh
pnpm --filter @repo/server exec tsx scripts/remove-spotify-audio-features.ts --apply --backup-dir=data/backups/audio-features-NEW
```

The directory's parent must exist; the final directory must not already exist. The CLI creates it with mode 0700 and writes per-table JSONL files with mode 0600. Each entry records the complete `before` row, table, ID column and intended column updates. Each preimage is flushed to disk before its update. Do not commit or publish these files: they intentionally retain original provider data and removed values for restoration.

Apply changes only targeted JSON columns and affected snapshot/current-state checksums, in one database transaction. It never deletes rows, changes snapshot links/timestamps or alters job statuses. Concurrent changes to a column being cleaned abort and roll back the transaction; lock waits are limited to two seconds. Unchanged rows are not locked. Prefer a quiet window and rerun the audit after completion, because a dry run is not a reservation of database state. If rollback occurs, retain the partial backup and retry only with another new directory after inspecting the conflict. `report.json` is written after successful commit; a missing report alone is not proof that the transaction rolled back if the process exited during commit/report writing.

Checksums use the existing `checksumJson({ provider, payload, normalized })` formula from provider persistence. Standalone `legacy-library` and `legacy-smart-playlists` snapshots retain their importer convention, `checksumJson(payload)`. Compare-and-swap checks both JSON inputs when updating a checksum, including nullable normalized data. Any later migration that rewrites normalized tags must also recompute the affected provider checksums; this cleanup intentionally does not canonicalize or otherwise change the existing hashing algorithm.

For a full restore use the pre-cleanup Postgres backup. For a targeted restore, review each JSONL entry and restore only the columns listed in `updates` from `before`, matched by `table` and `idColumn`; compare the current row against the recorded updates first so newer user/provider changes are not overwritten. Backup files include original checksum values. Do not replay the whole `before` row blindly. Restoration is a deliberate operator task, not an automatic CLI action.

Rerun the dry run after apply. A second apply should make no updates. No actual application-database cleanup is part of the automated test suite; runner tests use in-memory stores.

## Boundaries

`audioFeatures`, `audio_features` and `audio-features` containers are retired as complete audio-feature responses. Sibling track IDs, URLs, duration, artists, ratings, popularity and playlist destinations survive. Direct feature keys include acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence, time-signature and analysis-URL variants. Ambiguous numeric `mode` and `key` are removed only at music-record/browse/metadata locations or alongside explicit features; string filter modes and unrelated configuration objects are preserved.

Saved-view feature filters/ranges are removed; retired legacy sorts fall back to Added descending. Names, limits, provider destinations and unrelated filters remain. The untouched source files and backups are the record of the original retired definitions.

The legacy music importer scrubs raw album input, exported Spotify normalization, cleaned browse snapshots, smart-playlist definitions and music library context. Provider persistence applies the same guard to raw and normalized album results. Browse contracts reject retired keys. The job executor must also sanitize album results before retaining a separate job-item payload.
