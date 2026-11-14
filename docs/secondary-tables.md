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

Use one `SecondaryTableToolbar` immediately above each table. Its order is **search → result count → Columns**. Columns occupies its own upper-right slot even when controls wrap. Search inputs and the Columns trigger share a compact 28px height. Table-wide actions, such as listing a source again or starting a new import, belong above this toolbar.

Put categorical filters beside their column's sort button using `SecondaryColumnFilter`. Always allow multiple values; an empty selection means all values. Values in one column match with OR; different filtered columns combine with AND. Use `SecondaryHeaderFilter` for a numeric/date range or other column-specific control. Filters open in the top layer so sticky headers and table overflow cannot clip them. Active filter buttons are highlighted. A hidden column's filter remains applied and is available by restoring that column with Columns.

Provide text search for lists of names, titles or jobs. Choose filters that answer a concrete question: job status/provider, new versus already imported preview rows, playlist source or import status, watched films, or subscription kind/history. Import previews must let users hide existing items; omit that filter when the preview already excludes them, as NFO previews do. Show matching counts; local previews can use `matching of total`. Preserve navigation filters such as Tags and Hidden tags. Active facet chips belong above the toolbar. A three-column summary needs neither a chooser nor redundant search controls.

Selectable tables have a tri-state checkbox in the first header. It selects eligible matching rows in a complete local dataset, or eligible loaded rows in a paginated server list; its accessible label states the scope. Disabled/ineligible rows stay excluded. Unchecking clears the selection. Do not add separate Select all, Select loaded, Select all importable or Clear selection buttons.

Wrap selectable tables in `SecondaryTableFrame`, with `SecondaryTableScroll` followed by `SecondaryTableFooter`. Put selection counts, row actions and their confirmations in this attached footer, outside the scroll area. It uses a dark slate background with white text and controls. Preserve action review, queue limits and running-job safeguards. Table-wide actions stay above the toolbar; inline row-specific links and disclosure controls can remain in their cells.

Secondary workspaces, including Playlists and Film Collections, always fill the available content width. Do not impose a reading-width cap or allow a flex child to shrink to its intrinsic table width. The table takes the remaining page height and scrolls internally; the toolbar and action footer remain available.

## Row density and cell details

Ordinary rows use one line of content. Use the shared `SecondaryCell` wrapper for clipped text and a bounded layout; long titles, names, identifiers, descriptions and result messages must not increase a row's height. A deliberately chosen two-line cell is the maximum exception. Keep artwork and controls within the same row height, and keep action groups on one line.

Keep the primary value readable in the row: a short status, title or result summary. Supply the full text for its tooltip. Put explanations, match strategies, import timestamps and counts, errors, warnings and field-by-field changes in the shared circled Info details popover. Do not show a details icon when it only repeats fully visible text. Clipped text may expose its full value; warnings use a warning triangle instead of Info. The popover must work on hover, keyboard focus and click/tap, escape the table's clipping, and remain readable without changing row height. Keep links and actions usable inside details; do not replace an action with inaccessible clipped text. Icon-only buttons require an accessible label and a tooltip.

Job rows follow the same compact policy. Their explicitly expanded detail row uses `secondary-table-detail-row` and remains unrestricted so diagnostics, actions and stored data are still usable. Loading, empty and error rows also retain enough space for their message and retry control. Do not apply the row limit to these disclosures or to Browse.

## Components

`SecondaryDataTable` is for complete datasets already in memory. Define each column's raw `value` separately from its optional formatted `render`. Supply a stable row key and default sort. Its optional `search` supplies a label, placeholder and searchable row value; each column can supply a `filter` control, and callers apply those filters before passing `rows`. Use `countLabel` for the result-count noun and `totalCount` when reporting the original total of a filtered dataset. It renders the shared toolbar automatically and omits it when there are no useful controls or count.

Tables with custom selection, server pagination or expandable rows compose `SecondaryTableToolbar`, `SecondaryTableScroll`, `SecondaryTableHead` and `useTableColumns`, adding the frame/footer for selection. Pass search, count and `useTableColumns().controls` into the toolbar, and column filters into the matching header. Use the existing shared table primitives for rows and cells. The column control is a native popover, closes on Escape/outside click and restores focus to its trigger on Escape.

Do not change the base `Table` or Browse styles to achieve a secondary-table change. Keep styling scoped to the shared secondary wrapper.

Detail drawers use `MediaInspector` for a shared remembered desktop width. Drag the left edge or focus its separator and use Left/Right, Home/End (Shift for larger steps). Phone drawers remain full width.

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

Inspect the whole page in the browser at desktop and phone widths, with filters, Columns and cell details open as well as closed. Use synthetic long titles, many identifiers, verbose errors, multiple warnings and large change sets, then measure ordinary row heights; they must remain within the chosen one- or two-line limit. Check full workspace width, control order and height, Columns at the upper right, attached footer contrast and visibility, table scrolling and menu clipping; isolated component markup does not catch styles inherited from page ancestors. Verify column persistence, reset, Escape/outside dismissal and restored focus. Verify multi-value filters, eligible header selection and clearing, and drawer resizing/persistence with pointer and keyboard. Confirm full text and actions remain accessible after clipping, and expanding a job still reveals its complete diagnostics. Sorting, filtering, hiding columns and opening stored details must never scrape, import, retry or play anything.
