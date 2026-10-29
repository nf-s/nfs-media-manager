# Album provider contracts

The current album adapters validate responses at the provider boundary and return shared media contracts. Tests use synthetic responses through mocked requests. Private integrations are loaded separately through the plugin SDK.

## Supported adapters

| Provider    | Behavior                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| MusicBrainz | Uses an owned release-group ID first, then bounded barcode/name searches. Retains relations without changing another provider's identifiers. |
| Last.fm     | Performs one album lookup by album MBID, corrected URL, or canonical names. Release-group IDs are not treated as album MBIDs.                |
| Discogs     | Uses an owned corrected ID or bounded native barcode/master/release searches. A master lookup fetches its main release only.                 |
| Spotify     | Supports album metadata and the separately authorized [saved-album import](spotify-album-imports.md). Audio-feature acquisition is excluded. |
| Serply      | Looks up indexed Rate Your Music results. Search-derived ratings can lag the source.                                                         |

Google Custom Search is retired. Historical ratings and source links remain importable under the existing provider ID; see [retirement behavior](google-search-retirement.md). CSV and legacy JSON files use the current [import workflows](importing.md). Archived scrapers, cleaners, playlist-sync helpers and prototypes are no longer included.

## Request safety

| Provider    | Concurrency / minimum spacing | Maximum calls per album                               |
| ----------- | ----------------------------- | ----------------------------------------------------- |
| MusicBrainz | 1 / 1000 ms                   | 1 direct; 2 name or barcode; 3 barcode miss then name |
| Last.fm     | 1 / 200 ms                    | 1                                                     |
| Discogs     | 1 / 1050 ms                   | 1 release; 2 master; at most 4 with searches          |

Every HTTP request, including searches, uses `context.request`. There are no client libraries, direct fetches, hidden retries, pagination walks, quota-discovery calls, or network activity on module import. The persistent server gate owns spacing, timeouts, cooldowns and shared budgets. Runtime account access is not proven by these offline tests. The MusicBrainz, Last.fm and Discogs plugins do not claim a connection-test hook; no credentials are tested on import.

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

The [Serply authentication documentation](https://www.serply.io/docs/guides/authentication) describes plan/traffic-dependent limits and HTTP 429 responses, but publishes no numeric requests-per-second or concurrency ceiling. Two concurrent requests and 250 ms spacing are local tuning choices, not advertised account entitlements; a bounded two-request live check returned HTTP 200 for both and no rate-limit headers. Existing 429/Retry-After cooldowns and budgets still apply. The documented `x-ratelimit-requests-limit` / `x-ratelimit-requests-remaining` headers differ from the gateway's optional reset-aware header contract, so that separate opt-in remains disabled.

The adapter searches `site:rateyourmusic.com Artist Release` first. When fields are missing and a matching or saved release URL is available, it makes at most one additional search restricted to that URL. An empty search without a known URL ends after one request. It validates RYM result identities and any explicit release year, prefers canonical releases over review headers, and excludes identified editions and individual-review scores. Corrected/saved RYM URLs constrain matching. Full search responses, field source URLs and retrieval time remain in provider history.

Structured `metadata.rating` and `metadata.reviews` are supported on canonical release results, including the user-supplied Pripyat response (3.4, 1,836, Glitch Pop / Avant-Folk). Explicit aggregate snippet pairs preserve more precision when available. Scores without a count clear the old count instead of combining observations. Explicit `Genres:` lists are retained; flattened headers contribute their first complete comma-delimited genre, with a bounded title genre as another fallback. Missing genre tiers and descriptors do not prevent saving a usable rating or genre. Indexed observations can differ between pages and are not labelled current RYM values.

Offline adapter and isolated queue tests cover the supplied/captured responses, identity conflicts, partial values, malformed data, error handling, persistence and the two-search bound. The implementation was also exercised against Serply with one live Pripyat lookup, which returned an indexed aggregate header; the library was not modified by that diagnostic.

## Current Service Constraints

MusicBrainz requires an identifying User-Agent and at most one request per second. The plugin uses configured app name/version/contact and the JSON release-group API, including artists, tags, genres and URL relations in the same lookup. Public reads need no account authentication. [Official API documentation](https://musicbrainz.org/doc/MusicBrainz_API), [search reference](https://musicbrainz.org/doc/MusicBrainz_API/Search).

Last.fm documents `album.getInfo` by artist/album or MBID, optional username-scoped plays, seconds for track duration, and error 29 for rate limiting. The key is required; username is optional and missing personal counts are not zeroed. [Official album.getInfo documentation](https://www.last.fm/api/show/album.getInfo).

The Discogs developer portal returned HTTP 403 to the documentation tool during this review. Endpoint structure and User-Agent requirements were cross-checked against Discogs' own published client/docs, not authenticated API calls. A user token is required by this adapter, including searches. Conservative legacy spacing remains unchanged; no claim of current account entitlement or full live schema verification is made. [Official developer portal](https://www.discogs.com/developers), [official client quickstart](https://github.com/discogs/discogs_client/blob/master/docs/quickstart.md), [official model definitions](https://github.com/discogs/discogs_client/blob/master/discogs_client/models.py).

Google scraping is unconditionally retired in this application, independent of account eligibility or service retirement dates. No Google credential fields or environment fallbacks are exposed. Existing environment files and encrypted secret rows remain untouched. New Google jobs are rejected, and existing queued jobs fail as unsupported when claimed without HTTP. See [retirement behavior and offline tests](google-search-retirement.md).

## Additional Stored Album Details

Album details expose a compact, collapsed `More album info` section from the latest retained MusicBrainz, Discogs and Last.fm payloads. This is a read-only projection: opening an album does not request metadata, rewrite snapshots or reapply provider values over manual edits.

MusicBrainz contributes release types, disambiguation, artist countries, weighted original tags and existing URL relationships. Discogs contributes edition-specific labels/catalogue numbers, formats, companies, credits, notes, native track positions and have/want counts. These counts describe the fetched release, not every edition. Last.fm contributes wiki text/publication date, source track links and original tags. Provider prose is rendered as text, never executable HTML.

Future explicit scrapes retain these details from responses already needed by the adapters; no extra provider calls are added. Provider-specific browse fields are populated on those future scrapes. Existing albums can show retained detail immediately without being scraped again. Malformed or absent stored payloads omit that source's optional details.

## Offline Verification

### Last.fm Response Audit

The Last.fm boundary is checked against the [official album.getInfo example](https://www.last.fm/api/show/album.getInfo), [client schemas](https://github.com/ansango/lastfm-api/blob/54494963c25177aaf13a29ec7eeb09efc0d0a85b/src/api/album/schemas.ts), [client fixtures](https://github.com/ansango/lastfm-api/blob/54494963c25177aaf13a29ec7eeb09efc0d0a85b/src/__tests__/album.test.ts), and retained local responses. The client types supplement the official XML example; neither is treated as an exhaustive specification of JSON wire shapes.

Tags support arrays, a single named object, an empty outer string and an empty outer object. Tracks support arrays and a single named object; null or missing duration stays unknown, while numeric zero remains zero. Empty image text is valid missing artwork, not an invalid URL exception. Last.fm album URLs may include the `+noredirect` path segment. Corrected references use the same URL validation and decode the actual artist/album segments. Malformed URLs, missing identifiers, invalid counts and malformed collection entries still fail validation; no catch-all empty-data fallback is used.

On 2026-10-28, all six recorded failed Last.fm jobs across four albums were inspected. Their error classes were singleton tags, singleton tracks, empty tags and null durations. Failed responses were not retained in those jobs; regression cases reconstruct the reported wire shapes rather than claiming to replay their exact bodies.

The full retained-response audit initially found 289 additional failures: 214 singleton-tag responses, 71 URL refinement exceptions involving missing artwork, and four rejected `+noredirect` URLs. After repair, all 6,434 legacy-import snapshots and seven scrape-job snapshots passed the full adapter. This checks known retained data, not every possible future API response.

Run the repeatable offline audit from the server workspace:

```sh
pnpm exec tsx scripts/audit-lastfm-responses.ts
```

It uses a read-only repeatable-read transaction, scans snapshots in batches of 100, supplies stored responses through a mocked request function, blocks global fetch and exits nonzero on any failure. It does not import data, queue jobs, retry failures or print credentials/raw payloads. Legacy unwrapped album bodies are wrapped only for offline adapter replay.

`lastfm-response-matrix.test.ts` covers 221 positive and negative cases with networking disabled. `integration/lastfm-jobs.integration.ts` runs the real adapter, request gate, queue and persistence against mocked HTTP in a temporary database, checking both successful snapshots and failed-job error/stack logging. Do not substitute the full integration suite or run a live bulk retry for these checks.

`apps/server/src/plugins/builtin/__tests__/album-providers.test.ts` exercises normalization, zero values, corrected references, source ownership, malformed responses, benign misses, HTTP status errors, quota bodies, gateway error preservation and request ceilings. Global fetch is blocked. Request-policy unit tests and 25 explicitly selected request-gate integration cases also passed, using mocked HTTP and uniquely named temporary databases that are dropped afterwards. The initial provider survey did not run queue-processing or live provider tests; the Last.fm follow-up above adds isolated queue coverage. Run focused files/cases explicitly; do not substitute the whole server suite while active user jobs exist.
