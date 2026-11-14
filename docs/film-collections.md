# Film collections

Choose **Films → Collections** to browse stored collections and the number of their films in the library. Search by collection name, sort the data columns, and use **Columns** to show the collection's Added date. That date is when the collection was first stored locally.

Open a collection to view its films in **Stored position** order. Positions come directly from stored collection membership; missing films are not fetched or inserted and gaps are not renumbered. Equal positions use title and internal ID as stable tie-breakers. Older legacy imports can contain the index of the collection on a film rather than the film's upstream rank, and providers can omit ranks (stored as zero). Those records cannot reconstruct a source order that was never saved. Browsing collections does not scrape providers or modify membership.

Each film links to its existing detail view. All data columns can be sorted in either direction; **Columns** also exposes artwork, source and Added. Changing sort orders the complete collection before pagination. Choose Stored position ascending to restore the stored order. Counts include only library films, even if a historical collection also contains album memberships.

`GET /api/v1/collections` returns stored collections containing films. `GET /api/v1/collections/:id` returns the collection and paged films, with `sortBy`, `direction`, `page` and `size` (up to 100). Both require owner authentication. The existing `playlist` and `playlist_item` tables hold collections; no migration or rescrape is required.

Verification uses synthetic collections in a disposable database, with network access blocked. Coverage includes gaps, equal positions, film-only counts, complete-dataset sorting before paging, missing data, invalid queries and authentication.
