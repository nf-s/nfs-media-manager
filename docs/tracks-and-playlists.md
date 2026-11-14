# Tracks and Spotify Playlists

## Scope

Tracks are a separate library from albums. A track enters the library through an imported Spotify playlist, Liked Songs or stored Last.fm listening history. An album's own track list does not add library tracks. The two are linked where they describe the same recording; see [linking tracks to albums](#linking-tracks-to-albums).

The library selector has **Albums**, **Tracks**, **Films** and **Subscriptions**. **Playlists** in the navigation lists imported playlists; Tags, Imports, Jobs and Providers stay with the album library.

The only change the app makes on Spotify is [adding a library album to a playlist](#adding-an-album-to-a-playlist) when the owner asks. It never creates, renames, follows, reorders or removes from a Spotify playlist and never changes Liked Songs. There is no per-track metadata scrape, genre lookup or audio-feature collection.

## Connecting

Playlists need a connected Spotify account with the `playlist-read-private` and `playlist-read-collaborative` permissions, as well as `user-library-read` for Liked Songs. An account connected before playlist support does not have them: **Imports → Spotify playlists** shows a reconnect button, which returns to the same page afterwards. Adding albums also needs `playlist-modify-private` and `playlist-modify-public`, which are requested only when asked for; see [adding an album](#adding-an-album-to-a-playlist). Account setup is described in [Spotify account setup](spotify-album-imports.md#account-setup).

## Importing

**Imports → Spotify playlists** shows Liked Songs and the stored list of the account's playlists. **List playlists** queues a Spotify listing job, shown in Jobs with its progress, cancel and retry; it reads one page of 50 playlists per request and replaces the stored list. Opening the page reads only the stored list, with the time it was listed and the latest listing job. A second listing is not queued while one is queued or running, and the list is never re-read automatically.

Choose rows from the stored list and import, up to 100 at a time; each one becomes its own Spotify job in Jobs, where it can be cancelled or retried. One job per playlist runs at a time. A playlist missing from the stored list is skipped until the list is read again.

An import of a playlist first reads the playlist's details: one request that gives its current version and, only for a playlist the account owns or collaborates on, its item count. A playlist the account can no longer read fails without requesting its tracks. Otherwise the import reads the whole playlist in pages of 50 through the Spotify request gate (one request at a time, at least 1500 ms apart), then stores it in a single transaction:

- The playlist's tracks are replaced by what Spotify returned, in playlist order with each track's added date.
- A track that is no longer in any imported playlist is removed only when it has no imported Last.fm membership.
- A track's **Added** date is the earliest known playlist-added date or first scrobble represented by its imported Last.fm membership.
- A playlist whose Spotify snapshot has not changed since the last import is not read again; the import still counts as a completed check. Liked Songs has no snapshot and is always read.

Importing the same playlist again updates it. While an import or listing runs, its job records the pages read and the pages expected (`options.progress`), updated after every page; the total for a playlist comes from its item count, and for Liked Songs from the first page.

### Schedule

Each imported playlist and Liked Songs has its own schedule: off (the default), every 1, 3 or 6 hours, daily or weekly, the same choices as the YouTube and Last.fm schedules. It is measured from the last completed import of that playlist, including one that found it unchanged. Both runtimes check every five minutes when scraping is enabled and queue the playlist's normal import job, using the account of the owner who set the schedule.

The schedule queues nothing for a playlist whose import is queued or running, or while Spotify is cooling down or halted. After a failed or cancelled import it waits until the owner imports the playlist again. Legacy playlists without a Spotify source cannot be scheduled.

The schedule is set on the [playlist drawer's](#playlist-drawer) **Sync** tab. The Playlists table shows each playlist's schedule and last check.

| Limit                           | Behaviour                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playlists owned by someone else | Spotify returns the contents only of playlists the account owns or collaborates on. Others are listed but cannot be chosen, and their contents are never requested. Copy the playlist into your account to import it. |
| 10,000 tracks                   | A playlist or Liked Songs with more than 10,000 tracks fails before anything is stored.                                                                                                                               |
| Local files and episodes        | Entries without a Spotify track ID are skipped and counted in the job message.                                                                                                                                        |
| Refused request                 | A 401 or 403 from Spotify stops all Spotify requests until access is cleared in Providers, as for other Spotify jobs.                                                                                                 |

An imported playlist that shares its name with a playlist from the legacy album import becomes the same playlist, so its albums and tracks appear together. Otherwise a playlist whose name is already used is stored as "Name (owner)".

**Remove** on the Playlists page removes an imported playlist and tracks with no remaining playlist or Last.fm membership. Album memberships from the legacy import are kept.

### Last.fm tracks

In **Tracks**, choose **Import Last.fm tracks** to bring the configured account's already-stored listening history into the library. This refreshes track links from the database; it does not request history again or search Spotify. Completing a Last.fm sync and using **Relink** on the Last.fm page also refresh these tracks.

Each distinct scrobbled artist and track name is represented in the library. A unique matching Spotify library track is reused when its artist and title match, ignoring case and repeated spaces. Any supplied album names must also match, either by name or by all resolving to the same library album. Otherwise the name gets a Last.fm track with its listening history and known album name. Unknown metadata stays empty. Ambiguous matches and different live, remix or edit titles are not combined to choose a Spotify recording.

A track can have more than one source. Reusing a Spotify track adds **Last.fm** alongside **Spotify playlists** or **Liked Songs**. Repeating the import refreshes the existing tracks rather than adding another copy.

Existing installations must apply the database migration that allows `library_track.spotify_track_id` to be null before running the updated application. Then use **Import Last.fm tracks** to populate the library from stored history without another provider sync.

## Playlist drawer

Selecting a playlist's row or name on the Playlists page opens it in a drawer. A playlist shown in the Tracks table or in a track's details opens the same drawer over Tracks. The drawer is kept in the URL: `?playlist=<playlist ID>` opens it on the **Tracks** tab and `&tab=sync` on the **Sync** tab, on `/playlists` or `/tracks`, so back, forward, reload and shared links reopen it. Escape, the backdrop and the close button close it.

The header shows the name, source, owner, track count and duration, **Filter tracks** (Tracks filtered by the playlist, as a required filter) and a Spotify link when the playlist has one.

- **Tracks** lists the entries in playlist order with their added dates, then any album members from the legacy import, in the shared table. It reads 100 entries a page (`GET /api/v1/playlists/:id`) and loads the next page as the table scrolls. A track title opens the track: in the track drawer over Tracks, or on its own page from the Playlists page. On a phone-width screen the Album and Added columns are hidden.
- **Sync** sets the schedule (`PUT /api/v1/playlists/:id/sync-schedule`) and has **Sync now**, which queues the playlist's normal import (Liked Songs or the Spotify playlist) and shows the server's message if it is refused, for example a playlist missing from the stored playlist list. It shows when the playlist was last checked, when its contents were last stored, and the next scheduled import or why there is none: the schedule is off, an import is in progress, or the last import failed or was cancelled and waits for **Sync now**. The latest import job shows its status, "N of M pages" read (or "N pages" until the total is known), its error, its finish time and a link to it in Jobs. While it is queued or running the drawer reads the playlist again every two seconds, and when it ends the playlist, Playlists, Tracks and album playlist views are refreshed. A legacy playlist says it is not synced from Spotify.

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

## Browsing tracks

Tracks have their own table with search, [AI search](ai-search.md), filters, ranges, sorting and column choice, using the same URL parameters as albums.

| Field                    | Source                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| Title, Artists, Album    | Spotify playlist metadata or stored Last.fm names.                        |
| Released, Duration       | Spotify or a matched library album/track; empty when unknown.             |
| Source                   | Last.fm, Spotify playlists and/or Liked Songs.                            |
| Playlists                | Imported playlists containing the track, including Liked Songs.           |
| Added                    | Earliest playlist-added date or scrobble from its Last.fm membership.     |
| Library album            | "In library" or "Not in library".                                         |
| Album tags               | Tags of the linked library album. Empty when the album is not in library. |
| Scrobbles, Last listened | Linked Last.fm scrobbles; see [scrobbles](#scrobbles).                    |

Setting two or more playlists to **required** shows the tracks in all of them. A playlist in the **Playlists** column opens the [playlist drawer](#playlist-drawer), whose **Filter tracks** applies the filter.

Use **Source** to include or exclude **Last.fm**, **Spotify playlists** and **Liked Songs**, with the normal **Any**, **Required** and **Excluded** filter modes. Requiring both Last.fm and Spotify playlists shows their overlap; excluding Last.fm hides tracks with imported Last.fm membership. Source filters stay in the URL with the other browse filters.

Listening counts use broader matching rules than source membership. A Spotify track can therefore show scrobbles without having a Last.fm source. Those listening matches alone do not retain a track after its final playlist is removed or change its Added date.

A track's detail shows its sources, playlists (each opens the playlist drawer), Spotify link when available, listening history and, when its album is in the library, a link to the album and the album's tags, labelled as coming from the album. Last.fm tracks can inherit artwork and release date from their linked library album.

With [Spotify playback](spotify-playback.md) connected, each row of the Tracks table has a play button and, on hover, an add-to-queue button; the track drawer has **Play** and **Add to queue**; and in the playlist drawer a row's number plays the track on hover, as in an album's track list. A track plays on its own, not as part of its album or playlist. Tracks without a Spotify track ID have no play controls, and none appear while playback is off. The player dock opens the track's library album only when it has one.

### Spotify matching and playback

A Last.fm track can play immediately when it reuses a matched Spotify library track. A unique exact title match in its linked library album's stored Spotify track list can also supply a Spotify ID and duration. Neither path contacts Spotify. A standalone Last.fm track inherits a library album only when every supplied album name resolves to that album. A linked album alone is not enough to choose a playable track, and ambiguous titles are left without an ID.

Last.fm's [`user.getRecentTracks`](https://www.last.fm/api/show/user.getRecentTracks) supplies names and optional MusicBrainz IDs, not Spotify IDs, ISRCs or track durations. Some recordings can therefore be identified from existing library metadata, but the stored history cannot guarantee a Spotify match for every track.

For the remainder, a future **Search Spotify** action could search selected tracks by artist, title and album, retain candidates and let the owner choose the recording. Spotify's [search endpoint](https://developer.spotify.com/documentation/web-api/reference/search) supports those fields and ISRC, but no MusicBrainz ID filter. That would need the same request limits, stored search results and explicit selection used by the existing Last.fm album-search workflow; automatic whole-history searches are not implemented. Once a track ID is linked, the existing player can use it. Spotify [playback requires Premium](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback) and the playback connection described above.

## Albums and playlists

An album is in a playlist when it is a member itself (legacy import) or when a library track linked to it is in the playlist. The album **Playlists** filter, its facet counts and the playlist chips on album cards and details use both. Album details list each playlist with the linked tracks it contains.

## Linking tracks to albums

Each track links to at most one library album. Links are recomputed after every playlist import, after every scrobble sync and by **Relink** on the Last.fm page, so an album added later picks up its tracks. Standalone Last.fm tracks use the album links of their scrobbles when all supplied album names resolve to one album. For Spotify library tracks, the first rule that finds an album decides:

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

- A track is a `media_item` with media type `track` and a `library_track` row holding its optional Spotify track and album IDs, album name, duration, linked album and listening totals. The Spotify track ID is nullable for Last.fm tracks without a verified match. Per-item scrape jobs, tags and file imports do not operate on tracks.
- `playlist` rows carry their source (`spotify` or `spotify-liked`), Spotify ID, owner, artwork, snapshot, import time, last check time, schedule and whether the account can still change the playlist. `playlist_item` holds track and album memberships with position and added date.
- `spotify_playlist_listing` holds the account's last playlist list as one JSON array per user, with its listing time.
- `lastfm_track_source` maps each imported account, artist name and track name to one library track. It supplies Last.fm source membership, retention after playlist removal and the scrobble contribution to Added.
- `lastfm_track_link` separately records which scrobbled artist and track names count towards which library tracks, and by which listening-attribution rule. A name can contribute listening counts to several Spotify editions without giving them all Last.fm membership.
- Imports run as the `spotify-playlist-import` task job, listings as `spotify-playlist-listing` and album additions as `spotify-playlist-add-album`, all with provider `spotify`.

## Verification

- `apps/server/src/lib/track-matching.test.ts`: linking rules.
- `apps/server/src/lib/playlist-sync.test.ts`: schedule times.
- `apps/server/integration/spotify-playlists.integration.ts`: the listing job, import, progress, re-import, schedule, playlist pages, album additions with batches and a retried failure, refusals, removal, limits, filters, album membership and scrobble counts against a disposable database with mocked Spotify responses.
- `apps/server/integration/lastfm-tracks.integration.ts`: stored-history import, identity ambiguity, source filters, playlist removal, account history and playback metadata against a disposable database without provider requests.
- `apps/web/components/playlist-detail.test.tsx`, `apps/web/components/playlists.test.tsx`, `apps/web/components/play-controls.test.tsx`, `apps/web/utils/playlist-sync.test.ts` and `apps/web/utils/playlist-links.test.ts`: the playlist drawer, its deep link, sync labels and the track play controls.
