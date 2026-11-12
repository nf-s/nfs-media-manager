# Details, edits and history

## Requirements

- DETAIL-01: Overview is immediately useful: art, creators, release, source/status, service links, tags, synopsis and key metrics. Important information is not nested in collapsed sections. Use concise tabs: Overview, Tracks (albums), Edit, History. Full raw payloads are collapsed within History only.
- DETAIL-02: Open from grid/list/table without discarding browse context; direct links work. Clicking creator/tag/source metadata filters the parent library and closes the panel. Closing restores focus and scroll.
- DETAIL-03: Canonical title, art, source and supported album/film fields can be overridden without overwriting provider snapshots. Show saved/error states and refresh list/detail after saving.
- DETAIL-04: Provider identifier correction is distinct from a canonical field override. Re-scrape uses the corrected identifier. Record actor/time/reason; allow clearing an override to reveal the underlying value.
- DETAIL-05: History lists timestamp, provider, provenance, status and payload inspection. Every distinct imported/scraped payload is retained. Reimporting an identical source payload is idempotent; do not erase old history.
- DETAIL-06: A single-item re-scrape requires choosing an executable provider and gives immediate job/progress feedback. No action fires on mount, on viewing history, or on saving a filter.
- DETAIL-07: Filterable detail values use the same compact pill treatment, including creators, source and watched status. Active pills share Any / Required / Excluded colors and behavior with browse filters. Shift-click keeps the page/inspector open for adding multiple filters. Do not repeat funnel icons on individual values in details, tables or grids.
- DETAIL-08: Clicking a tag or collection label filters; its adjacent source control never filters. Open a single known collection link directly. Otherwise show a compact popover of relevant, deduplicated links; opening sources reads stored evidence only. Manage tag shows aliases and paginated provenance, distinguishing item origins from those merged elsewhere. Escape closes the nested surface and restores focus without closing media details. Never guess upstream IDs.
- TAG-01: Counts, aliases, merges, provenance and visibility belong to one library. Hide removes a group from display and autocomplete, not stored membership or existing explicit filters. Reimports preserve visibility; a merge involving a hidden group stays hidden until explicitly unhidden. Manage hidden groups separately, with loaded-row and Shift-range selection. See [tag and collection sources](../tag-source-navigation.md).

## Acceptance

Open, edit, inspect history, return to the same scroll location, then deep-link and reload. Test errors and empty history. Mock job execution for corrected identifiers. Verify important content is visible without expanding JSON and raw credentials never appear in history or browser responses.
