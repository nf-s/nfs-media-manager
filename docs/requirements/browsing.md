# Browsing and navigation

## Existing behaviour

`Browser.tsx`, `ImageGrid.tsx`, `TableGrid.tsx`, `SelectedRowOverlay.tsx`, `ColumnState.ts`: library switcher, table/grid toggle, count, sorting and column picker share a toolbar. Preferences are stored separately per library. The table has 35px rows, resizable columns, sortable headings and double-click details. The grid loads groups of 100 near the viewport, uses square album art and portrait film posters, and shows title, creator, release and the current sort metric. Details open above the still-mounted list.

## Requirements

- BROWSE-01: Albums and films each support table and image-first grid. No hero banners, explanatory paragraphs, gradient surfaces or nested bordered cards. Text is high contrast; dividers are subtle. Tags may be pills.
- BROWSE-02: Keep library navigation, universal search, sort direction, view toggle and result count close together. Advanced range/column controls are popovers, not permanent dashboard panels.
- BROWSE-03: Grid and table reserve the full matching result height as soon as the total is known. Scrollbar jumps load only the viewport/overscan pages, never every intervening page. Keep the first page for the total and only the active window in cache; cancel obsolete requests and discard their results. Reset on any query change, including same-count results. Use stable ordering with an ID tie-breaker. Show a retry action for failed windows without collapsing their reserved space.
- BROWSE-09: Unloaded slots retain their exact row/card geometry with a subtle wipe skeleton, disabled under `prefers-reduced-motion`. DOM and page cache must remain bounded during long sessions. Scrolling must stay inside the fixed shell; keyboard scrolling, responsive grid columns, column resizing and modal return position remain usable.
- BROWSE-04: Table headings remain visible; rows are compact and columns independently selectable, resizable and saved per library. Horizontal scrolling must not widen the whole page. Long values truncate without losing access to their full content.
- BROWSE-05: Grid cards contain artwork, title, artist/director and concise release/sort information. Missing or failed art has a visible fallback and never removes a record. External links remain available without opening details.
- BROWSE-06: Selecting an item opens an accessible detail panel. Close, Escape and browser Back preserve query, loaded rows and scroll. A direct detail URL remains usable. Keyboard focus returns to the trigger.
- BROWSE-07: Persist view, columns, sorting and filters independently for albums and films; URL state wins over stored defaults. Mobile controls wrap sensibly, cards shrink to at least two columns, and touch actions do not depend on hover.
- BROWSE-08: Loading, errors, empty results and completed pagination are explicit. No blank infinite spinner. Show filtered total, not just currently loaded count.
- BROWSE-10: Grid density is configurable and saved independently per library. Compact mobile cards prioritize artwork and legible title/artist information, with touch-accessible details and outbound links. Changing density recomputes virtual row geometry without unbounded loading, overlap or horizontal page overflow. Album titles linked to Spotify must not be accompanied by a duplicate Spotify action in the same card or detail heading.

## Acceptance

Jump directly from the first page to near the end in grid and table: verify only nearby pages are requested, the scrollbar height is unchanged, and the last partial row has no invented items. Scroll rapidly and change filters while requests are pending; stale results must never enter the new view. Verify bounded DOM/cache, zero results, retry after an error, reduced motion, and opening/closing an item without losing position. Test 390px and desktop widths, keyboard-only navigation, column resize, rating links and failed artwork.
