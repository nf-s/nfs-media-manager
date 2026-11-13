# Tracks and Spotify Playlists

## Scope

Tracks are a separate library from albums. A track is in the library because it is in an imported Spotify playlist or in Liked Songs, not because its album is. An album's own track list is unchanged, and most album tracks are not library tracks. The two are linked where they describe the same recording; see [linking tracks to albums](#linking-tracks-to-albums).

The library selector has **Albums**, **Tracks** and **Films**. **Playlists** in the navigation lists imported playlists; Tags, Imports, Jobs and Providers stay with the album library.

Playlist access is read-only. The app never creates, edits, follows or reorders a Spotify playlist and never changes Liked Songs. There is no per-track metadata scrape, genre lookup or audio-feature collection.

## Connecting

Playlists need a connected Spotify account with the `playlist-read-private` and `playlist-read-collaborative` permissions, as well as `user-library-read` for Liked Songs. An account connected before playlist support does not have them: **Imports → Spotify playlists** shows a reconnect button, which returns to the same page afterwards. Account setup is described in [Spotify account setup](spotify-album-imports.md#account-setup).

## Importing

**Imports → Spotify playlists** shows Liked Songs and, after **List playlists**, every playlist in the connected account. Reading the list takes one request per 50 playlists and is never repeated automatically. Choose rows and import, up to 100 at a time; each one becomes its own Spotify job in Jobs, where it can be cancelled or retried. One job per playlist runs at a time.

An import reads the whole playlist in pages of 50 through the Spotify request gate (one request at a time, at least 1500 ms apart), then stores it in a single transaction:

- The playlist's tracks are replaced by what Spotify returned, in playlist order with each track's added date.
- A track that is no longer in any imported playlist is removed from the library.
- A track's **Added** date is the earliest date it was added to any imported playlist.
- A playlist whose Spotify snapshot has not changed since the last import is not read again. Liked Songs has no snapshot and is always read.

Importing the same playlist again updates it. Nothing is refreshed on a schedule.

| Limit                           | Behaviour                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playlists owned by someone else | Spotify returns the contents only of playlists the account owns or collaborates on. Others are listed but cannot be chosen, and their contents are never requested. Copy the playlist into your account to import it. |
| 10,000 tracks                   | A playlist or Liked Songs with more than 10,000 tracks fails before anything is stored.                                                                                                                               |
| Local files and episodes        | Entries without a Spotify track ID are skipped and counted in the job message.                                                                                                                                        |
| Refused request                 | A 401 or 403 from Spotify stops all Spotify requests until access is cleared in Providers, as for other Spotify jobs.                                                                                                 |

An imported playlist that shares its name with a playlist from the legacy album import becomes the same playlist, so its albums and tracks appear together. Otherwise a playlist whose name is already used is stored as "Name (owner)".

**Remove** on the Playlists page removes an imported playlist and the tracks that were only in it. Album memberships from the legacy import are kept.

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
- `playlist` rows carry their source (`spotify` or `spotify-liked`), Spotify ID, owner, artwork, snapshot and import time. `playlist_item` holds track and album memberships with position and added date.
- `lastfm_track_link` records which scrobbled artist and track names count towards which library track, and by which rule.
- Imports run as the `spotify-playlist-import` task job with provider `spotify`.

## Verification

- `apps/server/src/lib/track-matching.test.ts`: linking rules.
- `apps/server/integration/spotify-playlists.integration.ts`: listing, import, re-import, removal, limits, filters, album membership and scrobble counts against a disposable database with mocked Spotify responses.
