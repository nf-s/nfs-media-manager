# Offline Tag Provenance Repair

`apps/server/scripts/backfill-tag-provenance.ts` restores missing source occurrences from retained snapshots. It never imports media, invokes plugins, performs provider requests, queues/retries jobs, changes environment files, or runs migrations.

## Review and Apply

Set `TAG_NAME` to the original label to inspect. Run from the repository root:

```sh
corepack pnpm --filter @repo/server exec tsx scripts/backfill-tag-provenance.ts --media-type=album --name="$TAG_NAME" --report=data/backups/tag-preview.json
```

The default transaction is repeatable-read and read-only. `--media-type=album|film` is required; omitting `--name` audits the selected library. Media IDs are scanned with a cursor in batches of 100; only snapshots for matching memberships in the current batch are loaded. Full raw library payloads are not accumulated. The retained plan contains matching raw tag evidence, snapshot IDs/checksums, proposed occurrences, source links, and unresolved entries. `--report` exclusively creates a permission-0600 JSON file; it never overwrites an existing report. Console output limits detailed examples to 20, while counts and the optional report cover the full scope.

Review the exact proposed scope, count, raw evidence, unresolved entries, and returned `review` hash. Coordinate a fresh full Postgres backup with the parent/operator, verify it with `pg_restore --list`, and obtain approval before any apply. The CLI additionally checks for a custom-format `PGDMP` backup created within the last hour; this header check does not replace restore verification or identify which database the backup contains.

```sh
corepack pnpm --filter @repo/server exec tsx scripts/backfill-tag-provenance.ts --media-type=album --name="$TAG_NAME" --apply --backup=data/backups/verified-fresh.dump --review=REVIEWED_SHA256
```

Apply obtains the existing tag-write advisory lock in a serializable transaction, reconstructs the plan, and rejects a changed hash before inserting anything. A conflict or error rolls back the complete transaction. Do not automatically retry failures: inspect the cause, rerun the dry run, coordinate a new backup if necessary, and review again. A report written inside a transaction records the plan, not independent proof that its commit succeeded. Confirm committed changes with a subsequent read-only audit/API request. Repeating the audit after successful apply proposes zero duplicate additions; applying that new empty plan inserts zero rows.

## Evidence Rules

- Match only the same media item, medium, original kind, and original normalized name. NFC, whitespace and case normalization reuse the existing tag identity helper; no fuzzy matching, punctuation rewriting or cross-library inference is added.
- Target original wholly unattributed occurrences or memberships lacking occurrences. Original occurrence names survive merges and remain the match target; the current renamed canonical label is not substituted.
- Recover validated normalized tags and supported explicit raw tag fields: MusicBrainz genres/tags, Discogs genres/styles, Last.fm tags (including legacy album `tags.tag` singleton objects), retained `rymGoogle.genres` string arrays, Spotify album genres, and TMDb/OMDb/MDBList fields through existing film normalizers. Known provider sections in retained legacy records are also read. Conflicting source IDs remain unresolved.
- Do not infer tags from artist genres, prose, search snippets, generic browse arrays, or unsupported private-provider payload shapes. An unresolved entry means no exact match was recovered by these supported readers, not proof that no evidence could exist elsewhere.
- Insert additive occurrences using the existing stable-ID algorithm. Never update/delete existing valid or unknown occurrences, raw snapshots, checksums, normalized payloads, aliases, membership, hidden state, or job state. Existing attributed origins are not replaced or enriched by this repair.
- Reuse the source-navigation helpers for validated links. Unsupported URLs remain absent. Provider attribution can still be proven even when a direct or saved item link is unavailable.

`missingMemberships` counts memberships containing retained unattributed origins (or no occurrences), so it can remain nonzero after repair. Historical unknown rows intentionally stay present. Use `planned`, `alreadyPresent`, and `unresolvedCount` to assess remaining repair work. Proposed occurrence counts can exceed recovered memberships because multiple providers independently contain a tag.

The legacy album reader accepts explicit `rymGoogle.genres` string arrays and named Last.fm `tags.tag` singleton objects with the historical genre kind. Modern Last.fm tags remain general tags. A matching name with a different kind is insufficient. See [tag source navigation](tag-source-navigation.md) for how attributed occurrences are displayed.
