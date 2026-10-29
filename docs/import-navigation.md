# Import destinations

Imports uses the shared `SectionWorkspace` / `SectionSidebar` layout from Jobs and Providers. The order is Recent imports, catalog-provided CSV formats, Find new NFO films, and Legacy JSON library. No local plugin names are embedded in the frontend.

One compact Library selector in the header controls Albums/Films across Browse, Tags, Imports, Jobs and Providers. Section sidebars contain destinations only, without repeated library tabs. Scope remains encoded as `mediaType=album|film`; Film is the default for old links. Changing library retains the current section where possible, clearing provider selections, import previews and item/job deep links. Job status is retained because it applies to both libraries. Direct Spotify and album CSV routes imply Albums even without a query parameter.

Album imports use `/imports/spotify?mediaType=album` for explicit account connection and saved-album discovery, and `/imports/albums?mediaType=album` for album/UPC CSVs. `/imports/csv?mediaType=album` also opens album CSV. Discovery defaults to 20 albums, supports a bounded offset and requires additional confirmation above 50. Discovery only creates a preview; nothing is selected initially. Existing albums are unchanged and disabled. Importing checked new rows is a separate action, with explicit confirmation above five metadata operations. Album and film previews share the same bounded, Shift-selectable table.

Recent import history requests the selected `mediaType` before the server's history limit and filters records by their declared media type. This includes queued, running and failed imports, not only completed results. Null scope records remain visible in both libraries and are labelled **Mixed / legacy scope unknown**. Job links retain the run's declared scope. A separate unfiltered status query preserves the global running-import guard and links to the active import's library. The legacy import remains the existing two-album/two-film combined workflow.

Jobs monitoring passes `mediaType` to the server rather than inferring job type from provider capabilities. New scrape and refresh share one selection table for both libraries, with Artists added for albums and freshness tied to the named provider. Selection is empty initially and reset on filters/provider/scope changes. Providers only lists capabilities for the active library. Existing unscoped provider/job detail links resolve their scope from the selected record.

Header activity is one compact button showing aggregate active/issue counts. Its popover groups running, queued, attention and import counts by library, with correctly scoped links. The existing polling endpoint supplies both totals and groups, with no extra per-library requests. It never hides another library's jobs merely because the current page is album-scoped. The popover supports outside-click dismissal, Escape with focus return, and bounded mobile positioning.

Spotify setup guidance derives the callback from the configured browser-facing API URL, preserving its API port and replacing local `localhost` with `127.0.0.1`. It separately shows the matching browser sign-in URL. The app and browser-facing API/auth addresses can stay on localhost. The loopback callback relays to the configured API/auth origin, where the original signed-in session completes authorization. Both app/API origins must be trusted, and the exact callback must be registered in Spotify and provider settings. This guidance never changes settings or starts authorization automatically.

- `/imports` monitors recent imports, with two-second polling, final new/changed/unchanged counts, warnings and metadata batch links.
- `/imports/csv?format=<id>` opens that CSV format directly. Formats are validated against `/api/v1/imports/formats`; missing format selects the first CSV format, while unknown or removed formats never silently fall back to a different parser.
- `/imports/nfo` uses the server-configured folder and requires an explicit preview before confirmation.
- `/imports/legacy` preserves the two-album/two-film default and explicit full-library checkbox. Starting a legacy import returns to Recent imports; it does not queue metadata scraping.

The layout owns polling and completion invalidation across destinations. File workflows are keyed by source/format so switching destinations clears stale previews and confirmation state. Their source selectors are hidden when the sidebar controls the destination. Successful file imports link to Recent imports and the existing metadata batch destination.

Opening or switching pages only reads status/configuration. It does not scan folders, upload CSVs, import records or queue provider jobs. CSV preview classifications and new-film-only enrichment rules remain owned by the existing film import workflow and backend services.

## Verification

Navigation helpers cover catalog ordering, plugin ID encoding, unavailable formats and empty catalogs. Existing sidebar rendering tests cover active links and accessible navigation. Browser checks should cover desktop/mobile navigation, direct links, back/forward, format-switch preview reset, NFO server path and legacy confirmation defaults without actually importing or scraping.

Run isolated UI checks without any live imports or provider calls:

```sh
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/media-workspaces.test.tsx apps/web/components/import-preview-table.test.tsx apps/web/components/job-activity.test.tsx apps/web/utils/media-scope.test.ts apps/web/utils/spotify-setup.test.ts apps/web/utils/film-selection.test.ts apps/web/utils/import-navigation.test.ts apps/web/utils/job-selection.test.ts apps/web/components/section-sidebar.test.tsx
```
