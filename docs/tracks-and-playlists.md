# Tracks and Spotify Playlists

## Scope

Tracks are a separate library from albums. Every position in a stored album track list opens a library track. Spotify playlists, Liked Songs and Last.fm can add memberships to that same recording or introduce a track the library has never seen. Different albums can list the same recording at different positions. See [linking tracks to albums](#linking-tracks-to-albums).

The library selector has **Albums**, **Tracks**, **Films** and **Subscriptions**. Tracks has **Browse**, **Playlists**, **Imports** and **Jobs**. Its import sidebar offers Spotify playlists and Last.fm scrobbles, and keeps Tracks selected. Tracks inherit their linked album’s tags. **Jobs → Metadata** can search Spotify for unmatched recordings. Shared music account settings and sync job links explicitly identify their destination in Albums.

The app can [add a library album](#adding-an-album-to-a-playlist) or [one track](#adding-a-track-to-a-playlist) to a Spotify playlist when the owner asks. It never creates, renames, follows, reorders or removes from a Spotify playlist and never changes Liked Songs. There is no per-track metadata scrape, genre lookup or audio-feature collection.

## Adding a track

In **Tracks → Browse**, choose **Add track**, search Spotify by track or artist, then choose **Add** beside the recording you want. The track opens in your library. Results already in the library show **Open**. A track added this way has **Spotify track search** as a source. Search uses the market set in **Providers → Spotify** or the market of your connected Spotify account.

## Connecting

Playlists need a connected Spotify account with the `playlist-read-private` and `playlist-read-collaborative` permissions, as well as `user-library-read` for Liked Songs. An account connected before playlist support does not have them: **Imports → Spotify playlists** shows a reconnect button, which returns to the same page afterwards. Adding albums or tracks also needs `playlist-modify-private` and `playlist-modify-public`, which are requested only when asked for; see [adding an album](#adding-an-album-to-a-playlist). Account setup is described in [Spotify account setup](spotify-album-imports.md#account-setup).

## Importing

**Imports → Spotify playlists** shows Liked Songs and the stored list of the account's playlists. **List playlists** queues a Spotify listing job, shown in Jobs with its progress, cancel and retry; it reads one page of 50 playlists per request and replaces the stored list. Opening the page reads only the stored list, with the time it was listed and the latest listing job. A second listing is not queued while one is queued or running, and the list is never re-read automatically.

Choose rows from the stored list and import, up to 100 at a time; each one becomes its own Spotify job in Jobs, where it can be cancelled or retried. One job per playlist runs at a time. A playlist missing from the stored list is skipped until the list is read again. Selecting more than five playlists asks "Import 12 playlists?" in a popover on the import button before queueing.

The Import column shows Imported, Needs update or Not imported, or the job state (Queued, Running, Failed, Cancelled) while a job exists. A running listing shows Running with its page count, and "Listed 2026-11-16 14:20" when done.

An import of a playlist first reads the playlist's details: one request that gives its current version and, only for a playlist the account owns or collaborates on, its item count. A playlist the account can no longer read fails without requesting its tracks. Otherwise the import reads the whole playlist in pages of 50 through the Spotify request gate (one request at a time, at least 1500 ms apart), then stores it in a single transaction:

- The playlist's tracks are replaced by what Spotify returned, in playlist order with each track's added date.
- A recording stays in Tracks while it has an album, playlist, Last.fm or Spotify track search source.
- A track's **Added** date is the earliest known manual addition, playlist addition or first scrobble from its imported Last.fm membership.
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

**Remove** on the Playlists page removes an imported playlist and tracks with no remaining album, playlist or Last.fm membership. Recordings explicitly kept from a Spotify track search stay in the library. It asks first in a popover on the playlist's trash button ("Remove Example mix? · Remove · Cancel"). Album memberships from the legacy import are kept.

### Last.fm tracks

Use **Tracks → Imports → Last.fm scrobbles**. **Sync now** reads the configured account's listening history and adds or updates its library tracks when the sync completes. Albums and Tracks show the same shared sync; there is no separate track-import step. The Tracks page shows how many Last.fm tracks are in the library and how many have no Spotify match, with links to those filtered lists. Its matching table starts with **Needs match**, showing only recordings with no usable Spotify track ID on the entry or a confirmed version. **Matched** includes IDs supplied by album track lists, playlist imports, Liked Songs and confirmed Spotify track searches. A confirmed alternate links to its own Sources. Search, sort or change the match-status filter to work through stored tracks. Choose **Scrobbled names** in the table to open the track’s **Sources** and correct individual names. **Merge names** opens a library track search. Choose the recording to receive the names and review both entries before confirming.

Select unmatched tracks and choose **Search Spotify tracks**. You can also select tracks in **Tracks → Jobs → Metadata**. On an unmatched track, **Match to Spotify** opens the matching options. In **Sources**, open **Spotify** to see saved candidates and select one. Results from earlier searches stay visible, including when a later job was empty or failed. Each distinct Spotify recording appears once, under the most recent search that found it. Choose **Search Spotify** to edit the query and search the catalog again. Select a result and confirm it. An interactive search waits for your choice even when Spotify returns one result. Sources shows the current job and links to a playable version when one is already in the library. Each selected recording gets one search job. Opening these screens reads stored data. Searches use the configured Spotify market or the connected account’s market. When only Spotify app credentials are configured, the search action asks for a two-letter market code and remembers a successful choice for the browser tab. An API caller can supply `market` for its selected jobs. Each job keeps that market on retry. Tracks Spotify marks as unavailable are excluded from the results.

For automatic searches, a single compatible Spotify result links immediately. The matcher allows differences in case, accents, punctuation, featured-artist billing and a second of duration rounding. Known recording identifiers and album positions must agree. A standalone track can match an unqualified original mix or a remaster when the title and artist otherwise agree. If several editions fit, the matcher prefers the requested version first, then a release observed in the scrobbles, then an album or recording already in the library, then matching artist credits. Spotify track popularity breaks remaining ties when available. Otherwise the earlier Spotify result wins. A missing album title does not prevent a match. A standalone Last.fm track can have ordinary album tags from several releases. Its original tags stay on the plays. Signs of a different recording, such as a conflicting live version or remix, remain available for review. Manual choices are preserved.

For offline review, run `pnpm --filter @repo/server review:spotify-tracks --output /path/to/review.html` with the installation’s database configuration. Open the resulting HTML file locally. It includes every unmatched track with saved Spotify candidates for the search owner. The most likely candidate is checked for each track assessed as likely. Review the other tracks, switch editions or uncheck any selection, then choose **Copy IDs** to copy the library and Spotify track IDs in pairs. The checklist reads saved results without searching Spotify or applying matches.

If that Spotify track ID already belongs to a compatible library recording, the app moves the scrobbled names and listening history there. A recording that already has the exact Spotify ID can keep its library spelling and duration when the only title differences are accents and the durations agree within one second. If the selected Spotify result conflicts with the recording that would receive those plays, **Confirm Spotify match** stops and links to that recording’s **Sources**. Open it to check the existing assignment, or choose another candidate. A later playlist or album import reuses the same ID. Conflicting album positions stay available for review. A search with no results counts as a completed search and the recording remains in **Needs match**.

An album track can inherit **Various Artists** from its compilation when the track list has no performer credits. A Spotify search can fill in the track’s performers when its existing Spotify ID, release, track-list entry, title and duration all agree with the catalog result. The compilation keeps its album credit. The search job records the previous track credit so the correction can be checked later.

**Refresh matches** is a secondary action for recomputing links after library metadata changes, or using history stored before track import was available. It reads stored history without requesting Last.fm or searching Spotify. The Albums page's **Relink** uses the same refresh.

Each distinct scrobbled artist and track name is represented in the library. A unique matching Spotify library track is reused when its artist and title match, ignoring case and repeated spaces. Any supplied album names must also match, either by name or by all resolving to the same library album. Otherwise the name gets a Last.fm track with its listening history and known album name. Unknown metadata stays empty. Ambiguous matches and different live, remix or edit titles are not combined to choose a Spotify recording.

When the supplied albums resolve to one library release, the track list provides additional evidence. A leading number such as “02 -” must agree with the track position. An explicit featured credit can identify the unique track on that album. For a combined artist credit, the guest must also appear in the release credits or in a corroborating scrobbled name. Conflicting versions or credits remain available for manual review.

A track can have more than one source. Reusing a Spotify track adds **Last.fm** alongside **Spotify playlists** or **Liked Songs**. Repeating the import refreshes the existing tracks rather than adding another copy.

Existing installations must apply the database migration that allows `library_track.spotify_track_id` to be null before running the updated application. **Refresh matches** on Tracks Imports can populate the library from already-stored history without another provider sync.

## Track details

Track details use **Overview** and **Sources** tabs; older `listening` and `playlists` tab links open Overview. Overview contains counts, the **Listening** chart, playlist memberships with **Add to playlist**, and the album's tags. Sources explains the Spotify identity and retains the original Last.fm names, recorded albums and manual choices. The Spotify and Last.fm links sit at the end of the detail header; track rows and cards carry no provider icons. Last.fm links use recorded names where available, including after a merge.

Above the Spotify source, an **Album** section warns about the track's album. It appears only when one of these applies:

- A track imported from Spotify whose album is not in the library shows “Example EP” is not in the library. with **Add album**. It adds that Spotify album by its ID through the normal manual addition; the album's track list then takes in the library tracks with the same Spotify track IDs, and the track shows its album. When the library already has an album of the same title and artists that is another Spotify release, such as the single of that name, the chosen release is added beside it as an album of its own; the two can be [merged](#albums-and-editions) into one record with editions. If the album that comes back still does not hold the track, the notice changes to “Example EP” is in the library but does not list this track, with a link to that album.
- An album that the track's scrobbles are linked to but that holds neither the track nor a version of it shows, for example, 12 plays of this track are counted on “Example Single”, which does not list it. Up to five such albums are listed, most plays first. A version is a track joined as a version of this one or a recording with the same ISRC. To move those plays, link the scrobbled album name to the right album from that album's **Listening** tab or **Sources → Last.fm**; see [albums and editions](#albums-and-editions).

## Playlist drawer

The Playlists directory reads bounded pages from `GET /api/v1/playlists/browse-page` and gets its matching count independently from `/browse-count`. Rows can appear before the count arrives. Search, source filters and every sort apply to the complete matching set on the server; pages contain at most 100 summaries. The table reserves the full matching height once counted, renders placeholders for unloaded rows and requests only pages near the viewport. Source is hidden by default. The legacy `/api/v1/playlists` array route also caps each response at 100 rows.

The **Add to playlist** picker searches writable imported playlists by name and loads 25-row pages only while open, with the same full-height placeholder behavior. Addition status reads only the related playlist IDs. The Spotify import preview remains an explicitly bounded saved provider listing; its stored summary metadata is scoped to that listing, so sorting the preview does not fetch the library directory.

Selecting a playlist name opens it in the same inspector used for albums and tracks; the row itself does not. The Playlists table shows durations such as "1h 5m". Links inside the inspector replace its visible detail and keep the original view in place. **Back** returns to the previous detail, and **Open page** opens the standalone detail. Browser history, reload and shared links restore the open detail and its settings. Older links with `?playlist=<playlist ID>` and optional `&tab=sync` still open the playlist inspector; `sync` opens Sources. Escape, the backdrop and the close button close it.

The detail header identifies each playlist as an **Album playlist** or a **Track playlist**; the Playlists directory shows only the name and the play pair in its Playlist column, and the Spotify logo link beside the source in its Source column (hidden until chosen under Columns). The header shows the name, source, owner, available counts and duration, **Play** and Queue under the artwork, and the Spotify logo under the facts when the playlist has one. More holds **Filter tracks** (Tracks filtered by the playlist, as a required filter), **Filter albums** when the playlist has library albums, and **Playlist type**. The tabs are **Overview**, **Listening**, **Coverage** and **Sources**.

- **Overview** opens album playlists in **Albums** and track playlists in **Tracks**. When both are available, switch between them above the entries. Tracks starts in Table and Albums starts in Grid. Each remembers its own layout. The choice travels with the detail URL. In More, choose **Playlist type** → **Album playlist** or **Track playlist** to save a default for that playlist, or **Automatic** to use its contents; the current choice is ticked. Albums shows each library album once, at its first playlist position, using direct album entries, linked tracks and stored album track lists. Tracks keeps the imported order and added dates, followed by legacy album entries. The playlist's **Play** and **Add to queue** keep that original order.
- Both views offer Grid, List and Table. They search and sort the full result before loading bounded pages of up to 100 rows (`GET /api/v1/playlists/:id`, with `groupBy=album` for Albums). Titles open the corresponding item in the inspector. **Show in Tracks** or **Show in Albums** opens Browse filtered to the playlist by name, with the same search and view and any order Browse also has; playlist position and date added have no Browse order and are left out. **Metadata gaps** shows a selectable table of entries whose library albums have a gap for a provider. Scrobbles, last played, library album count and linked track count remain above the entries.
- **Listening** shows the playlist's scrobbles in the shared trend chart. Scroll the table horizontally on phones to reach all visible columns.
- **Coverage** shows stored album metadata or artist profile freshness. Use **Albums** and **Artists** to switch what it counts; the choice is kept in the URL (`coverage=artists`; Albums is the default and is left out). Reading coverage never scrapes or queues.
  - **Albums** counts the albums behind the entries (album entries, the library albums of tracks and the albums whose track list has them). The total shows how many library albums have stored metadata from any source. Each provider shows how many eligible albums have its data, including imports and older results. **Missing metadata** counts albums that lack data from that provider. **Stale** shows stored results due for a refresh. Selecting the count opens the corresponding gap in Overview, grouped by album when Albums is selected. **Queue** and **Refresh** queue the first 100 of those albums for that provider through the reviewed album queue (`POST /api/v1/scrape/jobs/albums`).
  - **Artists** counts the artists the Artists Metadata playlist filter matches: those credited on the playlist's tracks, on its album entries and on the albums of its tracks, leaving hidden albums and tracks out (`GET /api/v1/playlists/:id/coverage/artists`). A profile is current when that provider's latest successful snapshot is newer than 180 days, stale when older and missing when there is none. A count opens **Jobs → Metadata** for Artists filtered to the playlist and that provider's freshness: **No successful scrape** for missing, and **No success or older than 180 days** for stale, sorted by last fetch so the stale artists come first (that filter also lists the never fetched). **Queue** and **Refresh** queue the first 100 of those artists for that provider through the artist queue (`POST /api/v1/artists/enrichment`), which rechecks freshness, skips artists with an active job and keeps provider limits and cooldowns. No album is queued. Progress is under **Jobs** with the Artists library.
  - Both modes show the same review step first, naming the provider, the number of jobs and when only the first 100 are queued.
- **Sources** shows the stored playlist source and last import date. For a Spotify playlist or Liked Songs, it includes the schedule (`PUT /api/v1/playlists/:id/sync-schedule`) and **Sync now**, which queues the normal import and displays any refusal. It shows the last check, next scheduled import, and latest import job with its status, progress, error, finish time and Jobs link. The drawer polls while the job is queued or running and refreshes affected views when it ends.

### How the default is chosen

Albums is the default when at least 80% of the playlist entries represent complete or nearly complete albums, or concentrated groups of tracks from the same Spotify release. Each direct album entry counts once if its tracks are not already represented. For a known track count, a release needs at least two distinct tracks and either 80% of the album or all but one track. For example, three tracks from a four-track EP qualify.

Spotify tracks with the same release ID can establish a group even when they were matched by another method or some tracks have no library link. When the album length is unknown, at least five tracks from that release must make up 80% of their span in playlist order. Library playlists containing only direct album entries open in Albums. Empty playlists, Liked Songs and playlists with insufficient album evidence open in Tracks. The app calculates the default from stored memberships when the playlist is read.

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

Tracks Browse hides a standalone Last.fm entry with no album, playlist or Spotify ID when its exact scrobbled artist and title already count toward a visible album track or playable recording. An EP and an album can each keep their own row and show the same listens. If the last matching recording leaves the library, the standalone entry appears again. To inspect the original names or choose a recording manually, filter by **Source → Last.fm** or open **Tracks → Imports → Last.fm scrobbles**.

Find **Group recordings** under **Filters → View**. It is on when sorting by **Scrobbles** or **Last listened**. Other sorts, including **Artist** and **Album**, start with each release version visible. Toggle grouping for the current sort. Its setting survives a reload and changing the sort field applies the new sort’s default.

In Table, the chevron before a grouped track’s thumbnail opens its versions as rows under it, each with its provider mark; **Shown** marks the version the row is shown as. In Grid and List, use the arrow immediately after the title. Either way you can open or play a specific release version. Groups hold the [versions](#versions) a merge stored, and otherwise use the full track title, billed artists and recording evidence from a shared ISRC or an exact Last.fm match. Version qualifiers such as “Radio Edit” and “Remix” distinguish recordings. Conflicting ISRCs or substantially different known durations keep ambiguous versions apart. With **Group recordings** off, every version is its own row.

The grouped row counts each linked listen once, shows the latest listen and uses the earliest known Added date among the included versions. Album, playlist and other release filters narrow those versions before grouping. Listening and Added ranges apply to the grouped values. Album track lists and the Matches table continue to show individual entries.

List is the default Tracks view. Table columns default to Title, Artists, Album, Duration, Added, Scrobbles, Playlists and Tags. The title cell has the artwork and the Play and Add to queue pair; album and playlist names are links, without their own play buttons. List rows show artists and album under the title and Duration, Scrobbles and Added on the right. Grid cards show the release year and the active sort value (Added by default, or the length for text sorts). List, Grid and Table show artwork when available, including artwork inherited from the linked album. Use Table to enable the **Source** and **Spotify match** columns. Search, [AI search](ai-search.md), filters, ranges and sorting use the same URL parameters as albums.

**Artist** groups by the first billed track artist, then release year and album name. **Album** sorts by album name, then release date. **Released** sorts by release date and keeps ties in album order. Both use the linked album's title and date when available, so edition names and dates reported for individual tracks do not split the release. Other sorts break ties by the album's billed artist, release year and title. The stored album position preserves disc and track order. Secondary keys stay ascending in either sort direction, with missing values last.

| Field                    | Source                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Title, Artists, Album    | Album track lists, Spotify catalog or playlist metadata, or stored Last.fm names.    |
| Released, Duration       | Spotify or a matched library album/track; empty when unknown.                        |
| Source                   | Album track lists, Last.fm, Spotify playlists, Liked Songs and Spotify track search. |
| Playlists                | Imported playlists containing the track, including Liked Songs.                      |
| Added                    | Earliest manual addition, playlist addition or scrobble from its Last.fm membership. |
| Library album            | "In library" or "Not in library".                                                    |
| Album tags               | Tags of the linked library album. Empty when the album is not in library.            |
| Scrobbles, Last listened | Linked Last.fm scrobbles; see [scrobbles](#scrobbles).                               |

Setting two or more playlists to **required** shows the tracks in all of them. A playlist in the **Playlists** column opens the [playlist drawer](#playlist-drawer), whose **Filter tracks** applies the filter.

Use **Source** to include or exclude **Album track list**, **Last.fm**, **Spotify playlists**, **Liked Songs** and **Spotify track search**, with the normal **Any**, **Required** and **Excluded** filter modes. Requiring both Last.fm and Spotify playlists shows their overlap; excluding Last.fm hides tracks with imported Last.fm membership. Source filters stay in the URL with the other browse filters.

Listening counts use broader matching rules than source membership. A Spotify track can therefore show scrobbles without having a Last.fm source. Manually added tracks keep their Spotify track search source when a playlist is removed.

A track's detail shows its sources, playlists (each opens the playlist drawer), Spotify link when available, listening history and, when its album is in the library, a link to the album and the album's tags, labelled as coming from the album. Last.fm tracks can inherit artwork and release date from their linked library album.

**Spotify match** is available as a table column and an include/exclude filter. **Spotify playlist / Liked Songs** means a playlist or Liked Songs import supplied the ID. **Spotify track search** means a catalog search supplied the ID through Add track or an automatic or confirmed match. **Album track list** means the stored album track list supplied it. **Unmatched** means no stored Spotify ID is available. Counts, filters and playback use the same ID. The drawer explains the method and shows the original artist, track and album names recorded by Last.fm, independently of the broader listening matches below them. Spotify playback uses stored metadata.

Play controls are visible beside tracks, albums and playlists. Connect [Spotify playback](spotify-playback.md) to enable them where the library has a playable recording. Play is always followed by Add to queue. In Grid the pair appears on the artwork on hover, focus or touch; in List and Table it follows the title. In album and playlist track tables the row number sits before the pair. Playing a row captures the current table order for subsequent tracks. The playlist heading's **Play** starts at the first recorded entry that can play. Spotify opens from the link at the end of the detail header.

### Spotify matching and playback

Last.fm can reuse a library recording when its artist, title and album evidence select one match. It can play immediately if that recording already has a stored Spotify ID. Matching uses local data. A standalone Last.fm track inherits a library album only when every supplied album name resolves to that album. A linked album alone is not enough to choose a playable track, and ambiguous titles are left without an ID.

Last.fm's [`user.getRecentTracks`](https://www.last.fm/api/show/user.getRecentTracks) supplies names and optional MusicBrainz IDs, not Spotify IDs, ISRCs or track durations. Some recordings can therefore be identified from existing library metadata, but the stored history cannot guarantee a Spotify match for every track.

For a recording still missing a playable version, **Search Spotify** opens the editable catalog search. Submit your text, choose a recording and confirm the match. The [Last.fm track import](#lastfm-tracks) describes how results link to library tracks and how to review the remaining candidates. To apply the same rules to saved searches that still have unconfirmed results, run `pnpm --filter @repo/server backfill:spotify-track-searches` to preview, then add `--apply` to save the eligible matches. Both commands use the stored results. Once a track ID is linked, the existing player can use it. Spotify [playback requires Premium](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback) and the playback connection described above.

## Merging and history

A track is a record made of scrobbled names and versions. A scrobbled name is an artist and title as Last.fm recorded them; its scrobbles belong to it. A version is a library track with its own Spotify track, album position or playlist entry. **Merge** puts tracks under one record, **Separate** takes a version out again and **Keep separate** records that tracks are different. Albums have [editions](#albums-and-editions) in place of versions, and an artist keeps the names it was [merged with](artists-and-people.md#merging-artists). Every change is listed in [History](#history-and-undo) and can be undone.

### Merging from a table

In the **Tracks** table, **Tracks → Matches**, the Tracks table of an artist and [an album's track list](#merging-in-an-albums-track-list), tick two or more rows and choose **Merge** in the bar under the table. The header checkbox selects the rows loaded so far, and Shift selects a range. The selection is cleared when the search, a filter, the sort or the view changes.

Merge returns at once: the selection clears, the bar says Merging… and then the result with Undo, and other rows can be ticked and merged meanwhile. Merges are made one after another in the order pressed. A merge that fails, or whose review is cancelled, returns its rows to the selection.

The track that is kept is the one with its own Spotify track, then one with an album position or a playlist entry, then the most played. Each other track:

- becomes a **version** of the kept track when it has its own Spotify track or no scrobbled names. It keeps its names, album positions and playlist entries, and counts the record's scrobbles.
- is otherwise **merged**: its scrobbled names, album positions and playlist entries move to the kept track and it is removed.

Scrobbles the kept track already counts are not added twice.

The merge is made at once and the bar reports it with **Undo**. A review opens first only when something speaks against the merge:

- a version word such as Live, Demo or Remix is in some of the titles only;
- known lengths are more than ten seconds apart;
- the tracks have no artist in common;
- two of the tracks are different positions on the same album;
- some of the tracks were kept separate;
- names that would follow the merge are on a track of another album, or match more than one track of the album and stay where they are.

In the review, **Shown as** picks the track that is kept and the row is shown as. It also shows the scrobbles before and after, how many names move and, under **Becomes**, whether each track is shown, becomes a version or is merged. **Also merged** lists what [follows the merge](#what-follows-a-merge), with a checkbox to leave it out.

### What follows a merge

Names follow the record above them:

- Merging tracks also merges the album names the merged titles were scrobbled under into the album of the kept track, when those names are linked to no album, with the other titles scrobbled under them that match a track on that album.
- Merging artists moves the names of a merged artist's Last.fm-only track, with no album position or playlist entry, to the kept artist's track of the same title when exactly one record matches.
- [Moving a scrobbled album name](#albums-and-editions) onto an album brings the titles scrobbled under it that match a track of the album. Merging albums moves no album names by itself.

A name never follows onto a track it was kept separate from, or onto a track an undone or separated automatic match rules out. An album name linked to an album, or linked or unlinked by hand, stays where it is. What follows is listed in the review but does not open it, and a merge made without a review brings it too. One Undo puts the merge and everything that followed back.

### Versions

A track's **Sources** tab starts with **Made of**: the versions, the shown one first, then the scrobbled names. Each row has its type (Spotify version, Album version, Last.fm version or Scrobbled name, with Manually matched for a name linked by hand), its album and its scrobbles.

- **Shown** picks the version the record's row takes its title, artist and album from. It changes nothing else.
- **Separate** gives a version its own row again, with the names it owns.
- **Merge with…** searches the library's tracks and merges the chosen one with this track, opening the review when something speaks against it. If the open track is the one removed, the kept track opens.

Each change shows a notice with Undo and is listed under **Changes**. In Tracks, versions share one row only while **Group recordings** is on; see [browsing tracks](#browsing-tracks).

### Merging in an album's track list

An album's track list has the same selection column and bar. Under it, **Scrobbled under this album, not on its track list** lists the names scrobbled under the album that match no track on it, most played first. Tick one with the track it belongs to and choose **Merge**. On an album of more than 20 tracks they appear after **Show all**. Names owned by the same track are ticked together.

### Possible duplicates and Keep separate

**Possible duplicates** in the **Tracks → Matches** toolbar shows only the tracks that look like the same track, in groups, the most played group first. Its count is the number of groups; while Matches is held to one artist, those with that artist's tracks. A group is usually a library track beside a Last.fm record of the same song under another spelling, or the same song on two releases.

Each group starts with a row holding **Merge**, **Keep separate** and an info icon. The icon opens what Merge does and what put the tracks together: for example Merge keeps “Night Drive”: 1 Last.fm record is removed and its plays and names move to it, then Same title and artist. When something speaks against merging, the row says so after the icon, such as Against merging: lengths differ by 0:42; a group with nothing against it has no text. The menu beside the toggle lists **All groups**, only those with **Nothing against merging**, or only those with **Something against merging**.

**Merge** merges the whole group as [above](#merging-from-a-table); a group with something against it opens the review first. To merge part of a group, tick those rows: the group's button then reads **Merge 4 selected** and merges only them, keeping the group's first track when it is one of them. Ticked rows of other groups do not count, and one ticked row alone cannot be merged. The ticks are cleared when the merge starts and come back if it fails or its review is closed. The tracks left over can then be kept separate. **Keep separate** always acts on the whole group. With a search or filter a group shows only its matching tracks, but Merge with nothing ticked and Keep separate still act on the whole group.

Merge, the review's Merge and Keep separate return at once. The requests are sent one after another in the order pressed while other groups stay usable; the group's row says Merging…, Needs review, Merged, Keeping separate… or Kept separate, or why it failed, and the bar counts the groups still to go. The table reloads once when none is left.

**Keep separate** is remembered: the group is not suggested again, merging those tracks later opens the review, and automatic matching never joins them. The bar under the table shows the last finished change with Undo; every change is in **Tracks → History**.

A track in a group shows a notice above its tabs naming the other tracks, what speaks against merging and what Merge does, with Merge and Keep separate.

Groups are worked out in the background, so a new group can take a few minutes to appear after an import. Until the first grouping has run, the toggle shows no count and the view is empty. A large library is grouped over several runs, five minutes apart, starting with the most-played tracks; the count grows until all groups are listed. A group holds at most 12 tracks.

### Albums and editions

In the **Albums** table, in Table view, tick two or more albums and choose **Merge**. Nothing is deleted: the other albums become **editions** of the kept one, which is the album with a Spotify album, then the one with the most tracks, then the earliest added. **Album to keep** in the review picks another. A review opens first when a version word such as Deluxe is in some titles only, the artists differ, the track lists share fewer than half their titles, or some of the albums were kept separate. Albums removed from the library, and albums that are already one record, cannot be merged.

The kept album's scrobbles count all its editions. In the table its title shows “+2 editions”, and edition rows appear only with **Filters → View → Show editions as rows**. An album's header says “Edition of …” or how many editions it has. Its **Sources** tab lists the editions, each with **Separate**, and an edition shows **Edition of** with Separate. **Separate** makes an edition an album of its own again.

To move a scrobbled album name onto an album, choose **Link** on the name in the album's **Listening** tab or in **Sources → Last.fm**. The name moves at once with a notice and Undo. When track names scrobbled under it would follow onto tracks of the album, the review opens first, listing them and the names that match no track and stay. **Link**, **Change**, **Unlink** and **Automatic** on the [Last.fm page](lastfm-scrobbles.md#manual-links) are recorded in History as well; no track names follow them.

### Scrobbled names in Sources

Below **Made of**, a track's Sources keeps the controls for single names. **Add scrobbled name** searches stored Last.fm names across the library. **Change match** assigns one recorded name and its plays to a library track. **Remove** keeps the name on its own Last.fm entry; when an automatic rule had placed it, the rules do not match it to that track again. **Use automatic match** lets the import rules decide again and forgets those decisions. Manual choices survive subsequent imports.

**Merge Last.fm names** moves all recorded names from the displayed track to a library track you choose. Both Last.fm-only and Spotify-backed tracks are valid destinations. The original scrobbles, album track lists and playlist positions are preserved. **Tracks → Matches** also offers **Change match** beside individual recorded names.

On a Last.fm-backed track without an imported Spotify identity, **Merge with Spotify track** searches existing imported library tracks. Select the recording to keep, compare its artist, title, album and Spotify link, then confirm. The merge retains the chosen Spotify track, transfers Last.fm source memberships and playlist memberships, and preserves listening history. If the original recording is still listed on an album with its own Spotify ID, that position keeps its recording. A saved manual source association prevents later Last.fm refreshes from recreating the duplicate, including when recorded album names differ. These source associations are labelled **Manually matched** in track details. To join two Spotify tracks as versions of one record, use **Merge** or **Merge with…**.

### History and Undo

**Tracks → History**, **Albums → History** and **Artists → History** list the changes of each library, newest first: when, what changed, who made it (You or Automatic) and the scrobbles moved. **Changed by** narrows the list to your changes or the automatic ones. The line under a change names the scrobbled names, the rule and what else moved, such as “Also merged 2 album positions and 1 playlist entry”. A track's, album's or artist's **Sources** tab lists its own latest changes under **Changes**.

Recorded are every merge, move and separation of scrobbled names by hand (a merge from a table, **Change match**, **Add scrobbled name**, **Remove**, **Use automatic match**, **Merge Last.fm names**, **Merge with Spotify track**), **Shown**, **Separate**, **Keep separate**, album and artist merges, album name moves, and the [automatic matches](#automatic-matches-in-history).

**Undo** puts every part back where it was, including what followed: names, versions, album positions, playlist entries, editions, album names and credits. A track the change removed comes back as it was: its title and dates, artist credits, tags and their sources, provider references and identifiers, links, stored provider data and edits made by hand; stored provider responses and job history point at it again. **Redo** makes the change again. An undone change stays in the list as Undone.

Undo is offered while everything is still where the change put it. When a later change moved one of the parts, undo that change first; the button says so. A change that cannot be undone says so: tracks removed by an album track-list refresh, and merges recorded by an earlier version of the app that moved album positions or playlist entries.

### Automatic matches in History

Matches made by imports and the automatic rules are listed as Automatic, one by one, with their rule:

| Rule                                | Change                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Same title and artist               | A Last.fm import puts a scrobbled name on the library track with the same artist and title.                                  |
| Same title on the album             | A Last.fm import puts a name on the track of its scrobbled album with a matching title.                                      |
| Accepted search result              | A Last.fm import puts a name on the track of a Spotify search result you accepted.                                           |
| No longer matched                   | A Last.fm import returns a name to its own Last.fm track.                                                                    |
| Spotify track search                | An automatic Spotify track search links a track to its single compatible result.                                             |
| Album track list                    | The names of a Last.fm track linked to an album move to the track of the album's track list with a matching title.           |
| Album listening history             | A Last.fm-only track linked to an album gives its names and playlist entries to the listed track with its title and artist.  |
| Same Spotify track on the album     | An album recording gives its positions, playlist entries and names to the imported Spotify track of the same release.        |
| No longer on the album’s track list | An album track-list refresh removes recordings nothing else holds. History reads Removed “Night Drive”; it cannot be undone. |

A first full Last.fm import records every name it places, so History can hold many automatic changes after it.

Undoing an automatic match puts the names back, and the rule does not make that match again: the line reads “Will not be merged automatically again”. An undone Spotify track search is not applied again either. A search that gave an album recording the Spotify ID itself can be undone, but a later search can make it again. Undoing a search result you accepted also clears the acceptance.

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

When an imported track and a generated album position share an exact Spotify release, title and artist credits, the app can reconcile a split identity. It keeps ambiguous matches and recordings with conflicting duration or independent edits separate. Album track-list updates, playlist imports and **Refresh matches** can repair existing pairs while preserving the album position, playlist dates and listening history.

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
- A track's ISRCs are `provider_reference` rows on its media item with `reference_type` `isrc`, one per service and code, holding where each was read (`metadata.source`: playlist import, track search, manual addition, a stored track or search response, or the value already on the track). A track can have several, and one ISRC can sit on several tracks. `library_track.isrc` stays the primary ISRC that versions and track search use; a playlist import never replaces it with an empty value. Track details list every recorded ISRC with its service. `corepack pnpm --filter @repo/server recover:track-isrcs [--dry-run | --apply]` records the ISRCs already held in stored Spotify data and fills an empty primary value when the track's Spotify references agree on one code; it makes no provider requests and can be run again. See the [ISRC requirements](requirements/isrc-and-tidal.md).
- `playlist` rows carry their source (`spotify` or `spotify-liked`), Spotify ID, owner, artwork, snapshot, import time, last check time, schedule and whether the account can still change the playlist. `playlist_item` holds track and album memberships with position and added date.
- `spotify_playlist_listing` holds the account's last playlist list as one JSON array per user, with its listing time.
- `lastfm_track_source` maps each imported account, artist name and track name to one library track. It supplies Last.fm source membership, retention after playlist removal and the scrobble contribution to Added. Its `manually_matched` flag preserves confirmed recording choices; migration `0027_manual_track_matches` is required before deploying this merge workflow.
- `lastfm_track_link` separately records which scrobbled artist and track names count towards which library tracks, and by which listening-attribution rule. A name can contribute listening counts to several Spotify editions without giving them all Last.fm membership.
- `library_change` is the journal of changes to tracks, albums and artists: the kind and action, who made it and by which rule, the kept record and the records the names left as they were named then, what else it moved, and when it was undone. `library_change_move` holds each name the change moved with the track it left and the track it reached, and whether each match was made by hand. `library_change_removal` holds the archive of every track the change removed, which an undo restores and then deletes. `library_change_effect` holds the change's other effects, such as versions, album positions, playlist entries, editions and credits, and `library_change_batch` groups the changes of one automatic run. Migration `0054_library_change_journal` creates the first three tables and `0055_library_merge_stages` the rest. `GET /api/v1/library-changes` lists changes (`kind`, `actor`, `recordId`, `batchId`), `POST /api/v1/library-changes/track-merges/plan` previews a merge, `POST /api/v1/library-changes/track-merges` makes it and refuses a plan with cautions until `reviewed` is sent, and `POST /api/v1/library-changes/{id}/undo` and `/redo` reverse a change. The other merge endpoints are listed in the [library merge handover](library-merge-handover.md#how-it-is-put-together).
- `library_track.version_group_id` and `version_shown` store the versions of a record and the one it is shown as. `library_keep_separate` holds Keep separate decisions, `library_match_rejection` the matches automatic rules may not make again, and `track_duplicate_group` and `track_duplicate_member` the possible duplicates. `album.edition_of_id` points an edition at the first album of its record, and `artist.merged_into_id` points a merged artist at the kept one.
- Imports run as the `spotify-playlist-import` task job, listings as `spotify-playlist-listing`, album additions as `spotify-playlist-add-album` and track additions as `spotify-playlist-add-track`, all with provider `spotify`.

## Verification

- `apps/server/src/lib/track-matching.test.ts`: linking rules.
- `apps/server/src/lib/playlist-sync.test.ts`: schedule times.
- `apps/server/integration/spotify-playlists.integration.ts`: the listing job, import, progress, re-import, schedule, playlist pages, album additions with batches and a retried failure, refusals, removal, limits, filters, album membership and scrobble counts against a disposable database with mocked Spotify responses.
- `apps/server/integration/lastfm-tracks.integration.ts`: stored-history import, identity ambiguity, source filters, playlist removal, account history and playback metadata against a disposable database without provider requests.
- `apps/server/integration/library-changes.integration.ts` and `apps/server/src/routes/__tests__/library-changes-api.test.ts`: the merge plan and its cautions, a merge with undo and redo, a removed track restored with its provider data, links and edits, blocked tracks, later changes that stand in the way of an undo, and the endpoints, against a disposable database without provider requests.
- `apps/server/integration/track-versions.integration.ts`, `track-duplicates.integration.ts`, `album-merges.integration.ts`, `artist-merges.integration.ts`, `merge-follows.integration.ts` and `library-changes-automatic.integration.ts`: versions, Separate and Shown, possible duplicates and Keep separate, album and artist merges, what follows a merge, and automatic matches, each with the state after the change, after Undo and after Redo, and each reason Undo is refused, against a disposable database without provider requests.
- `apps/web/components/track-browser.test.tsx`, `apps/web/components/library-changes.test.tsx` and `apps/web/utils/library-changes.test.ts`: the selection column and Merge bar in the Tracks table, History rows and the wording of changes and cautions.
- `apps/web/components/track-record-parts.test.tsx`, `track-merge-review.test.tsx`, `track-duplicate-group.test.tsx`, `album-tracks-table.test.tsx`, `album-merge-review.test.tsx`, `album-editions.test.tsx`, `artist-merge-review.test.tsx` and `artist-detail.test.tsx`: Made of, the reviews, the duplicate group rows, the album track list selection, editions, kept names and the redirect from a merged artist.
- `apps/web/components/playlist-detail.test.tsx`, `apps/web/components/playlists.test.tsx`, `apps/web/components/play-controls.test.tsx`, `apps/web/utils/playlist-sync.test.ts` and `apps/web/utils/playlist-links.test.ts`: the playlist drawer, its deep link, sync labels and the track play controls.
