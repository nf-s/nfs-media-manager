# Secondary tables

The film, album, track and subscription **Browse** tables keep their own layout, virtualization and controls. Other tabular views share the components in `apps/web/components/secondary-table.tsx` and the raw-value comparator in `apps/web/utils/secondary-table.ts`.

## Interaction

- Every data header is a button that switches between ascending and descending order. The active header exposes `aria-sort` and a direction arrow. Selection, artwork and action-only columns have no sort button.
- Tables with more than three available columns offer **Columns** to show or hide columns and **Reset columns** to restore defaults. Choices are saved independently for each table in this browser. Essential identity or selection controls can remain fixed; at least one configurable column stays visible. Invalid or unavailable browser storage falls back to usable defaults. Tables with three or fewer columns have no chooser and show every column, including fields previously hidden by defaults or saved preferences.
- Numeric values sort numerically, dates by their underlying timestamps, and text case-insensitively. Missing values sort last in either direction. Metadata freshness retains its existing never-scraped-first ascending order. Use a stable tie-breaker for paginated server queries.
- Search, filter and sort the entire dataset before pagination. Server-backed lists send these controls to their API; never filter or reorder only loaded pages. Changing search, filters or sort resets pagination and scrolling, and clears selection where the action depends on the displayed rows or order. Local import previews filter and sort the entire preview before rendering their first batch.
- Column visibility changes headers, cells and loading/error/expanded-row spans together. Horizontal scrolling keeps chosen columns available on small screens; do not silently hide them with responsive CSS.
- Tables use a labelled, keyboard-scrollable region, compact cells, sticky headers and one rounded, neutral border. Keep loading, empty, failure and retry states inside the same table structure where possible. Preserve range selection, explicit bulk actions, job disclosures and provider request limits.

## Toolbar and filters

Use one `SecondaryTableToolbar` at the top of each table. Its order is **search → useful filters → result count → Columns**. Omit slots that do not help with that dataset. Columns occupies its own slot at the upper right even when the other controls wrap. Search inputs, filter selects and the Columns trigger share a compact 28px height. Keep selection counts, bulk actions and launch controls on a separate row below the toolbar; do not put them between its controls.

Provide text search for lists of names, titles or jobs. Use filters that answer a concrete question: job status, new versus already imported preview rows, playlist source or import status, watched films, or subscription kind. Import previews must let users hide existing items; omit that filter when the preview already excludes them, as NFO previews do. Keep the count beside the filters and report matching results; when a local preview also shows the original total, use the same `matching of total` format. Preserve established navigation filters, such as Tags and Hidden tags, without duplicating them in a select.

Group numerous related controls under **Filters** using the existing popover pattern. Metadata selection keeps legacy-import, provider freshness and range filters there, independent of column visibility. Active text and facet chips can remain in their existing row. Do not place filters inside hideable table headers. A small summary such as the three-column Last.fm link summary needs neither a chooser nor a redundant search/filter toolbar.

## Components

`SecondaryDataTable` is for complete datasets already in memory. Define each column's raw `value` separately from its optional formatted `render`. Supply a stable row key and default sort. Its optional `search` supplies a label, placeholder and searchable row value; `filters` accepts existing filter controls, and callers apply those filters before passing `rows`. Use `countLabel` for the result-count noun and `totalCount` when reporting the original total of a filtered dataset. It renders the shared toolbar automatically and omits it when there are no useful controls or count.

Tables with custom selection, server pagination or expandable rows compose `SecondaryTableToolbar`, `SecondaryTableScroll`, `SecondaryTableHead` and `useTableColumns`. Pass search, filters, count and `useTableColumns().controls` into the matching toolbar slots. Use the existing shared table primitives for rows and cells. The column control is a native popover, closes on Escape/outside click and restores focus to its trigger on Escape.

Do not change the base `Table` or Browse styles to achieve a secondary-table change. Keep styling scoped to the shared secondary wrapper.

## Covered views

| Area      | Tables                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jobs      | Job monitor, item job history, album/film metadata selection, provider request counts                                                              |
| Imports   | Recent import history, legacy sources, album file/Spotify previews, film CSV/NFO previews, Spotify playlists, Last.fm link summary and link report |
| Libraries | Tags, playlists, playlist entries, album detail tracks, subscription channels/podcasts                                                             |
| Films     | Collections and collection members                                                                                                                 |

Recent import history covers the latest 20 runs returned by the status endpoint. Its search, filters and headers operate on that explicitly recent set. Other paginated views filter and sort on the server across all matching results.

## Date and position meanings

Spotify playlist **Added to library** is the first stored library date. It is unknown for playlists not yet imported. Spotify's listing does not supply the date a playlist was followed/saved; do not invent that date or substitute last checked. Playlist entry **Added** is the stored membership date, when available.

Playlist entries default to stored position. Film collections also preserve stored positions and gaps; some older imports lack the original source ranking. Sorting another column does not renumber positions. See [film collections](film-collections.md).

## Verification

Use synthetic fixtures, mocked providers and disposable databases. Cover both sort directions, missing values, numeric/date ordering, ties across page boundaries, filtering before pagination, visible-column spans, selection after searching/filtering/reordering and original position labels. Verify that import filters can hide already imported rows and that tiny tables retain every column without a chooser.

Inspect the whole page in the browser at desktop and phone widths, with filters and Columns open as well as closed. Check control order and height, Columns at the upper right, wrapping, table scrolling and menu clipping; isolated component markup does not catch styles inherited from page ancestors. Verify column persistence, reset, Escape/outside dismissal and restored focus. Sorting, filtering, hiding columns and opening stored details must never scrape, import, retry or play anything.
