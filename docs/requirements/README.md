# Feature parity requirements

Audited 2026-10-27 against `master` at `5485054`, including the current uncommitted fixes, source code and the running Vite app in Chrome DevTools. Implement on `refactor`; do not replace the old checkout's data or environment.

## Feature sets

- [Browsing and navigation](browsing.md)
- [Search, filtering and sorting](search.md)
- [Albums, music and playlists](music.md)
- [Films](films.md)
- [Details, overrides and history](details.md)
- [Imports, providers and safety](imports-and-plugins.md)
- [Verification and remaining work](verification.md)

## Audit evidence

The old UI is defined by `apps/web/src/Browser`, `Table`, and `Models`; filter semantics are in `packages/data-types/src/fields.ts`. Its strengths are one shared toolbar, clickable metadata, persistent table/grid preferences, incremental image loading, a virtualized table and an overlay that leaves browsing mounted. Its Spotify player is optional. The Playlist library has no data loader and stays on Loading; preserve its data and definitions rather than copying this broken state.

Chrome confirmed 2,640 films, source autocomplete with counts, table/grid switching, all film columns and sort controls. Code inspection covers album metrics, numeric range filters, playback/queue actions, importer scripts and smart-playlist synchronization. Do not interpret source inspection as a successful live integration test.

Current inputs: raw music has 3,360 albums, 1,891 artists, 49 blacklisted albums, 162 missing matches and one playlist (updated 2026-10-10); cleaned music has 3,360 albums. Raw film input has 2,958 entries, 887 NFO filenames and 15 failed NFOs; cleaned film input has 2,640 rows. Duplicate raw film records must reconcile by identifiers, not create duplicate visible films.

## Release gate

- Run contract/service/UI tests and typechecks; verify the actual app with Chrome DevTools at desktop and mobile sizes.
- Reconcile imported counts, identifiers, every cleaned field, source categories, snapshots, playlists and private-provider data. Keep a reproducible local-only report, not private payloads in Git.
- Exercise filter selection/removal/modes, numeric bounds, all sort choices, column visibility, scrolling, detail/back navigation and errors.
- No live scraping or remote account mutations during this overhaul. Imports read local files only.
- Preserve existing credentials, database, ignored local packages and old branch edits. Do not push.

## Intentional corrections

Do not copy old defects: missing-art records disappearing from grids; filters resetting incorrectly when two results have the same count; numeric filters using another column's range; missing values sorting inconsistently; non-keyboard-accessible links; endlessly loading empty libraries; noisy debug output; broken OAuth refresh. User confirmed Spotify outbound links only, without embedded playback or queue controls.
