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
| Job history and batch lookup              | Descending creation date and ID, plus the batch ID expression                                              |

Indexes are targeted at stored columns and query expressions. Generic JSON metadata expansion and broad aggregate reports still need to process matching rows. Very short substring searches and common words can match much of a library; a trigram index is most useful when the search contains selective runs of at least three characters. PostgreSQL can choose a sequential scan when that is cheaper.

## Browse pagination

Albums, Films, Tracks, Artists and Subscriptions expose `/api/v1/{library}/browse-page` for rows and `/api/v1/{library}/browse-count` for the exact filtered total. The first returns `items`, `page`, `size` and `hasMore`. It reads one extra result to detect continuation and respects the result cap where the library supports one. The second returns `totalCount` from the same membership predicate and reuses the short-lived, database-versioned cache. The original paginated routes still return rows and totals together.

`GET /api/v1/tracks/positions` returns the tracks at up to 50 given positions of a track query's order. It numbers the ordered rows once, as far as the deepest position asked for, and hydrates only the rows at those positions. Shuffled playback uses it because a page per random position orders the whole result again for every track; on a large list one such read costs about as much as a single deep page.

Browse can display the first page and expand the scroll area when the total arrives. A first page with `hasMore: false` already gives the total. Later pages skip counting, including when a requested page is empty. A failed count can be retried while the loaded page remains available.

Artist metadata selection also uses separate `/api/v1/artists/metadata/browse-page` and `/browse-count` endpoints. Artists selects matching IDs before loading the page's membership counts, playlist names, artwork and provider profiles. Search, filter modes, ranges, freshness and result caps share one membership predicate across both surfaces. Profile and playlist hydration must stay bounded to the returned IDs. `artist-browse.integration.ts` checks this with a disposable synthetic library; it does not require a live enrichment run.

The film collection directory follows the same split through `/api/v1/collections/browse-page` and `/browse-count`. Name search, film-only membership, ordering and the page limit are evaluated in SQL. The directory's hidden-by-default source column requests `includeSources=true` only when shown; provenance expansion is restricted to returned collections, never the entire directory or its count query. Arbitrary plugin source readers are not an indexed directory sort/filter field. Collection membership IDs travel with film rows so opening a collection requires no directory lookup.

On a disposable fixture of 20,000 synthetic tracks, the exact count for a required Album track list filter took about 123 ms, while the first page and its metadata took about 10 ms. On 50,000 synthetic subscription items, the original first page with a window count took about 22 ms. Executing the page and exact count independently took about 0.3 ms and 3.8 ms respectively. These are medians from five warm database measurements, excluding HTTP and browser rendering.

## Artist and album filtering

Artist freshness queries probe the latest relevant job through partial expression indexes on `scrape_job`. The artist task predicate and timestamp null ordering must match those indexes. Current profile state is read through its artist/provider key. Metadata hydration looks up only the displayed artists and requested providers; never join every historical job to every visible artist.

Album tag filtering and ordering calculate canonical artist tags and sparse release-tag fallback as sets. Exact playlist chips join indexed membership IDs. Tag hydration remains bounded to the returned media IDs. These paths share the same fallback and alias rules as displayed tags.

Autocomplete starts when search receives focus or text, rather than running a broad facet aggregation for every page mount. It retains debounce and request cancellation. Broad suggestions still count values across the matching library.

On disposable synthetic fixtures, the artist never-attempted page query fell from approximately 5.8 seconds to 33 milliseconds. Album tag ordering fell from approximately 2.2 seconds to 118 milliseconds, and a two-word album search fell from approximately 953 to 173 milliseconds. These are local database/service measurements, not production HTTP latency guarantees. The performance integration suites assert query results and indexed/bounded plans rather than fixed machine-specific timings.

Filtered artist bulk selection inserts matching IDs directly into an owner-bound, one-hour snapshot. It uses the Browse membership predicate and result cap without fetching profiles or all table pages. Dispatch reads that snapshot in bounded batches, rechecks freshness and active jobs, and preserves provider concurrency and cooldowns.

## Verification

The browse-search and query-indexes integration tests create disposable databases and synthetic libraries. They cover query results, substring escaping, cross-field word matching and PostgreSQL query plans. They do not read or scrape a real library. Run them from the workspace root:

```sh
corepack pnpm --filter @repo/server exec vitest run --config vitest.integration.config.ts integration/browse-search.integration.ts integration/query-indexes.integration.ts
```

On a local synthetic fixture of 20,000 tracks linked to 1,000 albums, a selective title search plus autocomplete took approximately 8.5 seconds before these changes and 83 milliseconds afterwards. This measures the service calls with fixture setup excluded, not browser or network latency. Plan assertions check that a selective search reads album positions only for matching tracks and that default Track ordering can use its Added-date index. Tests do not depend on a machine-specific millisecond threshold.

Uncached broad autocomplete on that fixture took approximately 0.5–0.6 seconds for empty input, one character and match-status labels. Those requests still count values across the library; the selective-search improvement is not a latency guarantee for every filter or library size.

## Upgrading

Migration `0028_library_search_indexes` enables `pg_trgm` and builds the search and lookup indexes. The database role needs permission to install this extension. It uses the existing transactional migration runner; index construction can block writes while it runs. Follow the normal [upgrade procedure](getting-started.md#upgrading-and-backing-up): back up, stop application writers, apply migrations, then start the updated application. No provider refresh or library reimport is needed.

Migrations `0031_artist_filter_indexes_and_selection` and `0032_artist_browse_name_index` add the artist job lookup indexes, name ordering index and temporary selection tables. Existing tables can have those three indexes built with `CREATE INDEX CONCURRENTLY` before applying the migrations; use the exact definitions, verify `pg_index.indisvalid`, and run each concurrent statement outside a transaction. The migration statements use `IF NOT EXISTS` to accept these prebuilt indexes. Do not treat an existing invalid or differently defined index as ready. Otherwise follow the normal stopped-writer migration procedure. No re-scrape is required.
