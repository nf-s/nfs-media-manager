# Album provider contracts

The current album adapters validate responses at the provider boundary and return shared media contracts. Tests use synthetic responses through mocked requests. Private integrations are loaded separately through the plugin SDK.

## Supported adapters

| Provider    | Behavior                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| MusicBrainz | Uses an owned release-group ID first, then bounded barcode/name searches. Retains relations without changing another provider's identifiers. |
| Last.fm     | Looks up the album by album MBID, corrected URL, or canonical names. Ranked album tags are opt-in. Release-group IDs are not album MBIDs.    |
| Discogs     | Uses an owned corrected ID or bounded native barcode/master/release searches. A master lookup fetches its main release only.                 |
| Spotify     | Supports album metadata and the separately authorized [saved-album import](spotify-album-imports.md). Audio-feature acquisition is excluded. |
| Serply      | Looks up indexed Rate Your Music results. Search-derived ratings can lag the source.                                                         |

Google Custom Search is retired. Historical ratings and source links remain importable under the existing provider ID; see [retirement behavior](google-search-retirement.md). CSV and legacy JSON files use the current [import workflows](importing.md). Archived scrapers, cleaners, playlist-sync helpers and prototypes are no longer included.

## Request safety

| Provider    | Concurrency / minimum spacing | Maximum calls per album                               |
| ----------- | ----------------------------- | ----------------------------------------------------- |
| MusicBrainz | 1 / 1000 ms                   | 1 direct; 2 name or barcode; 3 barcode miss then name |
| Last.fm     | 1 / 200 ms                    | 1 normally; 2 with `options.includeTopTags: true`     |
| Discogs     | 1 / 1050 ms                   | 1 release; 2 master; at most 4 with searches          |

Every HTTP request, including searches, uses `context.request`. There are no client libraries, direct fetches, hidden retries, pagination walks, quota-discovery calls, or network activity on module import. The persistent server gate owns spacing, timeouts, cooldowns and shared budgets. Runtime account access is not proven by these offline tests. The MusicBrainz, Last.fm and Discogs plugins do not claim a connection-test hook; no credentials are tested on import. The separate [Last.fm scrobble sync](lastfm-scrobbles.md) runs as account-level Last.fm jobs outside the plugin; it pages `user.getRecentTracks` through the same Last.fm gate and repeats a page after a temporary failure. Last.fm sets `errorBackoffMs: 5000` and `failureCooldownMs: 0`: an HTTP 400 or 5xx delays the next request by five seconds without a provider cooldown, for album jobs as well.

An existing owned reference is validated before any search. Invalid IDs fail immediately, rather than silently searching for a different album. Search windows are at most five MusicBrainz/Discogs candidates. Ambiguous matches or responses reporting more candidates than the bounded window require a direct corrected ID and are not marked benign. Validated searches with no matching item throw `ProviderItemNotFoundError`; malformed bodies, HTTP failures and access denial are not benign misses. Transport/gateway errors retain their type and retry time. Last.fm error 29 uses `ProviderRequestError('rate-limit')`, without retries, with at least a 60-second retry time extended by Retry-After. Existing shared request-gate quota classification remains unchanged by Google retirement; it no longer implies an active Google adapter.

## Provider Workspace

Providers lists integrations for the selected library. **Activity** contains request history, active cooldown controls and past error reviews. **Credentials** groups credential fields, configuration status, environment fallbacks and supported remote checks. **Settings** contains editable request budgets, effective request limits, lookup rules and integration details. Switching sections or providers only reads stored configuration and history; saving credentials, changing budgets, checking credentials and clearing cooldowns remain explicit actions.

## Integration Contract

`MediaPluginScrapeContext.media` supplies optional `{ title, artists, releaseDate? }`. Name lookup requires a nonblank title and artist; a direct reference does not require names. `supportsNameLookup: true` permits queue eligibility by names without manufacturing an ID. These are parent-owned SDK/server contracts.

All persisted namespaces are preserved: `musicbrainz:release-group`, `lastfm:mbid`, `discogs:master` / `discogs:release`, and the separate Spotify adapter's `spotify:album` / `upc`. The server annotates input references with `metadata.sourceProvider`; plugins consume only their own IDs. UPC/EAN is the sole cross-provider numeric identifier accepted here (8-14 digits). Corrected references must precede stale references in context, including corrections switching Discogs master/release or Last.fm MBID/URL lookup. Last.fm supports optional `url` references. Historical Google `rym-url` / `metacritic-url` references retain their existing namespace; they are not removed or reassigned to another provider.

Plugins return candidates in `mediaPatch`, not instructions to overwrite user-curated identity. Parent enrichment must preserve canonical titles/artists, manual overrides and imported Added dates. Tags retain `source`, `rawName` and source IDs when supplied. MusicBrainz genres and general tags remain distinct; Discogs styles remain `style`; Last.fm freeform tags remain `general`, not automatically genres. The tag-normalization workstream controls canonical merging.

Shared browse keys: `popularityLastFm`, `scrobbles`, `ratingDiscogsValue`, `ratingDiscogsVotes`, `popularityDiscogs`, `ratingRymValue`, `ratingRymVotes`, `ratingMetacriticValue`, `ratingMetacriticVotes`. Last.fm global plays use `plugin.lastfm.playcount`. Zero values are retained. Track durations are seconds; native ordering is retained, while richer native positions stay in raw snapshots.

Discogs refreshed rating/popularity covers **one release only**, not the old top-ten weighted rating or all-version popularity sum. `plugin.discogs.ratingScope` records which release. Historic aggregate snapshots are not rewritten by the plugin. Raw master and main-release bodies are both retained. This intentionally avoids the old fanout and makes the changed scope inspectable.

Google snapshots, current state, imported ratings, links and tag provenance remain available as historical data. The legacy importer still translates `rymGoogle` and `metacriticGoogle` under `google-custom-search`; retiring scraping does not rewrite those records. See [Google retirement and preservation](google-search-retirement.md).

## Serply (Rate Your Music)

`serply` retrieves indexed Google results through `GET https://api.serply.io/v1/search/`. Configure its `apiKey` in Providers → Credentials; `SERPLY_API_KEY` is an optional environment fallback. It appears in the existing album metadata job and refresh workflows. Requests use the persistent gate, up to two concurrent requests, 250 ms between starts and optional configurable budgets. No request fetches RYM directly.

Serply uses a 120-second request timeout. Account for gate waits and processing time as well as HTTP time within the job lease.

The gate settings are application limits, not account entitlements. Provider budgets and HTTP 429 cooldowns still apply. See [Serply authentication](https://www.serply.io/docs/guides/authentication).

The adapter permits at most five distinct searches normally. Only when removing a recognized OST/DJ Mix role suffix changes the cleaned search title (`queryTitle !== cleanTitle`) does the ceiling increase to six, with an additional simplified natural-language query. The original four full-title, release-path, quoted artist/title and natural-language queries remain intact. An owned, matched or legacy-hint release URL inserts a prioritized `site:<release-url>` query within the applicable ceiling. These are maximums, not required call counts: duplicate/exhausted queries and a selected release with both a rating and explicit description genres stop the loop early. HTTP/service failures propagate rather than triggering fallback searches. Matching guards, two-request concurrency and 250 ms start spacing remain unchanged.

Serply-owned references constrain candidates to the normalized release URL family; invalid owned references fail before searching. Only an explicit `rym-url` override marked `metadata.manualOverride: true` is authoritative over conflicting library identity/year metadata. Its exact URL-family constraint remains enforced, and provenance records the manual reference, source year and identity/year conflicts. The manual URL supplies identity evidence, not a rating: usable indexed fields are still required. Ordinary saved references do not gain this conflict bypass. Explicit edition headers such as `(Album; Label)` and individual-review scores remain excluded even for manual overrides.

Historical Google RYM URLs are search hints, not constraints on new matching evidence. For Serply albums without any existing `rym-url` (including overrides), the helper reads at most eight media-scoped links from `google-custom-search` or `legacy-browser`, validates/deduplicates them and normalizes review/list child paths. Returned hints remain non-primary, foreign-owned and context-only (`searchHint: true`); the helper performs no database writes or ownership promotion. Invalid hints are ignored.

Without an explicit manual override, identity checks corroborate artist/title paths with indexed titles and descriptions. Normalization folds accents, apostrophes within words, `&`/`and`, and complete comma/underscore thousands groups; it does not concatenate arbitrary numbers or change date tokens. Displayed `w/` abbreviations require corroborating display/path evidence. Numeric artist or release suffixes require matching title/artist evidence and remain distinct stored identities. Contradictory identities are rejected.

Bounded identity exceptions require an exact indexed release date and corroborating release-kind/path evidence. Root-release bilingual matching uses explicit non-Latin names with bracketed Latin equivalents in the same result, consistent title/description evidence and native-script slugs. Supported anchored headers include `<title> by <artist> - RYM` and `By <native artist> - <Latin title> - Rate Your Music`. A Latin-only title must match the complete explicit native `[Latin]` pair in that result's description; the artist remains native or fully bilingual. There is no alias guessing, cross-result translation or relaxed date matching. Combined/featured credits and DJ Mix title composition have separate corroborated rules. Recognized soundtrack-role suffixes require explicit Soundtrack or Film Score evidence (or soundtrack-chart evidence), not merely classical music. Edition and role-label exclusions remain unchanged.

Review URLs are not automatically classified as albums. Their release kind comes from a matching owned release reference or corroborated title/description identity; unresolved reviews retain their review identity rather than inventing an album URL. Conflicting kinds and song/music-video reviews are rejected. Singles require an owned single reference. Review/list pages can supply explicit aggregate rating/count pairs, never structured personal-review ratings.

Only recognized trailing edition labels are removed for lookup: deluxe (including `Deluxe Version`), expanded, anniversary, special/collector's edition and remaster forms. Supported compound labels are narrowly anchored, including ordinal anniversary analogue-remaster editions and `Anniversary Edition / Remastered YYYY`; arbitrary slash lists, live/remix labels and meaningful parentheticals remain. Trailing brackets are checked before the final dash suffix, preserving interior dashes and date ranges; stripping never produces an empty title. The first query retains the full input title. An earlier original-release year is allowed for a cleaned edition title only when both path and indexed title corroborate it. Other explicit year conflicts remain rejected unless an explicit manual override applies.

To use an underlying album rather than a streaming edition, review the release identity. For exceptions beyond the automatic edition rules, use an explicit observed RYM reference supported by release-group, edition-list or tracklist evidence. Preserve the library's title, artist, release date and tracklist, and retain the source URL and edition differences in provenance and the override audit note. Different track segmentation or an abridged compilation can qualify when the underlying work is established; unrelated DJ mixes, remixes, live recordings and similarly named compilations must not be substituted. Do not invent URLs, copy legacy scores or weaken identity checks.

Release results are preferred over review/list headers, with non-`.p` results preferred within the same page class; ratings and genres are selected only within the same normalized release identity. Terminal `.p` is removed for identity comparison, not from the observed source URL/reference. URL-restricted fallback queries preserve an observed `.p` URL from the owned reference, selected result or legacy hint rather than silently querying its stripped counterpart. Rating provenance distinguishes `primary-issue` from `release`. This is request/identity handling, not proof of equivalent rating scope or improved coverage; see the [research caveat](serply-search-notes.md#rym-p-suffix).

Structured `metadata.rating` and `metadata.reviews` are supported on release results. Explicit aggregate snippet pairs preserve more precision when available. Scores without a count clear the old count instead of combining observations. The adapter extracts genres and descriptors from explicitly labelled fields on results for the selected release. It does not infer tags from review prose or infer mood from audio. In flattened genre lists, ambiguous joins and truncated tokens are skipped unless corroborating evidence establishes the labels. Each extracted tag retains its field kind and evidence URL in normalized snapshot provenance. Indexed observations can differ between pages and are not labelled current RYM values.

Provenance distinguishes `rated`, `genres-only` and `identity-only` matches, with identity/year evidence, source URLs and retrieval time. An identity-only match saves its link/reference without inventing a rating or genres; it is not a rated success. No matching identity throws `ProviderItemNotFoundError`. Full search responses remain in provider history, and diagnostics distinguish empty results, rejected candidates and missing fields.

Album serialization prioritizes the validated `ratingSourceUrl` when metadata has a finite RYM score in range and Serply provenance with `matchStatus: rated`. The link points to the exact page that supplied the rating, including valid review/list child URLs, not the identity or genre source; child URLs are validated through their release parent without rewriting the displayed destination. The serializer reorders or supplies this response link without database writes, new queries or provider calls. Missing/invalid rated provenance and genres-only/identity-only results retain the existing generic/legacy link fallback. This link fix does not acquire or validate a new rating.

Bing is not a production fallback. See the [search notes](serply-search-notes.md) for query handling and evidence limits.

### Replaying saved tags

Run `pnpm --filter @repo/server exec tsx scripts/replay-rym-tags.ts --report=/private/path/preview.json`. The default is read-only and local; remote use requires an explicit direct connection in `RYM_REPLAY_DATABASE_URL`. Review the database target, skipped albums, proposed memberships and evidence URLs. Apply with the same command plus `--apply --review=<preview hash>` and a new report path. Take a recovery point first and repeat the preview after commit; it should propose zero additions. Reports contain library data and should stay private.

Replay considers successful saved Serply results for the current release identity, including earlier confirmed snapshots of the same issue. Retained structured Google genre names can disambiguate flattened words; they do not link a Google search result to an album. The replay inserts only missing album tags, memberships and source occurrences after resolving existing tag identities. It performs no searches and does not replace snapshots, ratings or canonical media fields.

## Current Service Constraints

MusicBrainz requires an identifying User-Agent and at most one request per second. The plugin uses configured app name/version/contact and the JSON release-group API, including artists, tags, genres and URL relations in the same lookup. Public reads need no account authentication. [Official API documentation](https://musicbrainz.org/doc/MusicBrainz_API), [search reference](https://musicbrainz.org/doc/MusicBrainz_API/Search).

Last.fm documents `album.getInfo` by artist/album or MBID, optional username-scoped plays, seconds for track duration, and error 29 for rate limiting. The key is required; username is optional and missing personal counts are not zeroed. [Official album.getInfo documentation](https://www.last.fm/api/show/album.getInfo).

A user token is required by this adapter, including searches. Conservative legacy spacing remains unchanged; no claim of current account entitlement or full live schema verification is made. [Official developer portal](https://www.discogs.com/developers), [official client quickstart](https://github.com/discogs/discogs_client/blob/master/docs/quickstart.md), [official model definitions](https://github.com/discogs/discogs_client/blob/master/discogs_client/models.py).

Google scraping is unconditionally retired in this application, independent of account eligibility or service retirement dates. No Google credential fields or environment fallbacks are exposed. Existing environment files and encrypted secret rows remain untouched. New Google jobs are rejected, and existing queued jobs fail as unsupported when claimed without HTTP. See [retirement behavior and offline tests](google-search-retirement.md).

## Additional Stored Album Details

Album details expose a compact, collapsed `More album info` section from the latest retained MusicBrainz, Discogs and Last.fm payloads. This is a read-only projection: opening an album does not request metadata, rewrite snapshots or reapply provider values over manual edits.

MusicBrainz contributes release types, disambiguation, artist countries, weighted original tags and existing URL relationships. Discogs contributes edition-specific labels/catalogue numbers, formats, companies, credits, notes, native track positions and have/want counts. These counts describe the fetched release, not every edition. Last.fm contributes wiki text/publication date, source track links and original tags. Provider prose is rendered as text, never executable HTML.

Future explicit scrapes retain these details from responses already needed by the adapters; no extra provider calls are added. Provider-specific browse fields are populated on those future scrapes. Existing albums can show retained detail immediately without being scraped again. Malformed or absent stored payloads omit that source's optional details.

## Offline Verification

### Last.fm Response Audit

An album job with `options: { "includeTopTags": true }` requests [album.getTopTags](https://www.last.fm/api/show/album.getTopTags) after a successful `album.getInfo`. It uses the resolved album identity and the same provider request gate. No other job gains an extra request. The snapshot preserves the original album and the dedicated response separately. Last.fm's count is a relative weight out of 100, not a vote count. The adapter retains all returned rows in the raw response but only adds dedicated tags with weight at least 10 to the usual album tag merge. Ordinary album tags are retained even if absent from the dedicated list.

For tag enrichment without replacing tracks, artwork, links or other canonical fields, set both `includeTopTags: true` and `tagsOnly: true`. Use one explicit album per job.

Use the artist and album names returned by `album.getInfo` for `album.getTopTags`, even when the first lookup used an MBID. Ranked tags are freeform labels, not necessarily genres.

Tags support arrays, a single named object, an empty outer string and an empty outer object. Tracks support arrays and a single named object; null or missing duration stays unknown, while numeric zero remains zero. Empty image text is valid missing artwork, not an invalid URL exception. Last.fm album URLs may include the `+noredirect` path segment. Corrected references use the same URL validation and decode the actual artist/album segments. Malformed URLs, missing identifiers, invalid counts and malformed collection entries still fail validation; no catch-all empty-data fallback is used.

Run the repeatable offline audit from the server workspace:

```sh
pnpm exec tsx scripts/audit-lastfm-responses.ts
```

It uses a read-only repeatable-read transaction, scans snapshots in batches of 100, supplies stored responses through a mocked request function, blocks global fetch and exits nonzero on any failure. It does not import data, queue jobs, retry failures or print credentials/raw payloads. Legacy unwrapped album bodies are wrapped only for offline adapter replay.

`lastfm-response-matrix.test.ts` checks accepted and rejected response shapes offline. `integration/lastfm-jobs.integration.ts` checks the adapter, gate, queue and persistence using mocked HTTP and a temporary database.
