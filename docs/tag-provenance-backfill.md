# Offline Tag Provenance Repair

`apps/server/scripts/backfill-tag-provenance.ts` restores missing source occurrences from retained snapshots. It never imports media, invokes plugins, performs provider requests, queues/retries jobs, changes environment files, or runs migrations.

## Review and Apply

Run from the repository root:

```sh
corepack pnpm --filter @repo/server exec tsx scripts/backfill-tag-provenance.ts --media-type=album --name='Arena Rock' --report=data/backups/arena-rock-dry-run.json
```

The default transaction is repeatable-read and read-only. `--media-type=album|film` is required; omitting `--name` audits the selected library. Media IDs are scanned with a cursor in batches of 100; only snapshots for matching memberships in the current batch are loaded. Full raw library payloads are not accumulated. The retained plan contains matching raw tag evidence, snapshot IDs/checksums, proposed occurrences, source links, and unresolved entries. `--report` exclusively creates a permission-0600 JSON file; it never overwrites an existing report. Console output limits detailed examples to 20, while counts and the optional report cover the full scope.

Review the exact proposed scope, count, raw evidence, unresolved entries, and returned `review` hash. Coordinate a fresh full Postgres backup with the parent/operator, verify it with `pg_restore --list`, and obtain approval before any apply. The CLI additionally checks for a custom-format `PGDMP` backup created within the last hour; this header check does not replace restore verification or identify which database the backup contains.

```sh
corepack pnpm --filter @repo/server exec tsx scripts/backfill-tag-provenance.ts --media-type=album --name='Arena Rock' --apply --backup=data/backups/verified-fresh.dump --review=REVIEWED_SHA256
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

## Arena Rock Reproduction

The original album occurrence for _Plastic Hearts_ had null provider/source and raw name `arena rock`, kind `genre`. Its stored MusicBrainz `releaseGroup.genres` contains the exact name and genre UUID `26af3760-750a-4b5e-a699-78c87697585a`; Discogs `master.styles` contains `Arena Rock`. A retained legacy-record snapshot independently contains both structured entries. Last.fm wiki text and Google search snippets also mention arena rock, but are deliberately excluded as evidence.

The focused dry run scans one membership and ten snapshots and proposes two source occurrences. MusicBrainz uses its name-based tag page (`https://musicbrainz.org/tag/arena%20rock`), not the saved release-group link. Links resolve through the standard source-navigation helpers; changing those helpers requires a fresh reviewed plan hash. The original unknown occurrence remains in the database, preserving the historical migration record. Read responses hide it only when an attributed occurrence matches the same item, tag ID, normalized original name and kind.

## Applied Audit: 2026-10-28

After the parent verified a fresh full backup and approved the reviewed plans, separate transactions inserted 33,360 album occurrences and 8,637 film occurrences. Subsequent read-only audits proposed **zero additional occurrences in both libraries**. Snapshot and membership scan counts remained unchanged. This is a partial provenance recovery, not a claim that every unknown source was resolved.

| Library | Snapshots scanned | Memberships scanned | Inserted occurrences | Memberships receiving additions | Unresolved entries |
| ------- | ----------------: | ------------------: | -------------------: | ------------------------------: | -----------------: |
| Album   |            32,432 |              38,750 |               33,360 |                          24,056 |             14,659 |
| Film    |            27,639 |              19,756 |                8,637 |                           7,147 |              3,146 |

A separate read-only diagnostic inspected unresolved items in batches of 100. These buckets identify evidence shapes for later investigation, **not permission to attribute or insert additional sources**. Buckets are mutually exclusive, with supported kind mismatches taking priority, then the first retained structured-field example. A name appearing in a field is not by itself proof of its historical transformation into the stored tag kind.

| Album unresolved bucket                                                    | Entries |
| -------------------------------------------------------------------------- | ------: |
| No exact structured name match in the inspected item snapshots             |  11,984 |
| RYM structured genre fields not handled by this repair                     |   2,463 |
| Legacy Last.fm tag fields (108 singleton objects and one blank array name) |     109 |
| MusicBrainz general tags versus stored genre kind                          |      71 |
| Search-result structured metadata, not accepted tag evidence               |      32 |

| Film unresolved bucket                                            | Entries |
| ----------------------------------------------------------------- | ------: |
| Private-provider tag fields requiring their own validated adapter |   3,124 |
| No exact structured name match in the inspected item snapshots    |      18 |
| Raw NFO genre fields not covered by normalized tags               |       3 |
| Other structured field requiring investigation                    |       1 |

No exact Spotify artist-level genre matches were found in this item-scoped diagnostic. That does not rule out historical artist-derived data outside the retained item snapshots. The unmatched album names are deliberately not assigned to Spotify based on how those names look.

Ignored permission-0600 reports under `apps/server/data/backups/` retain the full reviewed plans, apply results, post-apply audits, and `tag-provenance-{album,film}-gap-buckets-20261028.json` with diagnostic snapshot/path examples. They are local audit artifacts, not committed library data. The redundant-unknown read predicate uses the existing media-item and tag occurrence indexes; no schema change was required.

## Bounded Album Reader Follow-Up: 2026-10-28

Read-only inspection reproduced both gaps against actual retained snapshots with empty normalized data. For the same album, Google snapshot `DOE5iYRj5H-NME2r0Uuqo` contains `rymGoogle.genres: ['Radio Drama', 'Electroacoustic', 'Sound Collage']`; Last.fm snapshot `-rPVTZPMsbxoZi-a7MCil` contains `tags.tag: { name: '2024', url: 'https://www.last.fm/tag/2024' }`. Legacy-record snapshot `pdwAFAnUOi6hVF3WmxKmX` retains both fields independently. Snapshot IDs, checksums, exact field paths, and raw matched values remain in the dry-run report.

Historical mapping proof comes from `legacy/server-src/music/clean/index.ts`: lines 33-34 wrap a Last.fm singleton into an array; lines 98-104 merge `rymGoogle.genres` and those Last.fm names into album genres. `apps/server/scripts/import-legacy.ts` also maps both fields to `kind: 'genre'`. Its `normalizeGoogleSearchPayload` emits no explicit source, so this repair retains the existing backfill fallback namespace `provider: 'google-custom-search', source: 'google-custom-search'`, not the modern plugin's `source: 'rym'`. Existing attributed origins with a null source are recognized as the same provider fallback and remain untouched.

RYM recovery accepts only a validated string array at `payload.rymGoogle.genres`, in a Google snapshot or a retained legacy record. The historical scraper populated that array from search metadata, but this repair does not repeat that extraction or read `rawResponse`, snippets, prose, generic genres, Metacritic fields, or artist tags. Last.fm singleton recovery accepts only a named object at album `tags.tag` for a legacy source, not `toptags`, arbitrary strings, or modern scrape singleton payloads. Array behavior is unchanged; modern Last.fm arrays remain `general`, not `genre`. Singleton evidence paths do not invent an array index.

The initial follow-up dry run proposes **6,088 occurrences across 6,083 memberships**, with no writes:

| Provider                                   | Proposed occurrences | On previously unresolved memberships | On memberships already recovered from another provider |
| ------------------------------------------ | -------------------: | -----------------------------------: | -----------------------------------------------------: |
| Google Custom Search (retained RYM genres) |                5,975 |                                2,500 |                                                  3,475 |
| Last.fm (legacy singleton objects)         |                  113 |                                  109 |                                                      4 |

These additions resolve 2,605 previously unresolved entries, leaving **12,054**. Both providers match four of those entries, so their per-provider recovery counts are not additive. Against the original mutually exclusive diagnostic buckets, all 2,463 RYM entries and 108 Last.fm singleton entries resolve; 34 of the 71 kind-mismatch entries resolve through independent supported evidence, without converting MusicBrainz general tags to genres. The remaining Last.fm bucket entry is a whitespace-only name in an array, not an unsupported singleton, and is deliberately rejected. The 11,984 unmatched entries and 32 search-metadata entries remain unresolved.

All proposed Last.fm additions have links from the existing helper. All proposed Google additions have null links because the current navigation helper does not support that namespace; this does not invalidate the retained structured attribution. No navigation or tag-service changes are included in this follow-up.

The initial plan is stored in `apps/server/data/backups/tag-provenance-album-readers-dry-run-20261028.json`. A second audit after the latest observed source-navigation edit produced an identical permission-0600 report, `tag-provenance-album-readers-reviewed-dry-run-20261028.json`, with review hash `5268a26fe6b7376c7f70f640e571f36a55befaa6e53130de030001506cf34c39`. Both scanned 32,432 snapshots and 38,750 memberships. The film regression report, `tag-provenance-film-readers-regression-dry-run-20261028.json`, still proposes zero additions and retains all 3,146 unresolved entries.

The parent subsequently authorized exactly that 6,088-origin hash. Before the single apply attempt, `provenance-20261028.dump` was approximately 36 minutes old; `/opt/homebrew/opt/libpq/bin/pg_restore --list` successfully listed its 226 entries. The default `pg_restore` was too old for archive format 1.16.

The apply rejected the approved hash with `Dry-run evidence changed` before inserting any occurrences. No apply retry was made and no apply report was created. A subsequent read-only audit, `tag-provenance-album-readers-changed-plan-20261028.json`, still proposes 6,088 additions with 12,054 unresolved entries. Its additions (including evidence and links) and unresolved arrays are identical to the approved report; only scan totals changed, from 32,432 to 32,437 snapshots and from 38,750 to 38,759 memberships. The new review hash is `c4205494094e13d1ccf74482a2f997d64e150c75c82bf723211f53aff83319bf` and requires fresh approval. This follow-up remains unapplied; recheck backup freshness before any newly authorized attempt. Film/private-provider readers remain unchanged.

Final status: **pending and unapplied**, explicitly held at the parent's request while the user continues scraping. Do not retry. Any later apply requires a fresh reviewed plan, a fresh verified backup, and renewed authorization; the 12,054 unresolved count above describes the pending plan, not a completed repair.
