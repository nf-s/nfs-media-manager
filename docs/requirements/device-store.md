# Device store

A device keeps a copy of the library in SQLite and answers Browse reads from it. PostgreSQL stays the source of truth. The server publishes finished rows and a numbered change feed; shared TypeScript exposes the same read operations from the API or from SQLite. Three stages: the server feed (DEVICE-01 to 12), the store package (DEVICE-20 to 33) and the web client (DEVICE-40 to 47).

Out of scope: a desktop shell, a phone app, offline playback, an offline queue for edits and artwork caching.

## Contract between the stages

The contract is `packages/schemas/src/device.ts` (row shapes, feed requests and responses) and `packages/library-source/src/source.ts` and `driver.ts` (the two interfaces). A change to any of them changes this page in the same commit.

### Entities

| Entity          | Key                  | Holds                                                                                        |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `track`         | media item ID        | `TrackListItem` and its projection                                                           |
| `album`         | media item ID        | `AlbumListItem` and its projection                                                           |
| `film`          | media item ID        | `FilmListItem` and its projection                                                            |
| `artist`        | artist ID            | `ArtistSummary` without `listeningMonths` and `links`, and its projection                    |
| `playlist`      | playlist ID          | `PlaylistSummary` without `sync.job`, and its projection                                     |
| `tag`           | tag ID               | name, key, library, hidden, alias target, identity keys and ancestor keys                    |
| `scrobble_name` | hash of the name key | play times of one scrobbled name (listener, artist key, track key), as epoch seconds         |
| `album_plays`   | album ID             | play times of scrobbles linked to the album                                                  |
| `artist_plays`  | artist ID            | play times of scrobbles attributed to the artist, each scrobble once                         |
| `meta`          | name                 | `fields:album`, `fields:film`, `fields:track`, `fields:artist`, and the listening start date |

Only rows in the default scope are published: in the library, not merged away, and for tracks, albums and films including archived rows with a flag (Albums and Films can show them). A row leaves the feed as a tombstone when it is deleted, merged away or removed from the library.

### Row shape

Every item row (`track`, `album`, `film`, `artist`, `playlist`) is `{ item, text, search, num, sort, extra }`:

- `item`: the list item exactly as the API returns it for an unfiltered request, without request-dependent fields (`listeningScrobbles`, `recordingGroup`, `links`).
- `text`: for each text field, the values a filter on that field compares with, as the Browse service reads them.
- `search`: for each field that `q` searches, the values a word may match, where they differ from `text`.
- `num`: for each range field, the number the range compares with; dates as epoch milliseconds.
- `sort`: for each sort key, the value the service orders by where it is not the `text` or `num` value, and the tie-break tuple.
- `extra`: per entity. Tracks: redundant Last.fm placeholder flag, archived flag, tag IDs per level (own, own from Sonovault, album), artist tag keys, album release-tag count, first tag name per level, library-wide recording group key and the representative ordering values, scrobbled name IDs, credited artist IDs. Albums: archived flag, edition flag, release tag IDs, artist tag keys, release-tag count, credited artist IDs. Films: archived flag, tag IDs, credited person IDs by role. Artists: raw tag keys, playlist IDs.

The server fills `text`, `search`, `num`, `sort` and `extra` with the same SQL expressions the Browse service filters, searches and orders by, so the two cannot drift. The device never recomputes them.

### `LibrarySource`

One method per read. Each returns `{ served: true, data }` or `{ served: false, reason }`; a source never returns a partial or approximate answer.

- Tracks: `trackPage`, `trackCount`, `trackList`, `trackPositions`, `trackRecordings`, `trackFacets`, `trackHistogram`
- Albums: `albumPage`, `albumCount`, `albumList`, `albumFacets`, `albumHistogram`
- Films: `filmPage`, `filmCount`, `filmList`, `filmFacets`
- Artists: `artistPage`, `artistCount`, `artistFacets`, `artistHistogram`
- Playlists: `playlistPage`, `playlistCount`
- `fields(library)`

Arguments and results are the existing shared schemas (`TrackQuerySchema`, `AlbumQuerySchema`, `FilmQuerySchema`, `ArtistQuerySchema`, `PlaylistBrowseQuerySchema`, `BrowseFacetQuerySchema`, the page, count, facet and histogram schemas). `resolveLibraryRead(method, path)` maps an API request to a method and its parsed query, or to nothing. Implementations: `RemoteLibrarySource` (the API), `DeviceLibrarySource` (SQLite) and `FallbackLibrarySource` (device first, then remote).

### `SqliteDriver`

```ts
type SqlValue = string | number | null
interface SqliteExecutor {
  run(sql: string, params?: readonly SqlValue[]): Promise<void>
  all(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<Record<string, SqlValue>[]>
}
interface SqliteDriver extends SqliteExecutor {
  /** Several statements without parameters, for the schema. */
  exec(sql: string): Promise<void>
  /** Runs `work` in one transaction; rolls back when it throws. */
  transaction<T>(work: (tx: SqliteExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
}
```

The store uses nothing else from a host: no custom SQL functions, collations or extensions beyond FTS5 with the trigram tokenizer. Case folding and normalisation happen in TypeScript before a value is stored or bound.

## Stage 1: server feed

- DEVICE-01: `device_row(entity, id, payload, hash, seq, deleted, rendered_at)` holds one row per published item. `seq` comes from one sequence. All writes to `device_row` run under one transaction-level advisory lock, so rows commit in `seq` order and a reader never misses a lower number.
- DEVICE-02: Rows are rendered by the code that builds the API list items (`loadTracks`, `loadAlbums`, `loadFilms`, `loadArtists`, `loadPlaylistSummaries`) and by projections assembled from the Browse service's own SQL expressions. `hash` covers the payload in a canonical key order. A row whose hash is unchanged keeps its `seq`.
- DEVICE-03: Statement-level triggers on every contributing table insert `(entity, id)` into `device_dirty`, following the `mark_browse_cache_dirty()` pattern and running statements that join transition tables through `EXECUTE`. A change that affects many rows (tag hidden, merged or re-parented, artist renamed, playlist or album renamed) marks the rows that hold it. A delete marks the deleted ID.
- DEVICE-04: A render task takes dirty marks in bounded batches, renders them, writes changed rows and tombstones, and deletes only the marks it read. A track mark also re-renders the visible tracks that share its title key, because recording groups depend on them. It runs in the five-minute maintenance task and before `changes` answers, within a time budget.
- DEVICE-05: A sweep re-renders every entity in ID order, a bounded number of rows per run, and writes only rows whose hash differs or that no longer exist. It repeats continuously, so a missed trigger is corrected within one sweep. The first sweep builds the feed; until it completes the feed reports `ready: false`.
- DEVICE-06: `GET /api/v1/device/state` returns `{ ready, epoch, seq, minSeq, rowVersion }`. `epoch` changes when the feed is rebuilt from nothing, `rowVersion` when the row shape changes, `minSeq` is the oldest sequence from which tombstones are still held.
- DEVICE-07: `GET /api/v1/device/snapshot?entity=&after=&limit=` returns live rows of one entity in `seq` order, without tombstones. `GET /api/v1/device/changes?since=&limit=` returns rows and tombstones of every entity in `seq` order with `{ rows, seq, hasMore, pending }`; `pending` says dirty marks remain. A `since` below `minSeq`, or another `epoch`, answers `{ reset: true }`. Pages are bounded by row count and by payload bytes.
- DEVICE-08: A device applies a snapshot by reading the state, paging every entity, then reading changes from the sequence in that first state. Rows are upserts keyed by `(entity, id)`, so a row seen twice is harmless.
- DEVICE-09: Tombstones are kept for 90 days. Spotify-sourced values in a row are a cache: they are replaced by sync and never the only copy.
- DEVICE-10: Device sign-in follows local-worker pairing. A signed-in owner creates a one-time pairing code; a device exchanges it for a device token; the server stores only hashes. The token is an API key of kind `device`, sent as `Authorization: Bearer`: it has an API key's access and no more, is listed and revoked with the other keys, and reads the device routes. Routes that accept it answer CORS preflights for the origins in `DEVICE_ALLOWED_ORIGINS` (none by default) without credentials.
- DEVICE-11: Routes are thin, with request and response schemas in `packages/schemas/src/device.ts`. The feed adds no statement to any existing request.
- DEVICE-12: The performance suite budgets a render batch (statements and shared blocks per 100 rows of each entity), a `changes` page, and the trigger cost of a single-row and a bulk write on each trigger table.

Check on a disposable database with the synthetic library: after building the feed, an edit, a tag rename, a tag re-parent, a track merge, a playlist change, a new scrobble and a delete each appear as the expected rows or tombstones with higher sequence numbers, and nothing else changes. A sweep after each finds no difference.

## Stage 2: store package

- DEVICE-20: `packages/library-source` holds the interfaces, the three sources, the sync client, the SQLite schema, the query compiler and the drivers. It depends on `@repo/schemas` only.
- DEVICE-21: SQLite schema: one table per item entity with the payload and indexed columns for archived and the common sorts; `item_text(entity, id, field, value, folded)`, `item_search(entity, id, field, folded)` with an FTS5 trigram index, `item_num(entity, id, field, value)`, `item_sort`; `item_tag(entity, id, level, tag_id)`, `item_artist_tag_key`, `item_credit`; `tag`, `tag_identity`, `tag_ancestor`; `name_play`, `track_name`, `album_play`, `artist_play`; `sync_state`. A schema version change drops and refills the store.
- DEVICE-22: The compiler turns a parsed query into SQL with the service's semantics: filter modes (required ANDed, exclude negated, any and unset in one OR group across fields), case-insensitive equality on folded values, `q` as words that each match some searched field, inclusive ranges with `includeMissing`, the tag filter (the tag, its aliases, its visible descendants; levels and Auto; the artist-tag fallback for albums with fewer than two release tags), the redundant-placeholder rule, creator scope, `limitResults`, archived and edition toggles, `unfilteredCount`, and sorting as primary value, nulls last (except `title desc`), the natural order and the ID.
- DEVICE-23: Listening rules, listening sort and histograms are computed from play times with the service's period arithmetic (UTC calendar months, exclusive end for date periods, "now" taken once per call). Track counts go through scrobbled names; a recording group counts each name once.
- DEVICE-24: Grouped Tracks: matching rows are grouped by the server's recording group key; version count, representative row, group dates and group scrobbles are computed over the matching rows as the service does.
- DEVICE-25: Facets: counts over the whole library in scope, word matching, exact match first, count, then value; tag values counted under each visible ancestor, with `subtags`; the per-field limit rule of each library.
- DEVICE-26: Text order is by code point on folded values, matching a PostgreSQL database with the `C.UTF-8` collation. An installation with a language collation orders punctuation, case and accents differently on the device; this is a stated limitation.
- DEVICE-27: The compiler decides support before running anything. A query it does not fully support returns `{ served: false, reason }`. See Known holes.
- DEVICE-28: The sync client applies each snapshot page and each change page in one transaction, including the derived tables and the cursor, so a reader sees the previous complete state or the next. It handles `reset`, a changed `epoch` or `rowVersion` by refilling, and reports progress.
- DEVICE-29: Drivers: `better-sqlite3` for Node and tests, `@sqlite.org/sqlite-wasm` on OPFS (`opfs-sahpool`) for a browser Worker. A driver is the only host-specific code.
- DEVICE-30: `clear()` removes every row and the cursor. Sign-out calls it.
- DEVICE-31: The store holds no credentials.
- DEVICE-32: Parity suite: on a disposable PostgreSQL database created with the `C.UTF-8` collation and seeded with a synthetic library, build the feed, sync it into SQLite, and for a generated matrix of queries per library compare the device answer with the service answer: the same IDs in the same order, the same items, totals and facet rows. The matrix covers every filter field in every mode, combined filters, every range field with and without `includeMissing`, every sort in both directions with ties, deep pages, `limitResults`, creator scope, tag aliases, hidden tags, descendants and levels, placeholders, grouping, rolling and dated listening rules, positions and histograms. It then applies edits, re-syncs and compares again. It runs in CI.
- DEVICE-33: A query that falls through is asserted to fall through; the suite fails if a hole is served.

## Stage 3: web client

- DEVICE-40: `fetchApiData` asks the library source first for `GET` requests when the device store is on and ready. A served read returns the data through the caller's schema as an API read does; anything else, any error in the store, and every non-`GET` request go to the API unchanged. With the store off, `fetchApiData` behaves exactly as before.
- DEVICE-41: The store runs in one Web Worker per browser profile (a `SharedWorker` where available, with a lock so one tab syncs). The main thread sends a read and an abort; an aborted read rejects as a fetch does.
- DEVICE-42: The setting is on the User page, saved in this browser, off by default, built from the existing setting row. It shows the state: off, filling with progress, ready with the time of the last sync, or failed with the reason and Retry. Turning it off deletes the local copy.
- DEVICE-43: Sync runs when the setting is turned on, at start, every five minutes while a tab is visible, when the shell's Refresh is used, and after every successful write through `fetchApiData`. A write waits for the following sync before the affected queries are invalidated, so the refetch reads the new row; if that sync fails or times out the affected reads go to the API until the next successful sync.
- DEVICE-44: Until the first fill completes, and whenever the store is unavailable (no OPFS, no Worker, storage denied, quota), every read goes to the API.
- DEVICE-45: Sign-out and a 401 from the feed delete the local copy before navigation.
- DEVICE-46: Browse performance samples say which source answered, so local reads are not counted as API timings.
- DEVICE-47: No new visual element. A sync or offline indicator outside the User page needs concepts and the owner's choice first.

Check in a browser at desktop and phone widths on the preview: with the setting on and filled, Tracks, Albums, Films, Artists and Playlists open, filter, search, sort and page with no API request for served reads, and the rows and counts match the same pages with the setting off. An edit appears after its sync. Sign-out leaves no local data.

## Known holes

These reads go to the API. Each is asserted by DEVICE-33.

| Read                                                                                                                              | Reason                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AI search                                                                                                                         | Runs on the server.                                                                      |
| Any catalog scope other than the library (`libraryScope`, discovery)                                                              | The device holds library rows only.                                                      |
| Subscriptions and Mixes                                                                                                           | Search uses PostgreSQL full-text ranking and stemming; the largest table; not requested. |
| Grouped Tracks inside a creator scope                                                                                             | Groups are formed from that artist's tracks only, not the library-wide key.              |
| A Provider filter on Tracks or Artists                                                                                            | The rows then carry provider links chosen per request.                                   |
| Detail pages and the lists owned by a detail (playlist entries, collection entries, album track lists, People, Collections, Tags) | Not in this version.                                                                     |
| Metadata selection, Matches, Jobs, Providers, Imports                                                                             | Server state and evidence.                                                               |
| Fields added by a private plugin whose values are not in the row                                                                  | Checked per query: an unknown field falls through.                                       |

This table is updated when a hole is filled or found.
