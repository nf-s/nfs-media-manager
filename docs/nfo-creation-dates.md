# NFO creation dates

NFO imports read the filesystem's `birthtimeMs` and retain the absolute NFO path in `media_item.metadata.nfo`. XML `dateadded` is retained in the raw snapshot but is not used as Added. Zero, negative, invalid or future creation timestamps are unavailable; there is no mtime/ctime fallback. Verified NFO creation timestamps take priority over other imported date estimates, even older ones. Manual Added overrides take highest priority. Displaced values and source labels remain in history.

The Overview shows the NFO path as selectable text. These are local filesystem paths, not web links.

## Existing library audit

Run from the repository root, using normal dotenv configuration:

```sh
pnpm --filter @repo/server exec tsx scripts/audit-nfo-dates.ts \
  --root /Volumes/movies \
  --map /mnt/nas/movies=/Volumes/movies \
  --report /tmp/nfo-dates-dry-run.json
```

`--root` may be omitted when `SCAN_DIR` is configured. Repeat `--map oldRoot=currentRoot` for additional explicit roots. Reports use exclusive creation and restrictive permissions; choose a new filename for each run. No credentials, scrapers or provider requests are used.

The audit covers all films with NFO snapshots, legacy NFO paths, or file source status, including hidden legacy rows. It traverses regular NFO files within existing scan safety bounds and exclusions. Matching uses exact mapped paths, unique IMDb/TMDb identities, or the sole NFO in the exact mapped directory. Conflicting IDs, duplicate matches, missing files and unreadable XML remain unresolved. It never guesses by basename or title. Manual identifier overrides take precedence.

Inspect all report results and errors before applying. Create a complete PostgreSQL backup, then repeat the command with a new report destination and:

```sh
  --apply --backup /absolute/path/to/database.dump
```

Apply requires an existing nonempty backup file. The operator must verify it is a valid complete backup of the correct database. Apply rescans the current files, rechecks candidate birthtimes and identities, then locks media rows and rejects concurrent date/path changes. Changes and per-film before/after snapshots commit in one transaction. Existing provider snapshots/current payloads, unrelated metadata and freshness timestamps remain intact. Repeating the audit is idempotent. No import or scraping jobs are created.

Other-source re-imports cannot replace a verified NFO creation timestamp. The actual creation timestamp also remains in `metadata.nfo.createdAt` and the repair history, even when a manual override is active. A missing birthtime does not erase a previous date: it is explicitly reported for review.
