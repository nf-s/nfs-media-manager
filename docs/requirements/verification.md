# Verification and Remaining Work

Verified locally on 2026-10-27, on `refactor`. This is an implementation status report, not a claim that every requirement below is complete.

## Delivered

- One shared album/film browser with artwork-first grids, virtualized tables and grids, automatic incremental loading, sortable/resizable columns, and per-library URL/local preferences.
- Whole-library autocomplete for titles, creators, tags, sources and other text fields; clickable metadata; cross-field OR, required and excluded filters; inclusive numeric/date ranges and explicit missing-value handling.
- All 32 album sort fields and 32 film sort fields in this local installation, including dynamically registered plugin metrics. Missing numeric values sort last in either direction.
- Detail overlays retain browse scroll and restore focus. Overview is visible immediately; tracks, editing and history are tabs. Raw snapshot JSON starts closed. Spotify uses outbound links only, as confirmed by the user.
- Local raw/current JSON import with persistent web progress, two-album/two-film defaults, explicit full import, repeatable snapshots, preserved raw/library context and archived records rather than destructive deletion.
- Direct web access to legacy `/data` files is blocked; they remain readable only as local import inputs. Browsing uses authenticated API routes.
- Imported smart-playlist definitions are available as 123 local saved views, including range/sort/limit semantics. There are no implicit remote playlist writes.
- Local private provider package has its own manifest, implementation, setup README and offline fixtures under the ignored plugin directory. Public code handles credentials and browse fields through SDK declarations, without provider-specific names.

## Data Reconciliation

Current album input: **3,360** rows, all visible. Current film input: **2,640** rows representing **2,639** distinct films. The repeated film preserves watched status, personal rating and both original rows in history.

The raw film file contains 2,958 entries; it is not the same set as the old browser's filtered/cleaned film list. Records outside the current browse set and previous database-only records remain archived. This installation retains 336 archived films, accessible through Views. They are not silently dropped or included in the default parity count.

`scripts/verify-legacy.ts` checked **168,746 populated field values** and **23,752 external links**, with **zero mismatches**. It covers canonical browse fields, ratings/dates, source categories, metadata arrays and registered plugin metrics/identifiers. It does not assert equality for absent optional source fields or every nested raw provider property. Full raw records and library context are separately retained in snapshots.

The local report is ignored at `apps/server/data/legacy-reconciliation.json`. Two sequential web imports of two albums/two films succeeded; the second added no entities or snapshots. The database was backed up before the full import. No source JSON or existing environment file was rewritten.

## Test Evidence

- Shared schema tests: 44 passing, including saved-view aliases, optional sorts, duplicate filters, conservative import defaults and existing edit contracts.
- Server unit/API tests: 33 passing, including authentication, input validation, local import defaults, plugin loading/missing packages, provider boundaries and broad-job rejection.
- Temporary Postgres integration: migrations, tiny fixture import, cross-field filter semantics, ranges/missing values, numeric sorting, archive visibility, history A/B/A deduplication and override/reference survival. Outbound fetch is forbidden; the test database is dropped afterwards.
- Local private package: three offline tests passing. No live connectivity claim is made.
- Server/web typechecks and Next.js production build passed. Targeted lint has no errors; existing warnings include the ordinary artwork image element, environment declarations and dotenv-loader constant loops.
- Chrome DevTools: keyboard autocomplete, tag/source clicks, filter modes, IMDb range filtering, table/header sorting, column visibility and keyboard resizing with reload persistence, 123 saved views, every registered sort field, incremental scrolling/virtualized rows, overlay close/focus/scroll restoration, tracks/service links and collapsed history.
- Chrome DevTools: desktop and 390px mobile grid/detail layouts without page-level horizontal overflow; real title/source and identifier edits using a temporary database fixture, including incomplete-reference validation. The fixture and its dependent records were removed afterwards.
- Chrome DevTools: masked credential screen, conservative job form and two tiny local web imports with success/progress. No provider test, scrape or playlist-sync action was executed. The two pre-existing completed scrape jobs were unchanged.
- Direct and percent-encoded legacy data URLs returned 404 after the public-file guard was added; normal authenticated API reads remained available.

## Remaining Work

- Film CSV upload/preview and server-configured NFO scanning are implemented (see workflow follow-up below). Direct album/UPC CSV imports remain unimplemented.
- Live music scraping, Spotify saved-album account discovery/OAuth and remote playlist publishing are not implemented on this branch. Music provider payloads, metrics, links and playlist definitions are imported and browseable. These are separate from the confirmed removal of the embedded player.
- Clearing an override back to a provider-selected value is not implemented. Saving canonical overrides and correcting identifiers are implemented and tested; audit rows are retained.
- Artist-library, blacklist and missing-match context is retained in root import snapshots, but has no dedicated inspection screen. Track disc/artist metadata remains available in raw provider snapshots rather than separate track-list columns.
- The in-server scrape worker is single-process and must not be deployed as multiple independent workers yet. The shared HTTP gateway now enforces persistent request-level pacing, quotas and cooldowns for cooperating adapters; arbitrary installed plugin code is not sandboxed. Job restart recovery and a dedicated worker remain follow-up work.
- Browser checks were exercised with Chrome DevTools; there is not yet a standalone automated frontend regression suite. OAuth remains untested.

## Filter, Import and Request-Safety Follow-Up

The earlier test/data counts above describe the pre-follow-up baseline, not equality after new imports or live metadata updates.

- Reproduced the country-filter HTTP 500: the SQL cast bound to the JSON key instead of its extracted value. Text-array matching now handles arrays/scalars correctly; relational artist/credit/tag/collection filters use indexed existence checks rather than duplicate JSON aggregates. Local France/genre/language queries returned 200 in approximately 100-170ms after the fix.
- Shift-click adds filters without closing overlays or leaving detail pages. Normal clicks still navigate/filter. Optional/required/excluded states use blue/green/red plus text labels; static class mappings prevent Tailwind from purging these states.
- Added direct IMDb ratings/watchlist CSV and Kodi NFO imports, with runtime plugin-declared CSV formats. Preview and import default to three films; broader local imports are explicit. Repeated snapshots are idempotent. Files fill missing canonical fields, preserve watched status/rich metadata/other credit roles, and refuse ambiguous external identities.
- NFO parsing uses the approved XML parser, rejects DTD/entity declarations, validates XML, and supports combined XML-plus-URL NFOs without fetching those URLs. Directory and file-size limits bound work; symlinks and excluded folders are skipped.
- OMDb normalization now accepts native API field casing, ignores N/A artwork, preserves ratings/countries/languages, and treats textual release dates as calendar dates rather than local-time instants. TMDb requests append credits to the same details request and retain rich browse fields.
- Postgres request gates share spacing, leases, rolling-hour counts and cooldowns across jobs and credential tests. HTTP 429 honors Retry-After; 400/5xx back off; 401/403 halt access; two other failures cancel remaining items. No automatic retries. Provider UI shows cooldown/halt status and the hourly budget when applicable.
- Temporary-Postgres integration covers migration, persistent cooldowns, request serialization, hourly exhaustion, HTTP-200 quota errors, batch cancellation, plugin-specific job caps and file import deduplication/identity matching. Provider responses are mocked.
- Initial live verification used exactly one known-film request per executable film provider. TMDb and the local private metadata adapter succeeded. OMDb returned HTTP 401 and was halted without retry. After the user confirmed OMDb was ready, one explicitly requested retry succeeded. Total live requests: two OMDb, one TMDb, one local private provider. Existing root environment contents were unchanged.
- Local private package has nine offline tests. API response envelopes are reduced to metadata before storage; credentials are not stored in live snapshots. Imports and normal tests never contact providers.
- Chrome DevTools exercised the exact France-filter URL and all twelve populated film facet categories (HTTP 200), modal shift-click accumulation, actual blue/green/red computed colors, and direct web preview/import for three films from each of four supplied sources. All four tiny imports completed with zero warnings/failures. A repeat ratings import verified corrected numeric date normalization; no full-library file import was triggered.
- Final checks: 44 schema tests, 42 server unit/API tests, 15 temporary-Postgres integration tests and nine local-package tests passed. Server/web typechecks, server declaration build and Next production build passed; lint reported warnings but no errors. The declaration build now contains its output under `dist` instead of emitting beside source files. Chrome also verified Shift-click on standalone film details and album modals, and that closing a grid-opened modal preserves newly added filters.

## Shared Filters and Job Diagnostics Follow-Up

- Browse lists, standalone details and detail modals now render the same filter chips: Any (blue), Required (green), Excluded (red), with a separate remove button. Mode changes stay on the current page or keep the modal open. Closing a modal and opening/returning from a standalone detail preserve the edited filters and browse settings.
- Jobs include linked media titles and actual media types instead of using IDs or guessing the type from the job scope. The compact list supports title/provider search and status filtering, with aligned summaries and horizontally scrollable item tables on narrow screens.
- Failed-job logs open by default. New failures retain the original exception message, stack and nested causes in authenticated job-log metadata. Resolved provider credentials, server secrets and common credential fields are redacted before storage. Diagnostic size/cause depth are bounded. Historical generic failures cannot recover stacks that were never recorded.
- Regression checks: 44 shared-schema tests, 47 server unit/API tests, 17 temporary-Postgres integration tests and nine local-package offline tests pass. Integration verifies persisted adapter/network error chains, encrypted-credential redaction, media names/types and unchanged no-retry/cooldown behavior. Server/web typechecks and server declaration build pass; lint has no errors.
- Chrome DevTools verified film and album chip cycling/removal, Shift-click additions, modal close preservation, standalone links/back navigation, computed mode colors, job search/status controls and title links. A browser-only diagnostic fixture verified stack/cause rendering at desktop and 390px mobile without page-level horizontal overflow; it did not alter database records. No live provider requests or environment-file edits were made for this follow-up.

## Reviewed Import, Refresh and Identifier Follow-Up

- CSV imports now use type selection and drag/drop, validate the whole bounded file, then show a paginated preview with row selection and new/update/Needs ID status. Previews stage data without adding library records or starting scraping. Confirmation imports exactly those rows, with optional provider enrichment; no providers means offline import.
- NFO preview uses server-only `SCAN_DIR`, excludes existing films and supports unidentified films. Source paths are not editable in the browser. Tests traverse three tiny local NFO fixtures; the configured mounted volume was not bulk-imported.
- Every imported film gets an internal ID. Shared IMDb/TMDb references are extracted before enrichment; missing references retain the film with a filterable Needs ID marker. The private CSV adapter validates exact IMDb IDs/URLs without credentials or requests.
- Replaced the generic identifier form with provider rows, current ID inputs and individual Update buttons. Shared IMDb/TMDb edits normalize/validate input, refuse conflicting film identities, feed other providers and survive future provider payloads. Missing-ID detail badges link directly to editing.
- Import enrichment uses explicit one-film jobs, skips already scraped/queued work, and reports missing IDs/credentials. Header counters link to active jobs/errors and refresh cached data after background completion. Jobs support server-side pagination, search, status and batch filters, with retry for unfinished work only. Cooldowns defer queued work; repeated errors halt the remaining provider batch.
- Stale-film refresh previews up to 100 oldest films, by each provider's last successful scrape. Imports/manual edits never refresh that timestamp. Films without usable provider IDs are excluded with a link to identify them. Broad refreshes require explicit confirmation.
- Automated checks: 46 shared-schema tests, 49 server unit/API tests, 25 temporary-Postgres integration tests and 10 private-package offline tests. Integration covers preview ownership/expiry/replay protection, import idempotency, NFO new-film selection, missing IDs, cross-provider edits, stale selection, queue deduplication, cooldown deferral, repeated-error cancellation and retry exclusion of successful items. All provider responses are mocks; no outbound fetches.
- Chrome DevTools exercised generated-file drag/drop, preview, one-film import with all providers unchecked, Needs ID display, inline ID validation and a persisted IMDb URL correction. A mocked retry returned its cooldown error inline without sending any request to the server. Mobile import, jobs, refresh preview and provider rows had no horizontal overflow at 390px. Temporary film/import/preview records were removed. The native file-chooser tool was unavailable due to its workspace restriction; drag/drop exercised the same browser File input processing.
- No live provider requests were made during this follow-up. The only environment change was adding the server NFO directory setting; removing that line reproduces the original environment checksum, confirming existing credentials are unchanged. The private package remains ignored.

## Repository Safety

The old checkout's tracked edits remain in the named pre-overhaul stash. No commit or push was made. The root environment checksum matched before and after this work. Private packages, local data and backups are ignored. Public tracked files were checked for private-provider names; this does not rewrite existing Git history.
