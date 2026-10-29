# Films

## Existing behaviour and data

`Models/Movie.tsx`, `movie/clean.ts` and the current cleaned library provide title, source, poster, synopsis, awards, directors, actors, writers, countries, languages, production companies, tags, collections, watched state and external links. Numeric fields are release date, personal IMDb rating, IMDb rating/votes, Metascore, TMDb rating/votes/popularity, Rotten Tomatoes rating, runtime, budget and box office. Local plugins may contribute additional ratings/votes and collections. Default order is release descending.

## Requirements

- FILM-01: Import all 2,640 visible films and reconcile 2,958 raw entries without losing snapshots. Preserve identifiers, source hints, owned status, watched/rating/watchlist state and private metadata. Raw duplicate records must not erase fields from another record.
- FILM-02: Source filters preserve the original categories and counts. Ownership/file sources take precedence over discovery/watchlist sources unless the cleaned input or a manual override says otherwise. Do not treat every imported film as the same source or leave a known source blank.
- FILM-03: Every textual field is available in overview/metadata and clickable where filterable. Every numeric field above is available in column selection, sorting and ranges, even when absent from the default table. Private metrics are registered dynamically.
- FILM-04: IMDb/TMDb and plugin-supplied outbound links are available. Film cards remain poster-first; synopsis, cast and technical details do not overwhelm the browse grid.
- FILM-05: Preserve personal ratings without confusing them with public ratings. Display watched and bookmarked/watchlist information distinctly. Missing data is not zero or unwatched by inference.
- FILM-06: Added is available in sorting, table columns, date ranges and film details. NFO-backed films use the actual file creation timestamp (`birthtime`), never XML `dateadded`, modification/change time, or import time. Verified NFO creation time takes priority over other imported dates; manual overrides take highest priority. Preserve displaced dates and their provenance in history. Expose the NFO path in Overview. Repairing incorrect NFO provenance may move a date forward; other-source re-imports must not replace a verified NFO timestamp. Missing creation timestamps remain unknown rather than guessed. Historical repairs require a dry run, database backup, unique path/identifier matching, and transactional before/after history. If no historical evidence exists, the display may use the immutable database import time explicitly labelled original date unknown. Users can correct Added under Edit.
- FILM-07: Import TMDb and MDBList keywords without losing the original token, upstream source or identifier. Tags is one concept across genres and keywords: one filter, search, detail section and management view, including film selection. Original kinds are provenance only. Equivalent normalized names across kinds share counts and matches; old genre/keyword URLs remain compatible. Explicit global merges retain provenance and persist across subsequent imports. The Tags page shows actual merged names, previews the target before merging, and exposes paginated source links without opening a film. Do not automatically merge merely related concepts.

## Acceptance

Reconcile title, release date, source, watched, ratings, tags, credits and collections for every cleaned input row. Compare source-category counts. Inspect one film from each source category and films with private snapshots. Verify imported private links and source labels are data-driven, not hardcoded into tracked public files.
