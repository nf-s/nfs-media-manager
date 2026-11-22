# Track tags

Status: proposed, awaiting the owner. Nothing here is built. It answers SONO-15 in [Sonovault identifiers and track facts](sonovault.md) and follows the owner's decision of 2026-11-22: tracks get a tags field of their own holding Sonovault's genres and subgenres, the genre hierarchy takes the names it lacks, and a Tags filter can say whether it reads the track's, the album's or the artists' tags.

## What changes for the owner

- A track shows its own tags: the genres and subgenres Sonovault reported for it, and any the owner adds. The owner can add and remove them on the track; a later Sonovault refresh never brings back a removed tag or drops an added one.
- Tracks Browse gains a **Track tags** column and field. The **Tags** field, which today reads the album's tags (and the artists' when the album has fewer than two), puts the track's own tags first.
- The Filters drawer on Tracks and Albums gains a **Tag location** choice: Auto, or any combination of Track, Album and Artist. Auto is the default.
- Sonovault's genre names that have no place in the hierarchy are placed or merged in a separate stage, after the owner reviews the proposed mapping.
- Browse stays within its query budgets: every query added or changed below has a planned shape, measured timings, and a workload in the performance suite that fails the build if its plan regresses.

## Today

- **Album tags** are rows of `media_item_tag` (album, tag) on tags of the album library (`tag.media_type = 'album'`). Where each came from is recorded in `tag_occurrence` (provider, source, raw name). Names resolve through `tag_identity` and `tag_alias`; merges move memberships; a hidden tag is left out of Browse.
- **Artist tags** are not stored as memberships. They are read from the current artist profile snapshots (`artist_provider_snapshot.normalized_data->'tags'`, GIN index on `artist_profile_tag_keys`) and resolved to album-library tag names at read time.
- **The hierarchy** is one per library: `tag_parent` links normalised names and `tag_ancestor` holds every tag with each tag above it, rebuilt on each change. A filter on a tag matches every visible tag beneath it ([Tag hierarchy](../tag-hierarchy.md)). Artist tags use the album hierarchy.
- **Tracks have no tags of their own.** The Tracks fields are Tags (`genre`: the library album's tags, plus artist tags when the album has fewer than two visible tags, `artistTagFallbackThreshold`), Album tags (`albumTag`) and Artist tags (`artistTag`). The filter, sort, autocomplete vocabulary and row hydration are built on those (`browse.ts` `matchesValue`, `trackMusicFacetSources`; `music-tags.ts`; `tracks.ts` `loadTracks`). Track details group the album's and the artists' tags.
- **No item has hand-edited tags.** Tags are managed per library (merge, hide, parents); no route adds or removes a tag on one album or track, and a provider refresh would bring back any tag removed by hand.
- **The nearest example** of a per-track fact from Sonovault is tempo and key (stage 2, commit 86d73e9): `track_fact`, one row per track and provider with `verified`, the response and the fetch date; written by the lookup job and by `apply:sonovault-track-facts` from stored responses; Browse reads only verified rows through partial indexes (SONO-17); track details show every provider's values, an unverified record's marked as possibly another version.

What Sonovault returns: every track record carries a `genre` list and a `subgenre` list. In the stored responses nearly every record has one genre and about half have a subgenre or more; there are a couple of dozen genre names and under two hundred subgenre names, and no name appears in both lists. A subgenre is not tied to one genre: the lists are flat per track, and most subgenres appear beside more than one genre (Electronica beside Electronic, House and Dance), though each has one clearly dominant genre. Most names already exist as album tags in the hierarchy; a handful are spellings of existing tags, and about a dozen have no tag.

## Stage 1: Storage and backfill

- TTAG-01: A table `track_tag` holds one row per library track and tag: `media_item_id` (the library track), `tag_id` (a tag of the album library, so names, aliases, merges, hiding and the hierarchy apply to track tags as they do to album and artist tags), `sonovault` (Sonovault reported it), `verified` (from the reference, SONO-08), `response_id`, `fetched_at`, `owner` (`added`, `removed` or null) and `owner_changed_at`. A stored generated column `in_browse` is true for a row the owner added, or a verified Sonovault row the owner has not removed. Indexes: primary key `(media_item_id, tag_id)`; `(tag_id, media_item_id) where in_browse`; `(media_item_id) include (tag_id) where in_browse`; `(response_id) where response_id is not null`.
- TTAG-02: Each Sonovault name behind a row is also a `tag_occurrence` row (provider `sonovault`, source the response, raw name, kind `genre` or `subgenre`), so the existing sources popover and `GET /api/v1/tags/item-provenance` explain a track tag the way they explain an album tag. One tag can have two occurrences (a genre and a subgenre that resolve to the same tag).
- TTAG-03: `library_track.has_own_tags` is true when the track has a row in Browse whose tag is visible. It is maintained in the same transaction as every change to `track_tag`, and when a tag is hidden, shown or merged (for the tracks carrying it). It exists so that Auto (TTAG-21) never has to work out "has tags of its own" for every track on a request.
- TTAG-04: Owner edits. Adding a tag sets `owner = 'added'` (inserting the row if needed). Removing one sets `owner = 'removed'`; the row stays so a refresh cannot bring it back. Adding a removed tag again sets `added`. **Reset to Sonovault** on a track clears its owner marks. A Sonovault write changes only `sonovault`, `verified`, `response_id` and `fetched_at`; it never reads or changes `owner`.
- TTAG-05: Unverified records. Their tags are stored with `verified = false`. They are not in Browse, filters, sorts, counts or the autocomplete vocabulary. Track details list them separately, marked as possibly another version, as SONO-17 does for tempo and key. Adding one by hand makes it an owner tag.
- TTAG-06: Name resolution. A raw name resolves to a tag the way a provider album tag does (normalised name through `tag_identity` and `tag_alias`); a name with no tag creates a visible album-library tag outside the hierarchy, listed under **Tags → All → Outside the hierarchy**. A short Sonovault name map, kept in the provider code and reviewed in stage 4, resolves a name to a different tag first; it is for a name whose album tag of the same spelling means something else (stage 4 proposes one such name). `upsertProviderTags` is extended to library tracks rather than duplicated.
- TTAG-07: Backfill. `apply:sonovault-track-tags` (dry run by default, `--apply` to write) reads the stored Sonovault responses, finds each track record in a body (bulk result, single track or a release's track list), joins it to library tracks by their `sonovault-track` reference, and lets a later response replace an earlier one, as `applyStoredSonovaultTrackFacts` does. It makes no requests. A second run changes nothing. It writes in batches of at most 500 tracks per statement and reports the tracks, rows, verified share, names created and names placed nowhere.
- TTAG-08: New lookups record tags in the same write as tempo and key, for every matched record, verified or not. A track no longer found loses its Sonovault rows but keeps the owner's. This touches only the write step of the Sonovault track and album jobs, not how jobs are scheduled or rate-limited.
- TTAG-09: SONO-10 applies. Removing Sonovault's data deletes Sonovault occurrences, clears `sonovault` on every row and deletes rows left with no owner mark, in one bounded set of statements. The 11-month refresh rewrites Sonovault rows through TTAG-08.
- TTAG-10: Changes to `track_tag` mark the stored Tracks autocomplete vocabulary dirty through `mark_browse_cache_dirty`, with any statement that joins transition tables run through `EXECUTE`. They do not touch the recording order or the possible-duplicate groups.

Done when: the migration and backfill run on a disposable database with invented responses (integration tests cover verified, unverified, owner added and removed, refresh, removal and a re-run); the dry run on production reports counts the owner has seen; the apply has run; Browse is unchanged; the performance suite passes.

## Stage 2: Showing and editing track tags

- TTAG-11: Track details get a **Track tags** group first, before Album tags and Artist tags, with the existing filter pills and sources popover. Each pill opens Tracks filtered on that tag at the Track location. Unverified Sonovault tags follow under their own label, marked as possibly another version. Tags the owner removed are listed with **Restore**.
- TTAG-12: **Edit tags** on that group adds a tag through the existing tag picker (album-library tags, with the option to create one) and removes one with the pill's remove control. Routes: `POST` and `DELETE /api/v1/tracks/{id}/tags` with a tag ID, and `POST /api/v1/tracks/{id}/tags/reset`, each validated with the shared schemas and calling the stage 1 service.
- TTAG-13: Tracks Browse gains the field `trackTag`, **Track tags**: column, sort, filter, autocomplete and URL state through the shared Tracks Browse pattern, like Album tags and Artist tags.
- TTAG-14: The **Tags** cell, list row and card line show the track's own tags first, then the album's and artists' tags as today, without repeats (`musicDisplayTags` gains a `track` source). The sources popover of each pill says where it came from.
- TTAG-15: **Tags → All** and a tag's details show a Tracks count (tracks carrying the tag themselves) beside the albums count, and link to Tracks filtered at the Track location.

Every element here is an existing component: filter pills, the sources popover, the tag picker, the pill's remove control, link buttons, the one table.

Done when: the screens are checked in a browser at desktop and phone widths on a disposable database with synthetic data against the design library's Browse and Detail pages; the Track tags workloads in the performance suite pass on PostgreSQL 17 and 18.

## Stage 3: Filtering by tag location

### Locations

- TTAG-20: A Tags filter reads one of: **Auto**, or any non-empty combination of **Track**, **Album** and **Artist**. The location applies to every Tags filter in the view and to the counts of the Tags suggestions. Album tags, Artist tags and Track tags stay fields of their own, so a single filter on one level is still possible beside the location.
- TTAG-21: **Auto** (the default). For each tag in the filter, a track matches when its own tags match the tag. If they do not, the track is judged by its album's tags (and its artists' tags when the album has fewer than two, as today) when either the track has no tags of its own, or the tag is not one Sonovault gives tracks: neither the tag nor anything beneath it in the hierarchy is a Sonovault name on any track.
  - Why not "own tags replace album tags": Sonovault gives each track one to three genre names from a small vocabulary; an album carries a dozen tags from a much larger one. On the stored responses, most album tags of a Sonovault-tagged track are names Sonovault never uses, so "own tags only" would drop nearly every tagged track from a filter on such a tag (Microhouse, Hypnagogic Pop) although Sonovault says nothing about it. With the rule above, a track's own tags decide only the tags Sonovault speaks to: a filter on Deep House finds the tracks Sonovault calls Deep House, not every track of an album tagged Deep House, while a filter on Microhouse behaves as today.
  - An owner tag counts as one of the track's own tags but does not change which tags Sonovault speaks to, so adding one tag by hand to one track never changes how a filter treats the rest of the library.
- TTAG-22: **Explicit locations.** With Auto off, a track matches a tag when any ticked level has it: the track's own tags (Track), its library album's tags (Album), its credited artists' tags (Artist; every artist tag, without the two-tag rule). Track and Album is "on the track or on its album"; all three is "anywhere".
- TTAG-23: **Albums** get the same control with the same meaning one level up: Auto is today's rule (album tags, the artists' when the album has fewer than two); Album, Artist and Track (an album with a track carrying the tag) can be ticked. **Artists**, **Films** and **Mixes** have one level of tags and do not show the control.

### Interactions

- TTAG-24: Modes. Required, Any and Exclude work per filter as today over the chosen location: Exclude removes a track whose location matches the tag. Ranges, listening filters and search words are unaffected.
- TTAG-25: Hierarchy. A tag matches itself and every visible tag beneath it, at every level, resolved once per statement. Hidden tags are left out at every level; an explicit filter on a hidden tag still matches it.
- TTAG-26: URL and saved views. `tagLevels` holds the location: left out for Auto, otherwise a comma-separated list in the order track, album, artist. Saved views store it. An unknown value is a 422 at the boundary.
- TTAG-27: AI search. The field list and prompt describe Tags with Auto, the three single-level fields, and `tagLevels`; a request that names a level ("tagged house on the track itself", "albums by artists tagged …") sets it; otherwise Auto. Validation accepts only the values in TTAG-26.
- TTAG-28: Sorting by Tags orders by the first tag at the chosen location (own tags first for Auto). Sorting by Track tags orders by the first own tag.
- TTAG-29: Suggestions. The stored Tracks vocabulary keeps counts for Auto, Track, Album and Artist; a combination counts live only the suggestions shown (at most the suggestion limit, per typed prefix). Albums keep live aggregation as today.

### The control

The Tag location control is new interface, so it waits for the owner's choice among the concepts in the design library: [`concept-tag-location.html`](../design-system/concept-tag-location.html). Option A, a **Tag location** section in the Filters drawer with **Auto: most detailed** and the Track, Album and Artist checkboxes, is recommended. The accepted option goes into the design system (styles, React component, rules on the components page) before the stage uses it, and the concept page is deleted.

Done when: every location, mode and sort above is covered by integration tests on synthetic fixtures; the stage 3 workloads pass on PostgreSQL 17 and 18; Tracks and Albums are checked in a browser at desktop and phone widths, including URL round trips and a saved view; AI search maps the three examples in TTAG-27.

## Stage 4: Genre hierarchy

- TTAG-30: Sonovault's names are placed with the existing plan tooling (a plan file of merges, parents and hides applied with `--keep-links`, which writes a backup first), after the owner has reviewed the full proposed mapping. Until then they are visible tags outside the hierarchy, and filters on them work.
- TTAG-31: For each name the mapping says one of: **keep** (already a tag in the hierarchy, or joined by an existing merge), **merge** into an existing tag with a similar name, **new** tag under a named parent, or **map** (TTAG-06's Sonovault name map, where merging would change albums). It also lists names whose place in the hierarchy differs from the genre Sonovault pairs them with; those keep the hierarchy's place unless the owner adds a second parent.
- TTAG-32: The owner can change the mapping later in **Tags** as for any tag; nothing in stages 1 to 3 depends on it.

An invented example of the mapping:

| Sonovault name | Kind     | Today                                    | Proposal                                         |
| -------------- | -------- | ---------------------------------------- | ------------------------------------------------ |
| Deep Current   | subgenre | in the hierarchy under Current           | keep                                             |
| Drum & Wire    | genre    | spelling of the tag Drum and Wire        | merge into Drum and Wire                         |
| Peak Hour Tide | subgenre | no tag                                   | new, under Tide                                  |
| Harbour        | genre    | hidden album tag Harbour (another sense) | map to Harbour Bass; the hidden tag is untouched |
| Glass Pop      | subgenre | under Pop; Sonovault pairs it with Glow  | keep; a second parent Glow is optional           |

Done when: the plan's check run lists exactly the reviewed changes, the apply has run with its backup, and Tags → All → Outside the hierarchy no longer lists the Sonovault names the owner placed.

## Query performance

Browse has gone wrong repeatedly, and always the same few ways ([Library query performance](../query-performance.md)): a lookup added before a Browse statement; a scalar subquery that hid a parameter from the planner; per-row probes or anti-joins that multiplied into millions of rejected comparisons; a trigger statement planned once for a one-row write and reused for a bulk one; work done on a request that belonged in maintenance. These rules hold for every stage:

1. A Browse page, count or suggestion read is one statement. Nothing is looked up before it.
2. Tag names, aliases and descendants are resolved to tag IDs once per statement, before any membership is joined.
3. A membership test on a page is either a set read first from one index (a single level) or a hashed set tested while walking the sort order (`coalesce(id in (…), false)`, as the Tags filter does today). A plain `id in (select … from track_tag …)` on a page is not allowed: the planner may turn it into a semi-join that probes the tag rows once per track in sort order. On two loads of the same synthetic library that one query planned as 0.1 ms or 381 ms and 488,000 shared blocks for a rare tag.
4. "Has tags of its own" is a stored column (TTAG-03), never computed per request.
5. Unverified and owner-removed rows are excluded by the partial indexes' predicate (`in_browse`), not by a filter after the read.
6. Vocabulary builds run in scheduled maintenance, never on a request; writes are batched; trigger statements that join transition tables run through `EXECUTE`.
7. Hydration reads only the returned page's IDs.

### Query shapes

`k` below is the resolved tag set: the tag's own row and its visible descendants, read through `tag_ancestor` and the `(media_type, normalised name)` index, as `matchingTagNames` does now. `today(k)` is the existing Tags condition (album tags; artist tags on albums with fewer than two).

| Query                               | Shape                                                                                                                                                                                       | Index                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Track location only: page and count | `matched as materialized (select distinct media_item_id from track_tag where in_browse and tag_id in k)`, joined to the page's sort columns                                                 | `(tag_id, media_item_id) where in_browse`, index-only          |
| Auto: page, count, exclude          | `coalesce(lt.id in (track_tag where in_browse and tag_id in k), false) or ((not lt.has_own_tags or not exists (Sonovault row with tag in k)) and today(k))`                                 | as above; the `exists` is one probe per statement              |
| Explicit combinations               | `or` of the hashed tests per ticked level: track as above, album `coalesce(lt.album_media_item_id in (media_item_tag where tag_id in k), false)`, artist as `mediaIdsWithArtistTag`         | as above; `media_item_tag_tag_media_idx`; the artist GIN index |
| Sort by Tags or Track tags          | order rows: `min(name)` per track over `track_tag join tag where in_browse and not hidden`, read once per statement                                                                         | `(media_item_id) include (tag_id) where in_browse`             |
| Hydration of a page                 | `track_tag join tag where media_item_id = any(page ids) and in_browse and not hidden`                                                                                                       | `(media_item_id) include (tag_id) where in_browse`             |
| Stored vocabulary (maintenance)     | own rows plus inherited rows for tracks without own tags or tags Sonovault does not use, expanded by `tag_ancestor`, grouped by album and credited artists as `trackMusicFacetSources` does | sequential reads; no request waits on it                       |
| Suggestions for a combination       | counts for the shown suggestions only, each through the page shape's count                                                                                                                  | as the page                                                    |

### Storage designs compared

Measured on a disposable PostgreSQL 18 (and 17 for plan shapes) with an invented library of 80,000 tracks, all of them tagged (about two tags each, a tenth unverified, a few owner edits), a few thousand albums with about a dozen tags each, a few thousand tags (some hidden) and a hierarchy in which the broad tag has several hundred descendants. Tags: broad (half the tracks with its descendants), narrow (under a thousand) and rare (none or one). Median of five warm runs; database execution only.

| Workload (Title sort, first 100)            | A: join table, hashed tests | A: join table, set first | B: array column with GIN |
| ------------------------------------------- | --------------------------- | ------------------------ | ------------------------ |
| Track only, broad / narrow / rare           | 59 / 15 / 3.5 ms            | 59 / 8 / 0.2 ms          | 97 / 10 / 0.2 ms         |
| Auto, broad / narrow / rare                 | 106 / 31 / 44 ms            | 204 / 35 / 28 ms         | 480 / 37 / 29 ms         |
| Auto, page 200 (offset 20,000), broad       | 129 ms                      | 234 ms                   | 735 ms                   |
| Track or album, broad / narrow / rare       | 88 / 20 / 15 ms             | 212 / 12 / 1.4 ms        | 472 / 8.5 / 136 ms       |
| Largest shared-block read in the rows above | 5,764                       | 199,634                  | 218,646                  |
| Sort by first track tag                     | 80 ms                       | —                        | 3,449 ms                 |
| Hydrate a page of 100                       | 1.0 ms                      | —                        | 0.8 ms                   |

The existing Tags filter on the same data took 93 / 34 / 29 ms (broad / narrow / rare), so Auto costs about what Tags costs now. B's weakness is the test for "has visible tags of its own" (the array against the hidden tags) and anything that unnests the array per row; it also has to be rewritten whenever a tag is hidden or merged. Without the `has_own_tags` column, A's Auto took up to 158 ms.

**Recommended:** design A, the `track_tag` join table with the two partial covering indexes and `has_own_tags`; set first for a single level, hashed tests for Auto and combinations.

### Budgets and the acceptance check

- Foreground budgets stay those of [Library query performance](../query-performance.md#continuous-production-monitoring): p95 750 ms for a Browse page, 1,000 ms for an exact count, 500 ms for suggestions. On the synthetic fixture above, database execution for any tag-filtered page or count stays under 150 ms.
- `apps/server/integration/track-query-budgets.performance.ts` gains, for Tracks and for Albums, one workload per combination of location (Auto, each level, Track and Album, all three) × tag (broad with descendants, narrow, rare, absent) × Title and Added sorts, plus Exclude, a deep page, Sort by Tags, hydration and suggestions. Each asserts: one statement; shared blocks at most 1.5 × the value measured on the suite's fixture when the workload is added; no temporary blocks; the expected rows.
- Each tag page workload also asserts its plan: the `track_tag` read is an index-only scan of the partial index or a hashed SubPlan, and no nested loop probes `track_tag` once per track. The rare-tag workloads are there to catch the semi-join of rule 3.
- The suite runs on PostgreSQL 17 and 18 in the Query performance workflow on every push, so a regression fails the build. A budget change needs the old and new measurements and a reason, as now.
- After each stage's release, Tracks and Albums Browse pages with a Tags filter are compared with the previous window by route and query shape (`browse.filterFields` gains the location), median and p95 with sample counts.

## Stages

| Stage                    | Depends on                    | Files it owns                                                                                                                                                                           | Can run beside                |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1. Storage and backfill  | —                             | migration, `schemas/db.ts`, a new `services/track-tags.ts`, `tag-state.ts`, `tags.ts` (hide and merge), the backfill script, the Sonovault write step                                   | the concept decision; stage 4 |
| 2. Showing and editing   | 1                             | `tracks.ts`, track routes, `packages/schemas` track and browse fields, `browse.ts` (`trackTag` field), `track-detail.tsx`, `track-browse-cells.tsx`, tags pages                         | stage 4                       |
| 3. Filtering by location | 2; the owner's concept choice | `browse.ts` (Tags, Albums), `music-tags.ts`, facet maintenance, `packages/schemas/browse.ts`, `ai-search.ts`, the new design-system component, `track-browser.tsx`, `media-browser.tsx` | stage 4                       |
| 4. Genre hierarchy       | 1; the owner's mapping review | a plan file and its apply run; no repository code                                                                                                                                       | stages 2 and 3                |

Stages 2 and 3 both change `browse.ts` and the Tracks web screens, so they run one after the other. Adding the accepted Tag location component to the design system (`packages/ui`, `docs/design-system`) can run beside stage 1 or 2.

## Decisions for the owner

1. **Auto.** Recommended: TTAG-21 as written (own tags decide the tags Sonovault speaks to; the album and artists decide the rest). The alternative is "own tags replace the album's", which drops nearly every tagged track from filters on album-only tags.
2. **The Tag location control.** Recommended: Option A in [`concept-tag-location.html`](../design-system/concept-tag-location.html).
3. **Unverified Sonovault tags.** Recommended: kept out of Browse and shown in track details, as SONO-17 does for tempo and key.
4. **The hierarchy mapping** (stage 4) can wait; the proposal is ready for review whenever the owner wants it.
