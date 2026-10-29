# Details, edits and history

## Requirements

- DETAIL-01: Overview is immediately useful: art, creators, release, source/status, service links, tags, synopsis and key metrics. Important information is not nested in collapsed sections. Use concise tabs: Overview, Tracks (albums), Edit, History. Full raw payloads are collapsed within History only.
- DETAIL-02: Open from grid/table without discarding browse context; direct links work. Clicking creator/tag/source metadata filters the parent library and closes the panel. Closing restores focus and scroll.
- DETAIL-03: Canonical title, art, source and supported album/film fields can be overridden without overwriting provider snapshots. Show saved/error states and refresh list/detail after saving.
- DETAIL-04: Provider identifier correction is distinct from a canonical field override. Re-scrape uses the corrected identifier. Record actor/time/reason; allow clearing an override to reveal the underlying value.
- DETAIL-05: History lists timestamp, provider, provenance, status and payload inspection. Every distinct imported/scraped payload is retained. Reimporting an identical source payload is idempotent; do not erase old history.
- DETAIL-06: A single-item re-scrape requires choosing an executable provider and gives immediate job/progress feedback. No action fires on mount, on viewing history, or on saving a filter.
- DETAIL-07: Filterable detail values use the same compact pill treatment, including creators, source and watched status. Active pills share Any / Required / Removed colors and behavior with browse filters. Shift-click keeps the page/modal open for adding multiple filters. Do not repeat funnel icons on individual values in details, tables or grids.
- DETAIL-08: Tag and collection labels remain filters. An adjacent source control opens a collection directly in a new tab when its saved ID/link is known, or opens original tag provenance. Tag sources include merged originals, distinguish origins attached to this item from those merged elsewhere, and paginate without hiding sources after the first preview. Escape closes source details without closing the film/album modal. Missing IDs/URLs are stated explicitly, never guessed from aggregator identifiers.

## Acceptance

Open, edit, inspect history, return to the same scroll location, then deep-link and reload. Test errors and empty history. Mock job execution for corrected identifiers. Verify important content is visible without expanding JSON and raw credentials never appear in history or browser responses.
