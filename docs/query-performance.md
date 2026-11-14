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
| Default track and film ordering           | Added-date and release-date indexes matching descending dates, missing dates last and ascending ID ties    |
| Track album-list matching                 | Album ID plus the exact normalized-title expression                                                        |
| Album listening date windows              | Partial `(listened_at, album_media_item_id)` index for linked scrobbles                                    |
| Subscription text search                  | Existing full-text GIN index on `subscription_item.search`                                                 |
| Subscription title and source suggestions | Trigram indexes on item and source titles                                                                  |
| Subscription duration ranges              | Index on `nullif(duration_sec, 0)`, matching the query's treatment of unknown durations                    |
| Job history and batch lookup              | Descending creation date and ID, plus the batch ID expression                                              |

Indexes are targeted at stored columns and query expressions. Generic JSON metadata expansion and broad aggregate reports still need to process matching rows. Very short substring searches and common words can match much of a library; a trigram index is most useful when the search contains selective runs of at least three characters. PostgreSQL can choose a sequential scan when that is cheaper.

## Verification

The browse-search and query-indexes integration tests create disposable databases and synthetic libraries. They cover query results, substring escaping, cross-field word matching and PostgreSQL query plans. They do not read or scrape a real library. Run them from the workspace root:

```sh
corepack pnpm --filter @repo/server exec vitest run --config vitest.integration.config.ts integration/browse-search.integration.ts integration/query-indexes.integration.ts
```

On a local synthetic fixture of 20,000 tracks linked to 1,000 albums, a selective title search plus autocomplete took approximately 8.5 seconds before these changes and 83 milliseconds afterwards. This measures the service calls with fixture setup excluded, not browser or network latency. Plan assertions check that unrelated album-track matching is not executed; tests do not depend on a machine-specific millisecond threshold.

Uncached broad autocomplete on that fixture took approximately 0.5–0.6 seconds for empty input, one character and match-status labels. Those requests still count values across the library; the selective-search improvement is not a latency guarantee for every filter or library size.

## Upgrading

Migration `0028_library_search_indexes` enables `pg_trgm` and builds the search and lookup indexes. The database role needs permission to install this extension. It uses the existing transactional migration runner; index construction can block writes while it runs. Follow the normal [upgrade procedure](getting-started.md#upgrading-and-backing-up): back up, stop application writers, apply migrations, then start the updated application. No provider refresh or library reimport is needed.
