# Tracks and Spotify Playlists

## Scope

Tracks are a separate library from albums. A track is in the library because it is in an imported Spotify playlist or in Liked Songs, not because its album is. An album's own track list is unchanged, and most album tracks are not library tracks. The two are linked where they describe the same recording; see [linking tracks to albums](#linking-tracks-to-albums).

The library selector has **Albums**, **Tracks** and **Films**. **Playlists** in the navigation lists imported playlists; Tags, Imports, Jobs and Providers stay with the album library.

The only change the app makes on Spotify is [adding a library album to a playlist](#adding-an-album-to-a-playlist) when the owner asks. It never creates, renames, follows, reorders or removes from a Spotify playlist and never changes Liked Songs. There is no per-track metadata scrape, genre lookup or audio-feature collection.

## Connecting

Playlists need a connected Spotify account with the `playlist-read-private` and `playlist-read-collaborative` permissions, as well as `user-library-read` for Liked Songs. An account connected before playlist support does not have them: **Imports → Spotify playlists** shows a reconnect button, which returns to the same page afterwards. Adding albums also needs `playlist-modify-private` and `playlist-modify-public`, which are requested only when asked for; see [adding an album](#adding-an-album-to-a-playlist). Account setup is described in [Spotify account setup](spotify-album-imports.md#account-setup).

## Importing

**Imports → Spotify playlists** shows Liked Songs and the stored list of the account's playlists. **List playlists** queues a Spotify listing job, shown in Jobs with its progress, cancel and retry; it reads one page of 50 playlists per request and replaces the stored list. Opening the page reads only the stored list, with the time it was listed and the latest listing job. A second listing is not queued while one is queued or running, and the list is never re-read automatically.

Choose rows from the stored list and import, up to 100 at a time; each one becomes its own Spotify job in Jobs, where it can be cancelled or retried. One job per playlist runs at a time. A playlist missing from the stored list is skipped until the list is read again.

An import of a playlist first reads the playlist's details: one request that gives its current version and, only for a playlist the account owns or collaborates on, its item count. A playlist the account can no longer read fails without requesting its tracks. Otherwise the import reads the whole playlist in pages of 50 through the Spotify request gate (one request at a time, at least 1500 ms apart), then stores it in a single transaction:

- The playlist's tracks are replaced by what Spotify returned, in playlist order with each track's added date.
- A track that is no longer in any imported playlist is removed from the library.
- A track's **Added** date is the earliest date it was added to any imported playlist.
- A playlist whose Spotify snapshot has not changed since the last import is not read again; the import still counts as a completed check. Liked Songs has no snapshot and is always read.

Importing the same playlist again updates it. While an import or listing runs, its job records the pages read and the pages expected (`options.progress`), updated after every page; the total for a playlist comes from its item count, and for Liked Songs from the first page.

### Schedule

Each imported playlist and Liked Songs has its own schedule: off (the default), every 1, 3 or 6 hours, daily or weekly, the same choices as the YouTube and Last.fm schedules. It is measured from the last completed import of that playlist, including one that found it unchanged. Both runtimes check every five minutes when scraping is enabled and queue the playlist's normal import job, using the account of the owner who set the schedule.

The schedule queues nothing for a playlist whose import is queued or running, or while Spotify is cooling down or halted. After a failed or cancelled import it waits until the owner imports the playlist again. Legacy playlists without a Spotify source cannot be scheduled.

| Limit                           | Behaviour                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playlists owned by someone else | Spotify returns the contents only of playlists the account owns or collaborates on. Others are listed but cannot be chosen, and their contents are never requested. Copy the playlist into your account to import it. |
| 10,000 tracks                   | A playlist or Liked Songs with more than 10,000 tracks fails before anything is stored.                                                                                                                               |
| Local files and episodes        | Entries without a Spotify track ID are skipped and counted in the job message.                                                                                                                                        |
| Refused request                 | A 401 or 403 from Spotify stops all Spotify requests until access is cleared in Providers, as for other Spotify jobs.                                                                                                 |

An imported playlist that shares its name with a playlist from the legacy album import becomes the same playlist, so its albums and tracks appear together. Otherwise a playlist whose name is already used is stored as "Name (owner)".

**Remove** on the Playlists page removes an imported playlist and the tracks that were only in it. Album memberships from the legacy import are kept.

A playlist's own page lists its tracks in playlist order with their added dates, then any album members from the legacy import, 100 entries a page by default.

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
| Title, Artists, Album    | Spotify, as returned with the playlist.                                   |
| Released, Duration       | Spotify.                                                                  |
| Playlists                | Imported playlists containing the track, including Liked Songs.           |
| Added                    | Earliest added date across those playlists.                               |
| Library album            | "In library" or "Not in library".                                         |
| Album tags               | Tags of the linked library album. Empty when the album is not in library. |
| Scrobbles, Last listened | Linked Last.fm scrobbles; see [scrobbles](#scrobbles).                    |

Setting two or more playlists to **required** shows the tracks in all of them. Opening a playlist from the Playlists page shows Tracks filtered by that playlist.

A track's detail shows its playlists, Spotify link, listening history and, when its album is in the library, a link to the album and the album's tags, labelled as coming from the album.

## Albums and playlists

An album is in a playlist when it is a member itself (legacy import) or when a library track linked to it is in the playlist. The album **Playlists** filter, its facet counts and the playlist chips on album cards and details use both. Album details list each playlist with the linked tracks it contains.

## Linking tracks to albums

Each track links to at most one library album. Links are recomputed after every playlist import, after every scrobble sync and by **Relink** on the Last.fm page, so an album added later picks up its tracks. The first rule that finds an album decides:

| Rule             | Links when                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spotify album    | The track's Spotify album ID is a Spotify album reference of the library album.                                                                              |
| Spotify track    | The track's Spotify ID is in the album's stored track list.                                                                                                  |
| Album title      | A credited artist of the track is credited on an album whose title matches without edition qualifiers, and the album's track list has the track or is empty. |
| Artist and title | A credited artist of the track is credited on an album whose track list has the track.                                                                       |

Track titles are compared without featured credits, remaster notes and "original mix" style qualifiers; a live, remix or edit title is a different track. Between several fitting albums the exact album title wins, then the earliest release. Hidden albums are not linked. There is no manual override.

## Scrobbles

Stored Last.fm scrobbles link to library tracks by artist and track name. A scrobbled name counts towards every track the first fitting rule finds, so two Spotify listings of one recording share its scrobbles.

| Rule                  | Links when                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Same artist and title | The names match, ignoring case and repeated spaces.                                                                      |
| Ignoring punctuation  | As above, also ignoring accents, punctuation, `&` against "and" and a leading "The" on the artist.                       |
| Same version          | The titles match once featured credits and remaster notes are removed.                                                   |
| Linked album          | The scrobble is linked to the track's library album and exactly one library track on that album has the same base title. |

**Scrobbles** and **Last listened** on a track come from these links and are refreshed with them. Syncing and album linking are described in [Last.fm scrobble history](lastfm-scrobbles.md).

## Data model

- A track is a `media_item` with media type `track` and a `library_track` row holding its Spotify track and album IDs, album name, duration, linked album and listening totals. Scrape jobs, tags and imports do not operate on tracks.
- `playlist` rows carry their source (`spotify` or `spotify-liked`), Spotify ID, owner, artwork, snapshot, import time, last check time, schedule and whether the account can still change the playlist. `playlist_item` holds track and album memberships with position and added date.
- `spotify_playlist_listing` holds the account's last playlist list as one JSON array per user, with its listing time.
- `lastfm_track_link` records which scrobbled artist and track names count towards which library track, and by which rule.
- Imports run as the `spotify-playlist-import` task job, listings as `spotify-playlist-listing` and album additions as `spotify-playlist-add-album`, all with provider `spotify`.

## Verification

- `apps/server/src/lib/track-matching.test.ts`: linking rules.
- `apps/server/src/lib/playlist-sync.test.ts`: schedule times.
- `apps/server/integration/spotify-playlists.integration.ts`: the listing job, import, progress, re-import, schedule, playlist pages, album additions with batches and a retried failure, refusals, removal, limits, filters, album membership and scrobble counts against a disposable database with mocked Spotify responses.
