# Secondary tables

The film, album, track and subscription **Browse** tables keep their own layout, virtualization and controls. Other tabular views share the components in `apps/web/components/secondary-table.tsx` and the raw-value comparator in `apps/web/utils/secondary-table.ts`.

## Interaction

- Every data header is a button that switches between ascending and descending order. The active header exposes `aria-sort` and a direction arrow. Selection, artwork and action-only columns have no sort button.
- **Columns** shows or hides columns and **Reset columns** restores defaults. Choices are saved independently for each table in this browser. Essential identity or selection controls can remain fixed; at least one configurable column stays visible. Invalid or unavailable browser storage falls back to usable defaults.
- Numeric values sort numerically, dates by their underlying timestamps, and text case-insensitively. Missing values sort last in either direction. Metadata freshness retains its existing never-scraped-first ascending order. Use a stable tie-breaker for paginated server queries.
- Sort the entire matching dataset before pagination. Never reorder only the loaded pages of a server-backed list. Changing the sort resets pagination and scrolling, and clears selection where the action depends on the displayed order. Local import previews sort the entire preview before rendering their first batch.
- Column visibility changes headers, cells and loading/error/expanded-row spans together. Horizontal scrolling keeps chosen columns available on small screens; do not silently hide them with responsive CSS.
- Tables use a labelled, keyboard-scrollable region, compact cells, sticky headers and one rounded, neutral border. Keep loading, empty, failure and retry states inside the same table structure where possible. Preserve range selection, explicit bulk actions, job disclosures and provider request limits.

## Components

`SecondaryDataTable` is for complete datasets already in memory. Define each column's raw `value` separately from its optional formatted `render`. Supply a stable row key and default sort.

Tables with custom selection, server pagination or expandable rows compose `SecondaryTableScroll`, `SecondaryTableHead` and `useTableColumns`. Use the existing shared table primitives for rows and cells. The column control is a native popover, closes on Escape/outside click and restores focus to its trigger on Escape.

Do not change the base `Table` or Browse styles to achieve a secondary-table change. Keep styling scoped to the shared secondary wrapper.

## Covered views

| Area      | Tables                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jobs      | Job monitor, item job history, album/film metadata selection, provider request counts                                                              |
| Imports   | Recent import history, legacy sources, album file/Spotify previews, film CSV/NFO previews, Spotify playlists, Last.fm link summary and link report |
| Libraries | Tags, playlists, playlist entries, album detail tracks, subscription channels/podcasts                                                             |
| Films     | Collections and collection members                                                                                                                 |

Recent import history covers the latest 20 runs returned by the status endpoint. Its headers sort that explicitly recent set. Other paginated views sort on the server across all matching results.

## Date and position meanings

Spotify playlist **Added to library** is the first stored library date. It is unknown for playlists not yet imported. Spotify's listing does not supply the date a playlist was followed/saved; do not invent that date or substitute last checked. Playlist entry **Added** is the stored membership date, when available.

Playlist entries default to stored position. Film collections also preserve stored positions and gaps; some older imports lack the original source ranking. Sorting another column does not renumber positions. See [film collections](film-collections.md).

## Verification

Use synthetic fixtures, mocked providers and disposable databases. Cover both sort directions, missing values, numeric/date ordering, ties across page boundaries, visible-column spans, selection after reordering and original position labels. Verify browser column persistence, reset, Escape/outside dismissal and narrow layouts. Sorting, hiding columns and opening stored details must never scrape, import, retry or play anything.
