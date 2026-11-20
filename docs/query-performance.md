# Library query performance

Library search keeps case-insensitive substring matching: every word must match a text value, and different words can match different fields. Search and autocomplete read stored library rows only.

## Queries and indexes

Search finds matching media IDs through field-specific queries. Titles, summaries, artists, playlists and tags are searched before their memberships are joined. This lets PostgreSQL use `pg_trgm` GIN indexes instead of constructing related JSON values for every library item. The same field sources serve autocomplete, preserving whole-library counts and per-field limits. Track source and match-status labels use separate branches so an unrelated search word does not calculate playback matches for every track.

| Query                                     | Index coverage                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Title and summary substrings              | Trigram indexes on `media_item.title` and `summary`                                                        |
| Artist and credit suggestions             | Trigram artist names and `(artist_id, role, media_item_id)` membership lookup                              |
| Playlist and collection suggestions       | Trigram playlist names; existing playlist membership indexes                                               |
| Track album names                         | Trigram stored album names and media titles                                                                |
| Tags and original labels                  | Trigram display names, normalized names, identities and occurrence labels; existing tag membership indexes |
| Title ordering                            | Existing `(media_type, lower(title), id)` index, using the column directly                                 |
| Default track and film ordering           | Added-date index supplies the track order before album ties; release-date index supports film date and ID  |
| Track album-list matching                 | Album ID plus the exact normalized-title expression                                                        |
| Album listening date windows              | Partial `(listened_at, album_media_item_id)` index for linked scrobbles                                    |
| Subscription text search                  | Existing full-text GIN index on `subscription_item.search`                                                 |
| Subscription title and source suggestions | Trigram indexes on item and source titles                                                                  |
| Subscription duration ranges              | Index on `nullif(duration_sec, 0)`, matching the query's treatment of unknown durations                    |
| Artist freshness and latest attempt       | Partial provider/artist-ID/descending-time indexes for artist enrichment jobs                              |
| Artist name ordering                      | B-tree on `lower(coalesce(sort_name, name)), id`                                                           |
| Artist scrobble ordering and ranges       | Stored `artist.scrobble_count` with a B-tree on `scrobble_count DESC NULLS LAST, id`                       |
| Job history and batch lookup              | Descending creation date and ID, plus the batch ID expression                                              |

Indexes are targeted at stored columns and query expressions. Generic JSON metadata expansion and broad aggregate reports still need to process matching rows. Very short substring searches and common words can match much of a library; a trigram index is most useful when the search contains selective runs of at least three characters. PostgreSQL can choose a sequential scan when that is cheaper.

## Browse pagination

Albums, Films, Tracks, Artists and Subscriptions expose `/api/v1/{library}/browse-page` for rows and `/api/v1/{library}/browse-count` for the exact filtered total. The first returns `items`, `page`, `size` and `hasMore`. It reads one extra result to detect continuation and respects the result cap where the library supports one. The second returns `totalCount` from the same membership predicate and reuses the short-lived, database-versioned cache. It also returns `unfilteredCount`, the library's total without search, filters or ranges, which the toolbar shows as `N of M` while a filter is active. The original paginated routes still return rows and totals together.

`GET /api/v1/tracks/positions` returns the tracks at up to 50 given positions of a track query's order. It numbers the ordered rows once, as far as the deepest position asked for, and hydrates only the rows at those positions. Shuffled playback uses it because a page per random position orders the whole result again for every track; on a large list one such read costs about as much as a single deep page.

Browse can display the first page and expand the scroll area when the total arrives. A first page with `hasMore: false` already gives the total. Later pages skip counting, including when a requested page is empty. A failed count can be retried while the loaded page remains available.

Grouped Tracks Browse checks full titles, artist credits and durations only for tracks that could share a recording. Tracks without a possible match use their stored listening totals directly. Sorting by listening or Added first identifies rows within the requested rank, including ties. The usual release ordering then resolves those ties. Expanding one recording reads candidates for its title. The server caches a bounded page of grouped IDs and listening totals and checks the database snapshot before reuse, including after another process imports or edits a track.

On a disposable fixture of 63,000 tracks, fetching the first grouped page sorted by scrobbles, including track details, took about 400 ms compared with 2.16 seconds before the optimization. The uncached grouped count took 250 ms compared with 1.02 seconds. These are service timings on synthetic data.

Artist metadata selection also uses separate `/api/v1/artists/metadata/browse-page` and `/browse-count` endpoints. Artists selects matching IDs before loading the page's membership counts, playlist names, artwork and provider profiles. Search, filter modes, ranges, freshness and result caps share one membership predicate across both surfaces. Profile and playlist hydration must stay bounded to the returned IDs. `artist-browse.integration.ts` checks this with a disposable synthetic library; it does not require a live enrichment run.

The film collection directory follows the same split through `/api/v1/collections/browse-page` and `/browse-count`. Name search, film-only membership, ordering and the page limit are evaluated in SQL. The directory's hidden-by-default source column requests `includeSources=true` only when shown; provenance expansion is restricted to returned collections, never the entire directory or its count query. Arbitrary plugin source readers are not an indexed directory sort/filter field. Collection membership IDs travel with film rows so opening a collection requires no directory lookup.

On a disposable fixture of 20,000 synthetic tracks, the exact count for a required Album track list filter took about 123 ms, while the first page and its metadata took about 10 ms. On 50,000 synthetic subscription items, the original first page with a window count took about 22 ms. Executing the page and exact count independently took about 0.3 ms and 3.8 ms respectively. These are medians from five warm database measurements, excluding HTTP and browser rendering.

## Artist and album filtering

Artist freshness queries probe the latest relevant job through partial expression indexes on `scrape_job`. The artist task predicate and timestamp null ordering must match those indexes. Current profile state is read through its artist/provider key. Metadata hydration looks up only the displayed artists and requested providers; never join every historical job to every visible artist.

Artist scrobble ordering and ranges read the stored `artist.scrobble_count`. Counting linked scrobbles per request joined every scrobble to its credits and removed duplicates across the album and track links, which took seconds on a long listening history. `refreshArtistListeningTotals` recounts after links change: it groups scrobbles by scrobbled name and album link first, because every scrobble in a group has the same links, and writes only changed artists. The page's sparkline covers the whole listening history, so it reads every scrobble of the displayed artists, grouped by month in one statement that also reads the date of the earliest stored scrobble. That date steps through the listeners on the listener and time index and takes each one's first scrobble; a plain minimum over the table reads every scrobble. On a disposable fixture of 315,000 synthetic scrobbles that all belong to the displayed artists, the worst case, the date took about 3 ms instead of 26 to 80 ms, and the sparkline read about 600 ms against about 205 ms for the earlier twelve-month read. A page of artists with few scrobbles reads correspondingly few rows.

Album tag filtering and ordering calculate canonical artist tags and sparse release-tag fallback as sets. Exact playlist chips join indexed membership IDs. Tag hydration remains bounded to the returned media IDs. These paths share the same fallback and alias rules as displayed tags.

Autocomplete starts when search receives focus or text, rather than running a broad facet aggregation for every page mount. It retains debounce and request cancellation. Broad suggestions still count values across the matching library.

On disposable synthetic fixtures, the artist never-attempted page query fell from approximately 5.8 seconds to 33 milliseconds. Album tag ordering fell from approximately 2.2 seconds to 118 milliseconds, and a two-word album search fell from approximately 953 to 173 milliseconds. These are local database/service measurements, not production HTTP latency guarantees. The performance integration suites assert query results and indexed/bounded plans rather than fixed machine-specific timings.

Filtered artist bulk selection inserts matching IDs directly into an owner-bound, one-hour snapshot. It uses the Browse membership predicate and result cap without fetching profiles or all table pages. Dispatch reads that snapshot in bounded batches, rechecks freshness and active jobs, and preserves provider concurrency and cooldowns.

## Combined filters and large directories

An exact Artist tags chip resolves the requested tag, its visible descendants and the raw labels that can map to them. A GIN index finds matching profile snapshots by normalized label. Only the current snapshot for each artist and provider contributes credits. An explicit hidden tag still matches, and edits to aliases and parent tags take effect on the next read. Track pages load artist tags for their returned IDs together.

A standalone zero-play or at-least-one-play rule uses an existence check. Multiple rules and sorts that need exact counts share one aggregate over the listening history. Grouped Tracks use indexed normalized titles for small candidate sets and check every visible peer of those titles before admitting a recording group. A page resolves the release order of every group tied at its primary sort boundary. Broad grouped reads still process the matching recordings.

On a disposable PostgreSQL fixture with 20,000 tracks, 9,000 current artist profiles and 240,000 recent scrobbles, a required playlist, artist tag and rolling year with zero plays selected 32 tracks. Median database timings from three warm executions follow.

| Query                  | Before | After |
| ---------------------- | -----: | ----: |
| Track page IDs         | 331 ms | 16 ms |
| Exact track count      | 231 ms | 16 ms |
| Grouped track page IDs | 330 ms | 27 ms |
| Exact grouped count    | 306 ms | 27 ms |

The table measures database execution for IDs and counts. Loading full track details separately took 11 ms for 50 tracks (previously 96 ms) and 33 ms for 250 tracks (previously 1.1 seconds), using the median of five warm service calls. HTTP and browser rendering add to those times. The unfiltered grouped play-count measurements below use a separate fixture.

Jobs counts group matching batch IDs without sorting or loading individual job details. The page limits individual jobs before combining them with batch summaries. Subscription and Mixes compatibility pages count narrow rows and load page details within the same SQL statement, including when a page lies beyond the last match. Source directories count stored items through each source's indexed membership. In separate synthetic fixtures, the Jobs first page took 15 ms for 300,000 jobs (previously 229 ms), and a subscription page with its exact total took 32 ms for 250,000 items (previously 306 ms). These are medians of five warm database measurements.

## Sorts, ranges and autocomplete

Titles are required, so descending title order can scan the title index backwards. On 20,000 synthetic tracks the first 50 IDs took 0.8 ms, down from 192 ms. A one-day Added range on 65,000 tracks counted 25 matches in 0.13 ms, down from 26 ms. Film and Album Released ranges also use the stored timestamp for whole-millisecond bounds. Fractional bounds retain their exact precision. When a result cap is the only filter, one count supplies both the displayed total and the uncapped total.

Tracks and Albums resolve tag labels and their visible ancestors before joining media memberships. On 60,000 tracks, 6,000 albums and 60,000 current artist profiles, a one-character autocomplete request fell from 2.02 to 1.22 seconds for Tracks and from 493 to 328 ms for Albums. A selective search took 333 ms and 113 ms respectively. Albums and custom Track scopes still aggregate live memberships. Default Track autocomplete now reads the stored vocabulary described below.

Subscription and Mix autocomplete count scalar values once per item and collapse repeated array labels within each item on broad searches. On a synthetic fixture with 160,000 subscription and mix items, empty autocomplete took 180 ms for Subscriptions and 256 ms for Mixes, down from 584 ms and 683 ms. Artist suggestions collapse repeated profile labels and playlist memberships before counting.

### Grouped play counts

Unfiltered grouped Tracks sorted by lifetime scrobbles share two stored recording orders, one per direction. Each order includes the release tie-breaks. A page, an exact total and an arbitrary position can read the same published ranks. Filtered groups and period-specific listening sorts continue to use their own query predicates.

On a disposable fixture of 64,000 tracks and 252,000 scrobbles, the first descending page took 2.08 seconds including publication, compared with 2.04 seconds for a live read. Further descending pages took 2.2 ms, down from 1.87 seconds. Ascending pages took 1.4 ms, five arbitrary positions took 1.7 ms and a total took 0.7 ms. These timings measure the service before track detail hydration.

### Tracks autocomplete

Default Tracks autocomplete stores the distinct values and exact counts for each of its ten text fields, ranked by count and display value. Suggestions on focus can read the first ranks for each field. Typed suggestions retain exact-value priority, multiword substring matching and per-field limits. A cold selective request can still search indexed live rows. A broad request can build the vocabulary for subsequent searches from any Worker.

On 60,000 synthetic tracks, a fresh application process served empty suggestions in 3 ms with a current vocabulary. One-character, common-word and selective searches took 23 ms, 16 ms and 13 ms of database time, down from 1,143 ms, 629 ms and 373 ms on the same fixture. Building on the first request took 1.22 seconds, compared with 1.18 seconds live. The ranked values and index occupied about 9 MB on this fixture.

Both stored results use transactionally maintained invalidation markers. Relevant source writes mark the cache dirty in the same transaction. Readers use a single snapshot to check freshness and select results. A rebuild publishes atomically and can clear only the committed markers it observed. Reads during rebuilds and cooldowns can use the live query.

### Deep Track pages

Track page jumps and position requests preserve their absolute ranks, including ties that cross either page boundary. For deep sorts by Title, Added, Artist, Album, Playlist, tags, Released, Duration or ascending lifetime scrobbles, PostgreSQL finds the range of primary sort keys containing the requested positions before looking up release credits and track numbers. On the 20,000-track fixture used for the combined-filter measurements, a title jump to page 390 at 50 tracks per page took 86 ms, down from 239 ms. The first page took about 1 ms both ways. On a separate 20,000-track fixture, a deep Released page fell from 101 ms to 37 ms and Duration fell from 99 ms to 28 ms. Early pages keep the direct ordered limit. Large tied groups and the number of primary keys preceding the page still affect the cost. Rolling listening windows also move between requests. Exact count cache keys include the window boundaries.

## Verification

The browse-search and query-indexes integration tests create disposable databases and synthetic libraries. They cover query results, substring escaping, cross-field word matching and PostgreSQL query plans. They do not read or scrape a real library. Run them from the workspace root:

```sh
corepack pnpm --filter @repo/server exec vitest run --config vitest.integration.config.ts integration/browse-search.integration.ts integration/query-indexes.integration.ts
```

On a local synthetic fixture of 20,000 tracks linked to 1,000 albums, a selective title search plus autocomplete took approximately 8.5 seconds before these changes and 83 milliseconds afterwards. This measures the service calls with fixture setup excluded, not browser or network latency. Plan assertions check that a selective search reads album positions only for matching tracks and that default Track ordering can use its Added-date index. Tests do not depend on a machine-specific millisecond threshold.

The live fallback for broad autocomplete on that fixture took approximately 0.5–0.6 seconds for empty input, one character and match-status labels. Those requests still count values across the library; the selective-search improvement is not a latency guarantee for every filter or library size.

## Upgrading

Migration `0028_library_search_indexes` enables `pg_trgm` and builds the search and lookup indexes. The database role needs permission to install this extension. It uses the existing transactional migration runner; index construction can block writes while it runs. Follow the normal [upgrade procedure](getting-started.md#upgrading-and-backing-up): back up, stop application writers, apply migrations, then start the updated application. No provider refresh or library reimport is needed.

Migrations `0031_artist_filter_indexes_and_selection` and `0032_artist_browse_name_index` add the artist job lookup indexes, name ordering index and temporary selection tables. Existing tables can have those three indexes built with `CREATE INDEX CONCURRENTLY` before applying the migrations; use the exact definitions, verify `pg_index.indisvalid`, and run each concurrent statement outside a transaction. The migration statements use `IF NOT EXISTS` to accept these prebuilt indexes. Do not treat an existing invalid or differently defined index as ready. Otherwise follow the normal stopped-writer migration procedure. No re-scrape is required.

Migration `0034_artist_scrobble_count` adds `artist.scrobble_count`, fills it from the stored scrobble links and builds its ordering index. It needs no re-scrape or relink.

Migration `0041_browse_query_indexes` builds the normalized artist-profile tag index and the media-type/normalized-title index, then updates planner statistics. Follow the standard upgrade procedure before starting this version. Existing snapshots and tracks supply all indexed data.

Migrations `0042_grouped_recording_browse_order` and `0043_track_facet_vocabulary` create the derived tables and their invalidation triggers. They populate on demand. A separate reader role can continue to query the live data. A runtime role that builds caches needs read access to the derived tables, insert and delete on the rank and value tables, insert and update on the state tables, and delete and update on the invalidation tables. The source write triggers run with the migration owner's privileges. Existing library data supplies both caches.
