# Search, filters and sorting

## Existing behaviour

`FilterSelect.tsx` indexes every filterable value using substring search, displays field/value/count, retains input after selection and supports multiple chips. Clicking a chip cycles include, exclude, intersection. Normal includes are ORed globally; required intersections, exclusions and numeric ranges are ANDed. Array membership and scalar equality both work. `SortSelect.tsx` covers every sortable column and reverses the current choice; numeric fields provide range filters, with an include-missing policy. `VisibleColumnSelect.tsx` persists selected columns.

## Requirements

- SEARCH-01: One autocomplete finds titles, artists/directors/cast/writers, genres/tags, countries, languages, production companies, sources, watched state, collections, playlists and providers. Suggestions have field labels and whole-library counts; they must not be limited to the first loaded page. Free-text search is also supported.
- SEARCH-02: Metadata clicks add the exact corresponding filter. Each chip can be removed and explicitly changed between Any (OR), Required (AND), and Exclude (NOT). Preserve old semantics, including cross-field OR. Labels, not colour alone, identify modes. Prevent duplicate chips.
- SEARCH-03: Numeric and date ranges are available in both table and grid. Bounds are inclusive; missing values have a separate checkbox. Clear each range or all filters. No conversion of missing values to false zeroes except the documented scrobble default.
- SEARCH-04: Every old numeric metric and sortable text column appears in sorting. Ascending/descending is explicit. Missing values go last in both directions; ties resolve by canonical ID. Grid displays the selected metric when it is not already visible.
- SEARCH-05: Persist text, numeric filters, sort and direction; preserve them through details, back navigation and reload. URL parameters are validated. Autocomplete supports arrows, Enter, Escape, clear and accessible names.
- SEARCH-06: Numeric metrics supplied by local plugins use the same controls without hardcoded provider names in public code.

## Acceptance

Compare results with old `applyFilters` on fixtures: two includes in different fields, required/excluded tags, empty filter set, scalar/array fields, range endpoints and missing numbers. Test suggestions for source, title and creator, including a value outside the first page. Check every metric from the music and film requirements is selectable.
