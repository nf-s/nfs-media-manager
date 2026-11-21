# Library merge handover

A record is made of scrobbled names and Spotify versions. Tracks, albums and artists share one **Merge**, a review that opens only when something speaks against the merge, and one journal: every change, made by the owner or by an automatic rule, is a History entry with **Undo** and **Redo**. Scrobbles belong to scrobbled names, and names follow the record above them. Spotify tracks and albums are never deleted by a merge: they become versions of a track or editions of an album. A Last.fm-only track that is merged gives up its names and is archived and removed.

What the owner sees is described in [merging and history](tracks-and-playlists.md#merging-and-history) and [artist merges](artists-and-people.md#merging-artists).

## What is built

| Stage | Contents                                                                                                                                                                                                                                                                                               | State                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | The change journal with Undo and Redo for every move of a scrobbled name by hand. **Merge** from the Tracks table and an artist's Tracks table, with the review when unsure. **Tracks → History** and **Changes** in a track's Sources.                                                                | Built. See [merging from a table](tracks-and-playlists.md#merging-from-a-table) and [History and Undo](tracks-and-playlists.md#history-and-undo).                                                               |
| 2     | Stored versions: two tracks that each have a Spotify track, an album position or a playlist entry become one record, and moving album positions and playlist entries can be undone. **Made of**, **Shown** and **Separate** in a track's Sources, **Merge with…**, and Merge in an album's track list. | Built. See [versions](tracks-and-playlists.md#versions) and [merging in an album's track list](tracks-and-playlists.md#merging-in-an-albums-track-list).                                                        |
| 3     | **Possible duplicates** as a grouped view of the Tracks table, with **Merge** and **Keep separate** per group, the stored decision to keep records apart, and a notice on the track page.                                                                                                              | Built. See [possible duplicates](tracks-and-playlists.md#possible-duplicates-and-keep-separate).                                                                                                                |
| 4     | Albums and artists: the same Merge, review and History for both. Album editions and moving a scrobbled album name, artist kept names, and the names that follow a track, album or artist merge.                                                                                                        | Built. See [albums and editions](tracks-and-playlists.md#albums-and-editions), [what follows a merge](tracks-and-playlists.md#what-follows-a-merge) and [artist merges](artists-and-people.md#merging-artists). |
| 5     | Automatic matches written to the journal with their rule, so they can be undone, and an undone match is not made again.                                                                                                                                                                                | Built. See [automatic matches in History](tracks-and-playlists.md#automatic-matches-in-history).                                                                                                                |

## How it is put together

- **Journal.** `library_change` holds each change with its kind (`track`, `album`, `artist`), action, actor, rule, batch and `details` (counts of the parts it moved besides track names, and up to five labels). `library_change_move` holds the names it moved, `library_change_removal` the archive of every track it removed, and `library_change_effect` its other effects in order. `library_change_batch` groups the changes of one automatic run. [Journal service](../apps/server/src/services/library-changes.ts)
- **Effects.** Anything a change does besides moving names is an effect with a stored type, a before and after image, a blocker and an apply step, defined with `defineChangeEffect` and registered in [`library-change-effects.ts`](../apps/server/src/services/library-change-effects.ts). Undo runs the effects in reverse and Redo forwards, under the writer lock. A blocker says in plain words why Undo or Redo is refused, for example that a later change moved the same parts. An effects module must not import `library-changes.ts`; the existing modules load recount and relink code with dynamic imports for that reason.
- **Versions.** `library_track.version_group_id` and `version_shown` store which tracks are versions of one record and which one the row is shown as. Worked-out groups (same title, artists and recording code) still apply where nothing is stored; showing a version of a worked-out group stores the group first. Each owned name also links to the other versions of its record with the `record` strategy, so every version counts the record's scrobbles. [Track versions](../apps/server/src/services/track-versions.ts) · [Version effects](../apps/server/src/services/track-version-effects.ts)
- **Possible duplicates.** Groups are stored in `track_duplicate_group` and `track_duplicate_member`, with the title keys in `track_match_key`. Triggers from migration `0057` mark them dirty in `track_duplicate_dirty`; the five-minute maintenance of the Worker and of the Node job worker rebuilds them when marked, and merges, Keep separate and Undo or Redo refresh the groups around the tracks they touched in the same transaction. [Duplicates service](../apps/server/src/services/track-duplicates.ts) · [Grouping](../apps/server/src/services/track-duplicate-refresh.ts)
- **Stored decisions.** `library_keep_separate` holds Keep separate. `library_match_rejection` holds the matches an automatic rule may not make again: those undone, and those the owner separated. Merging records that were kept separate clears the decision as an effect, so Undo restores it. [Keep separate](../apps/server/src/services/keep-separate-effects.ts) · [Rejections](../apps/server/src/services/library-match-rejections.ts)
- **Albums.** `album.edition_of_id` points an edition at the first album of its record; listening totals are worked out per record. [Album merges](../apps/server/src/services/album-merges.ts) · [Album names](../apps/server/src/services/album-names.ts)
- **Artists.** `artist.merged_into_id` keeps a merged artist as a name of the kept one, and `media_credit.credited_as` keeps the name a credit was given under. Every import resolves names through `resolveArtistIds`, so a merged name credits the kept artist. Provider profiles, snapshots and jobs stay with the merged row. The artist detail, Matches and the duplicates count read a merged artist's ID as the kept artist. The Browse page query does not, to stay one statement with a plan for the artist asked for: the page's creator filter (`CreatorScopeChip`) replaces a merged ID in its URL with the kept artist's. [Artist names](../apps/server/src/services/artist-names.ts) · [Artist merges](../apps/server/src/services/artist-merges.ts)
- **Follows.** The album names and titles that follow a merge are read in one place for tracks, albums and artists. [Merge follows](../apps/server/src/services/merge-follows.ts)
- **Reviews.** The server refuses a merge whose plan has a caution until the request says `reviewed`, so no client can skip the review. `follow` defaults to on in every merge request.

| Method | Path                                              | Does                                                          |
| ------ | ------------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/api/v1/library-changes`                         | Lists changes (`kind`, `actor`, `recordId`, `batchId`)        |
| POST   | `/api/v1/library-changes/{id}/undo`, `/redo`      | Undoes or redoes a change                                     |
| POST   | `/api/v1/library-changes/track-merges/plan`, `/`  | Plans or makes a track merge                                  |
| POST   | `/api/v1/library-changes/track-versions/separate` | Separates a version                                           |
| POST   | `/api/v1/library-changes/track-versions/shown`    | Picks the version a record is shown as                        |
| POST   | `/api/v1/library-changes/track-separations`       | Keeps tracks separate                                         |
| POST   | `/api/v1/library-changes/album-merges/plan`, `/`  | Plans or makes an album merge                                 |
| POST   | `/api/v1/library-changes/album-merges/separate`   | Separates an edition                                          |
| POST   | `/api/v1/library-changes/album-names/plan`, `/`   | Plans or makes a scrobbled album name move                    |
| POST   | `/api/v1/library-changes/artist-merges/plan`, `/` | Plans or makes an artist merge                                |
| GET    | `/api/v1/tracks/{id}/parts`                       | What a track is made of                                       |
| GET    | `/api/v1/albums/{id}/unlisted-names`              | Names scrobbled under an album that are not on its track list |
| GET    | `/api/v1/tracks/duplicates/count`, `/layout`      | The Possible duplicates count and group rows                  |
| GET    | `/api/v1/tracks/{id}/duplicates`                  | The group a track is in                                       |

To check why two entries look like the same track, compare their track IDs, `version_group_id`, the owner of each name in `lastfm_track_source` and the credited tracks in `lastfm_track_link`. [Database schema](../apps/server/src/schemas/db.ts) · [Track links](../apps/server/src/services/track-links.ts)

## Releasing

- Apply migrations `0055` to `0059` with the normal [upgrade procedure](getting-started.md#upgrading-and-backing-up). `0055` adds the tables and columns, `0056` rebuilds the stored track order triggers for versions, `0057` adds the possible-duplicates triggers and redefines `mark_browse_cache_dirty()`, and `0058` drops the album track-history SQL function (the history is now moved by the journaled service), lets album-only recordings keep the name a credit was given under, and adds the trigger that drops a name's rejections. `0059` redefines `drop_track_duplicate_groups()` from `0057`, which took tens of seconds on a bulk track update that followed a one-row update on the same connection ([why](query-performance.md#trigger-functions-and-transition-tables)). A later migration that redefines `mark_browse_cache_dirty()` must keep the marker table `0057` added.
- A database that applied an earlier, empty version of `0056`, `0057` or `0058` does not run them again. Recreate such a development database.
- If the runtime uses its own database role, give it the usual read and write grants on the new tables and on the tables the new triggers write: `track_duplicate_group`, `track_duplicate_state` and `library_match_rejection`.
- The first rebuild of possible duplicates plans a merge for every group and takes longer on a large library than later rebuilds, which plan only new groups. Until it has run, the toggle shows no count.

## Not built or left out

- Album facets, period-based listening filters and sorts, the album Listening tab and an artist's Albums count each edition on its own.
- The Albums table has no expand toggle with edition rows under the kept album; editions show through **Show editions as rows**.
- **Merge with…** on a track uses the ordinary track search and does not list possible duplicates first. The merge review has no **Made of** summary. Albums and artists have no **Merge with…**.
- **Possible duplicates** is built for tracks only, in Tracks and in an artist's Tracks list. Albums, artists and an album's track list have no such view.
- A track's Sources keeps the older name controls (**Change match**, **Add scrobbled name**, **Remove**, **Use automatic match**, **Merge Last.fm names**, **Merge with Spotify track**) beside **Made of**. They are recorded and can be undone.
- An artist merge is taken back with Undo only; a kept name has no Separate.
- History has no "In" column and no row per automatic run; automatic changes are listed one by one with their rule.
- Tracks a track-list refresh removes are recorded but cannot be put back. Positions it reassigns are not recorded.
- An automatic Spotify search match made in place (an album recording that gets the Spotify ID itself) can be undone but is not remembered.
- The orphan sweep of a full Last.fm import still removes orphan tracks without an archive.
- The duplicates rebuild is not in the performance suite.
- Redo of an undone automatic match can be refused once a relink has run, with a reason that names a later change.
- An automatic move of a name onto a track of the same title reads Moved “Night Drive” to “Night Drive” in History.
- The first full import spends most of its time in the existing refresh of track added dates, which is unchanged.

## Decisions to confirm

- With Group recordings off, every track is its own row; versions collapse only when grouping is on.
- Merging albums moves no album names by itself.
- An artist with film credits cannot be merged.
- Follows do not force a review; cautions do. Following is on by default.
- Only an album name linked to no album follows a track merge. A name linked to another album stays with that album.
- Turning Possible duplicates on shows the Table view whatever the view was.
- Separating a name from an automatically matched track rejects both the previous owner and the track it was separated from.
- A scrobbled name's remembered rejections are dropped when the name's source row is deleted (no scrobbles left under it).
- The Spotify track is the kept track of a merge where there is one.
