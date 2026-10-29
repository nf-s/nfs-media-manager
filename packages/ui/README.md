# `@repo/ui`

## Compact Tables

Use `Table` and its header/row/cell primitives, or `compact-table` on an existing native table. Both share compact padding, sticky headings, subtle row dividers, hover/selection states and checkbox sizing. Add `scope="col"` to native headers, `table-selection-cell` to checkbox cells and `data-selected={selected || undefined}` to selected rows.

`Table` includes a keyboard-focusable `TableScroll` wrapper; use `containerClassName` to size it. Existing native tables can use `TableScroll` directly, with an accessible region label. Do not nest scroll wrappers. `table-scroll-bounded` caps history tables at 420px or half the viewport. Full-height lists can use `table-workspace` with a direct `table-scroll` child; keep controls outside the scroll region.

Use `TableState` inside `tbody` for loading, empty and error messages, with the actual column count. Pass `error` for an alert and render retry controls as children. Keep existing data visible during background refreshes and subsequent-page errors.

Web film selection and detail job history load additional pages through `useInfiniteTableScroll`, rooted in the table's scroll container. Manual load/retry controls remain as a keyboard and unavailable-observer fallback. Sorting/filter changes reset scrolling; loading more rows never selects or queues them. The virtualized media browser retains its separate fixed-height geometry and windowed data loading.
