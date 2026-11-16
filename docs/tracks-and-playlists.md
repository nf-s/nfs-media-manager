# Tracks and Spotify Playlists

## Scope

Tracks are a separate library from albums. Every position in a stored album track list opens a library track. Spotify playlists, Liked Songs and Last.fm can add memberships to that same recording or introduce a track the library has never seen. Different albums can list the same recording at different positions. See [linking tracks to albums](#linking-tracks-to-albums).

The library selector has **Albums**, **Tracks**, **Films** and **Subscriptions**. Tracks has **Browse**, **Playlists** and **Imports**. Its import sidebar offers Spotify playlists and Last.fm scrobbles, and keeps Tracks selected. Tracks inherit their linked album's tags and do not have an independent tag editor or metadata jobs. Shared music account settings and sync job links explicitly identify their destination in Albums.

The app can [add a library album](#adding-an-album-to-a-playlist) or [one track](#adding-a-track-to-a-playlist) to a Spotify playlist when the owner asks. It never creates, renames, follows, reorders or removes from a Spotify playlist and never changes Liked Songs. There is no per-track metadata scrape, genre lookup or audio-feature collection.

## Connecting

Playlists need a connected Spotify account with the `playlist-read-private` and `playlist-read-collaborative` permissions, as well as `user-library-read` for Liked Songs. An account connected before playlist support does not have them: **Imports → Spotify playlists** shows a reconnect button, which returns to the same page afterwards. Adding albums or tracks also needs `playlist-modify-private` and `playlist-modify-public`, which are requested only when asked for; see [adding an album](#adding-an-album-to-a-playlist). Account setup is described in [Spotify account setup](spotify-album-imports.md#account-setup).

## Importing

**Imports → Spotify playlists** shows Liked Songs and the stored list of the account's playlists. **List playlists** queues a Spotify listing job, shown in Jobs with its progress, cancel and retry; it reads one page of 50 playlists per request and replaces the stored list. Opening the page reads only the stored list, with the time it was listed and the latest listing job. A second listing is not queued while one is queued or running, and the list is never re-read automatically.

Choose rows from the stored list and import, up to 100 at a time; each one becomes its own Spotify job in Jobs, where it can be cancelled or retried. One job per playlist runs at a time. A playlist missing from the stored list is skipped until the list is read again. Selecting more than five playlists asks "Import 12 playlists?" in a popover on the import button before queueing.

The Import column shows Imported, Needs update or Not imported, or the job state (Queued, Running, Failed, Cancelled) while a job exists. A running listing shows Running with its page count, and "Listed 2026-11-16 14:20" when done.

An import of a playlist first reads the playlist's details: one request that gives its current version and, only for a playlist the account owns or collaborates on, its item count. A playlist the account can no longer read fails without requesting its tracks. Otherwise the import reads the whole playlist in pages of 50 through the Spotify request gate (one request at a time, at least 1500 ms apart), then stores it in a single transaction:

- The playlist's tracks are replaced by what Spotify returned, in playlist order with each track's added date.
- A recording stays in Tracks while it belongs to an album track list, a playlist or imported Last.fm history.
- A track's **Added** date is the earliest known playlist-added date or first scrobble represented by its imported Last.fm membership.
- A playlist whose Spotify snapshot has not changed since the last import is not read again; the import still counts as a completed check. Liked Songs has no snapshot and is always read.

Importing the same playlist again updates it. While an import or listing runs, its job records the pages read and the pages expected (`options.progress`), updated after every page; the total for a playlist comes from its item count, and for Liked Songs from the first page.

### Schedule

Each imported playlist and Liked Songs has its own schedule: off (the default), every 1, 3 or 6 hours, daily or weekly, the same choices as the YouTube and Last.fm schedules. It is measured from the last completed import of that playlist, including one that found it unchanged. Both runtimes check every five minutes when scraping is enabled and queue the playlist's normal import job, using the account of the owner who set the schedule.

The schedule queues nothing for a playlist whose import is queued or running, or while Spotify is cooling down or halted. After a failed or cancelled import it waits until the owner imports the playlist again. Legacy playlists without a Spotify source cannot be scheduled.

The schedule is set on the [playlist drawer's](#playlist-drawer) **Sources** tab. The Playlists table shows each playlist's schedule and last check.

| Limit                           | Behaviour                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playlists owned by someone else | Spotify returns the contents only of playlists the account owns or collaborates on. Others are listed but cannot be chosen, and their contents are never requested. Copy the playlist into your account to import it. |
| 10,000 tracks                   | A playlist or Liked Songs with more than 10,000 tracks fails before anything is stored.                                                                                                                               |
| Local files and episodes        | Entries without a Spotify track ID are skipped and counted in the job message.                                                                                                                                        |
| Refused request                 | A 401 or 403 from Spotify stops all Spotify requests until access is cleared in Providers, as for other Spotify jobs.                                                                                                 |

An imported playlist that shares its name with a playlist from the legacy album import becomes the same playlist, so its albums and tracks appear together. Otherwise a playlist whose name is already used is stored as "Name (owner)".

**Remove** on the Playlists page removes an imported playlist and tracks with no remaining album, playlist or Last.fm membership. It asks first in a popover on the playlist's trash button ("Remove Example mix? · Remove · Cancel"). Album memberships from the legacy import are kept.

### Last.fm tracks

Use **Tracks → Imports → Last.fm scrobbles**. **Sync now** reads the configured account's listening history and adds or updates its library tracks when the sync completes. Albums and Tracks show the same shared sync; there is no separate track-import step. The Tracks page shows how many Last.fm tracks are in the library and how many have no Spotify match, with links to those filtered lists. Its matching table starts with **Needs match**, including tracks with an unconfirmed album-track-list match. Search, sort or change the match-status filter to work through stored tracks. **Match** opens the same side-panel pattern as album linking, with library search prefilled from the track title. Choose a result, review both recordings, then confirm the merge; the table stays open for the next track.

**Refresh matches** is a secondary action for recomputing links after library metadata changes, or using history stored before track import was available. It reads stored history without requesting Last.fm or searching Spotify. The Albums page's **Relink** uses the same refresh.

Each distinct scrobbled artist and track name is represented in the library. A unique matching Spotify library track is reused when its artist and title match, ignoring case and repeated spaces. Any supplied album names must also match, either by name or by all resolving to the same library album. Otherwise the name gets a Last.fm track with its listening history and known album name. Unknown metadata stays empty. Ambiguous matches and different live, remix or edit titles are not combined to choose a Spotify recording.

A track can have more than one source. Reusing a Spotify track adds **Last.fm** alongside **Spotify playlists** or **Liked Songs**. Repeating the import refreshes the existing tracks rather than adding another copy.

Existing installations must apply the database migration that allows `library_track.spotify_track_id` to be null before running the updated application. **Refresh matches** on Tracks Imports can populate the library from already-stored history without another provider sync.

## Track details

Track details use **Overview** and **Sources** tabs; older `listening` and `playlists` tab links open Overview. Overview contains counts, the **Listening** chart, playlist memberships with **Add to playlist**, and the album's tags. Sources explains the Spotify identity and retains the original Last.fm names, recorded albums and manual choices. The Spotify and Last.fm links sit at the end of the detail header; track rows and cards carry no provider icons. Last.fm links use recorded names where available, including after a merge.

## Playlist drawer

The Playlists directory reads bounded pages from `GET /api/v1/playlists/browse-page` and gets its matching count independently from `/browse-count`. Rows can appear before the count arrives. Search, source filters and every sort apply to the complete matching set on the server; pages contain at most 100 summaries. The table reserves the full matching height once counted, renders placeholders for unloaded rows and requests only pages near the viewport. Source is hidden by default. The legacy `/api/v1/playlists` array route also caps each response at 100 rows.

The **Add to playlist** picker searches writable imported playlists by name and loads 25-row pages only while open, with the same full-height placeholder behavior. Addition status reads only the related playlist IDs. The Spotify import preview remains an explicitly bounded saved provider listing; its stored summary metadata is scoped to that listing, so sorting the preview does not fetch the library directory.

Selecting a playlist name opens it in the same inspector used for albums and tracks; the row itself does not. The Playlists table shows durations such as "1h 5m". Links inside the inspector replace its visible detail and keep the original view in place. **Back** returns to the previous detail, and **Open page** opens the standalone detail. Browser history, reload and shared links restore the open detail and its settings. Older links with `?playlist=<playlist ID>` and optional `&tab=sync` still open the playlist inspector; `sync` opens Sources. Escape, the backdrop and the close button close it.

The header shows the name, source, owner, track count and duration, **Play**, **Filter tracks** (Tracks filtered by the playlist, as a required filter), **Filter albums** when the playlist has library albums, and a Spotify link at the end when the playlist has one. The tabs are **Overview**, **Listening** and **Sources**.

- **Overview** leads with the track, library album and linked track counts and the last check, then metadata coverage and the **Tracks** section. Tracks shares Grid, List and Table presentations with album track lists, with independent remembered choices for album and playlist entries. A playlist shows entries in stored order with their added dates, followed by legacy album members. It reads at most 100 entries per page (`GET /api/v1/playlists/:id`), reserves the full result height and loads only pages near the viewport. Changing presentation preserves the visible item, query and playback order; placeholders match the current card or row size. Track and album titles open the corresponding library detail in the inspector; album names in its rows are links without their own play buttons.
- **Listening** shows the playlist's scrobbles in the shared trend chart. Scroll the table horizontally on phones to reach all visible columns.
- **Sources** shows the stored playlist source and last import date. For a Spotify playlist or Liked Songs, it includes the schedule (`PUT /api/v1/playlists/:id/sync-schedule`) and **Sync now**, which queues the normal import and displays any refusal. It shows the last check, next scheduled import, and latest import job with its status, progress, error, finish time and Jobs link. The drawer polls while the job is queued or running and refreshes affected views when it ends.

## Adding an album to a playlist

An album's details can add the album to an imported Spotify playlist that the account owns or collaborates on. Liked Songs, legacy playlists and playlists owned by someone else are not offered. An album needs a Spotify album URL or Spotify album reference.

The account must allow playlist changes. An account connected without them keeps importing and listing; connecting again with playlist changes requested adds them and keeps the access already granted.

Each addition is a Spotify job in Jobs (one album into one playlist), and asking again while it is queued or running returns the same job. The job:

1. Takes the album's Spotify track IDs from its stored track list when every track has one, otherwise reads the album's tracks from Spotify.
2. Reads the playlist's details. When the account can no longer read the playlist, the job fails and the playlist stops being offered.
3. Works out which tracks are already in the playlist: from the stored copy when its version is Spotify's current one, otherwise by reading the playlist from Spotify.
4. Appends the missing tracks in album order, at most 100 per request. A cancelled job stops between requests.
5. Queues the playlist's import, so the stored copy is read again from Spotify. Nothing is written to the stored playlist directly.

A retried or repeated job reads the playlist's current contents again, so tracks added before a failure, including by a request whose answer was lost, are not added twice. An addition that would take the playlist past 10,000 items is refused before anything is added.

## Adding a track to a playlist

A track's details can add that recording to an imported Spotify playlist the account owns or collaborates on. It uses the same playlist-change permission, request limits and job controls as album additions. Liked Songs and legacy playlists are not targets.

The track needs the same Spotify identity used for playback, supplied by an imported playlist, Liked Songs or a stored album track list. Unmatched tracks cannot be added. This action does not search Spotify. The job checks that the selected recording's identity has not changed before sending it.

Each addition queues one job per track and playlist. Repeating the request while that job is active returns the same job. The job checks the playlist's current version, skips a recording already present, appends only the missing track and queues the normal playlist import. A retry reads changed playlist contents before appending, so a lost response does not add the recording twice; it also refreshes the stored playlist when that earlier write is recovered.

The subsequent import reuses the stored library track when its Spotify ID is already known. Addition status identifies the retained track. `POST /api/v1/tracks/:id/playlist-additions` accepts `{ "playlistId": "..." }`; `GET` at the same path reads the latest addition jobs without contacting Spotify.

## Browsing tracks

List is the default Tracks view. Table columns default to Title, Artists, Album, Duration, Added, Scrobbles, Playlists and Tags. The title cell has the artwork and the Play and Add to queue pair; album and playlist names are links, without their own play buttons. List rows show artists and album under the title and Duration, Scrobbles and Added on the right. Grid cards show the release year and the active sort value (Added by default, or the length for text sorts). List, Grid and Table show artwork when available, including artwork inherited from the linked album. Use Table to enable the **Source** and **Spotify match** columns. Search, [AI search](ai-search.md), filters, ranges and sorting use the same URL parameters as albums.

**Artist** groups by the first billed track artist, then release year and album name. **Album** sorts by album name, then release date. **Released** sorts by release date and keeps ties in album order. Both use the linked album's title and date when available, so edition names and dates reported for individual tracks do not split the release. Other sorts break ties by the album's billed artist, release year and title. The stored album position preserves disc and track order. Secondary keys stay ascending in either sort direction, with missing values last.

| Field                    | Source                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| Title, Artists, Album    | Stored album track lists, Spotify playlist metadata or stored Last.fm names. |
| Released, Duration       | Spotify or a matched library album/track; empty when unknown.                |
| Source                   | Album track lists, Last.fm, Spotify playlists and Liked Songs.               |
| Playlists                | Imported playlists containing the track, including Liked Songs.              |
| Added                    | Earliest playlist-added date or scrobble from its Last.fm membership.        |
| Library album            | "In library" or "Not in library".                                            |
| Album tags               | Tags of the linked library album. Empty when the album is not in library.    |
| Scrobbles, Last listened | Linked Last.fm scrobbles; see [scrobbles](#scrobbles).                       |

Setting two or more playlists to **required** shows the tracks in all of them. A playlist in the **Playlists** column opens the [playlist drawer](#playlist-drawer), whose **Filter tracks** applies the filter.

Use **Source** to include or exclude **Album track list**, **Last.fm**, **Spotify playlists** and **Liked Songs**, with the normal **Any**, **Required** and **Excluded** filter modes. Requiring both Last.fm and Spotify playlists shows their overlap; excluding Last.fm hides tracks with imported Last.fm membership. Source filters stay in the URL with the other browse filters.

Listening counts use broader matching rules than source membership. A Spotify track can therefore show scrobbles without having a Last.fm source. Track retention follows its memberships. The Added date comes from playlist additions and imported Last.fm history.

A track's detail shows its sources, playlists (each opens the playlist drawer), Spotify link when available, listening history and, when its album is in the library, a link to the album and the album's tags, labelled as coming from the album. Last.fm tracks can inherit artwork and release date from their linked library album.

**Spotify match** is available as a table column and an include/exclude filter. **Spotify import** means a playlist or Liked Songs import supplied the ID. **Album track list** means the stored album track list supplied it. **Unmatched** means no stored Spotify ID is available. Counts, filters and playback use the same ID. The drawer explains the method and shows the original artist, track and album names recorded by Last.fm, independently of the broader listening matches below them. Spotify playback uses stored metadata.

### Reviewing duplicates

On a Last.fm-backed track without an imported Spotify identity, **Merge with Spotify track** searches existing imported library tracks. Select the recording to keep, compare its artist, title, album and Spotify link, then confirm. Nothing is selected or merged automatically. The merge retains the chosen Spotify track, transfers Last.fm source memberships and playlist memberships, and preserves listening history. If the original recording is still listed on an album with its own Spotify ID, that position keeps its recording. A saved manual source association prevents later Last.fm refreshes from recreating the duplicate, including when recorded album names differ. These source associations are labelled **Manually matched** in track details.

This action does not merge two different imported Spotify identities or search Spotify's remote catalogue. Different releases and versions may legitimately be separate; the retained recording is an explicit choice.

Play controls are visible beside tracks, albums and playlists. Connect [Spotify playback](spotify-playback.md) to enable them where the library has a playable recording. Play is always followed by Add to queue. In Grid the pair appears on the artwork on hover, focus or touch; in List and Table it follows the title. In album and playlist track tables the row number sits before the pair. Playing a row captures the current table order for subsequent tracks. The playlist heading's **Play** starts at the first recorded entry that can play. Spotify opens from the link at the end of the detail header.

### Spotify matching and playback

Last.fm can reuse a library recording when its artist, title and album evidence select one match. It can play immediately if that recording already has a stored Spotify ID. Matching uses local data. A standalone Last.fm track inherits a library album only when every supplied album name resolves to that album. A linked album alone is not enough to choose a playable track, and ambiguous titles are left without an ID.

Last.fm's [`user.getRecentTracks`](https://www.last.fm/api/show/user.getRecentTracks) supplies names and optional MusicBrainz IDs, not Spotify IDs, ISRCs or track durations. Some recordings can therefore be identified from existing library metadata, but the stored history cannot guarantee a Spotify match for every track.

For tracks without a suitable existing library entry, a future **Search Spotify** action could search selected tracks by artist, title and album, retain candidates and let the owner choose the recording after comparing duration and version. Spotify's [search endpoint](https://developer.spotify.com/documentation/web-api/reference/search) supports those fields and ISRC, but no MusicBrainz ID filter. That would need the same request limits and stored search results used by the existing Last.fm album-search workflow, plus persistent accepted/rejected recording decisions that later syncs preserve. Album links would narrow candidates without deciding the track identity. Remote track search and automatic whole-history searches are not implemented. Once a track ID is linked, the existing player can use it. Spotify [playback requires Premium](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback) and the playback connection described above.

## Albums and playlists

An album is in a playlist when it is a member itself (legacy import), a recording in its track list is in the playlist, or a playlist track links to it. The album **Playlists** filter, its facet counts and playlist chips use these memberships. Album details list each playlist with the linked tracks it contains.

## Linking tracks to albums

A recording can appear on more than one album track list. Track details show one library album for artwork, tags and navigation. An explicit track-list membership takes precedence when choosing that album. Links are recomputed after every playlist import, after every scrobble sync and by **Relink** on the Last.fm page. Standalone Last.fm tracks use the album links of their scrobbles when all supplied album names resolve to one album. Other Spotify tracks use the first rule that finds an album.

| Rule             | Links when                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spotify album    | The track's Spotify album ID is a Spotify album reference of the library album.                                                                              |
| Spotify track    | The track's Spotify ID is in the album's stored track list.                                                                                                  |
| Album title      | A credited artist of the track is credited on an album whose title matches without edition qualifiers, and the album's track list has the track or is empty. |
| Artist and title | A credited artist of the track is credited on an album whose track list has the track.                                                                       |

Track titles are compared without featured credits, remaster notes and "original mix" style qualifiers; a live, remix or edit title is a different track. Between several fitting albums the exact album title wins, then the earliest release. Hidden albums are not linked. There is no manual override.

## Scrobbles

Stored Last.fm scrobbles link to library tracks by artist and track name. A scrobbled name counts towards every track the first fitting rule finds, so two Spotify listings of one recording share its scrobbles. These listening-attribution rules are broader than the strict matching used to choose a Spotify identity for an imported Last.fm track.

| Rule                  | Links when                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Same artist and title | The names match, ignoring case and repeated spaces.                                                                      |
| Ignoring punctuation  | As above, also ignoring accents, punctuation, `&` against "and" and a leading "The" on the artist.                       |
| Same version          | The titles match once featured credits and remaster notes are removed.                                                   |
| Linked album          | The scrobble is linked to the track's library album and exactly one library track on that album has the same base title. |

**Scrobbles** and **Last listened** on a track come from these links and are refreshed with them. Syncing and album linking are described in [Last.fm scrobble history](lastfm-scrobbles.md).

## Data model

- A track is a `media_item` with media type `track` and a `library_track` row holding optional Spotify IDs, album metadata and listening totals. The `track` table stores album positions and their provider-supplied fields, with each position referencing a library track. Migration `0029_album_library_tracks` backfills these references and preserves the stored position and provider data. It reuses exact Spotify IDs and unique, corroborated title matches. A recording without track-level credits can inherit its album's credited artists. Ambiguous recordings retain separate identities. The migration uses stored data.
- Spotify playlist and Liked Songs imports retain native artist IDs, their credited names and import provenance in track metadata. Artist Sources can reuse this evidence without enrichment. Spotify album track lists retain individual track artists, including featured artists, when creating album-owned recordings; existing imported track credits are preserved. See [artist identifiers and their sources](artists-and-people.md#artist-enrichment).
- `playlist` rows carry their source (`spotify` or `spotify-liked`), Spotify ID, owner, artwork, snapshot, import time, last check time, schedule and whether the account can still change the playlist. `playlist_item` holds track and album memberships with position and added date.
- `spotify_playlist_listing` holds the account's last playlist list as one JSON array per user, with its listing time.
- `lastfm_track_source` maps each imported account, artist name and track name to one library track. It supplies Last.fm source membership, retention after playlist removal and the scrobble contribution to Added. Its `manually_matched` flag preserves confirmed recording choices; migration `0027_manual_track_matches` is required before deploying this merge workflow.
- `lastfm_track_link` separately records which scrobbled artist and track names count towards which library tracks, and by which listening-attribution rule. A name can contribute listening counts to several Spotify editions without giving them all Last.fm membership.
- Imports run as the `spotify-playlist-import` task job, listings as `spotify-playlist-listing`, album additions as `spotify-playlist-add-album` and track additions as `spotify-playlist-add-track`, all with provider `spotify`.

## Verification

- `apps/server/src/lib/track-matching.test.ts`: linking rules.
- `apps/server/src/lib/playlist-sync.test.ts`: schedule times.
- `apps/server/integration/spotify-playlists.integration.ts`: the listing job, import, progress, re-import, schedule, playlist pages, album additions with batches and a retried failure, refusals, removal, limits, filters, album membership and scrobble counts against a disposable database with mocked Spotify responses.
- `apps/server/integration/lastfm-tracks.integration.ts`: stored-history import, identity ambiguity, source filters, playlist removal, account history and playback metadata against a disposable database without provider requests.
- `apps/web/components/playlist-detail.test.tsx`, `apps/web/components/playlists.test.tsx`, `apps/web/components/play-controls.test.tsx`, `apps/web/utils/playlist-sync.test.ts` and `apps/web/utils/playlist-links.test.ts`: the playlist drawer, its deep link, sync labels and the track play controls.
