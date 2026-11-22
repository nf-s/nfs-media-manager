# ISRC and TIDAL matching

TIDAL is added as a catalogue, matching and related-music source. Spotify stays the only player: nothing plays through TIDAL, whose third-party playback is limited to 30-second previews. The build has three stages, each released through `main` on its own:

1. ISRC recovery and ISRC as an identifier.
2. A TIDAL provider that matches albums by UPC and tracks by ISRC.
3. Similar albums and tracks from TIDAL, mapped back to Spotify for playback.

## Stage 1: ISRC as an identifier

- ISRC-01: An ISRC is a provider reference on the library track: a `provider_reference` row with `reference_type` `isrc`, `provider` set to the service that reported it (`spotify` now, `tidal` from stage 2) and `external_id` set to the normalised code: 12 characters, uppercase, hyphens and spaces removed. A value that is not a valid ISRC is not stored. `metadata` records where the code was read: the kind of source (playlist import, track search, album job, legacy import), the snapshot, response or job it came from, and when.
- ISRC-02: A track can hold several ISRCs, and one ISRC can sit on several library tracks (the same recording on an album, a compilation and a playlist). Lookup by ISRC uses the existing `(reference_type, external_id)` index on `provider_reference`.
- ISRC-03: `library_track.isrc` stays the primary ISRC that recording groups, track search and the Tracks API read. Recovery fills it only when it is empty, with the ISRC of the track's own Spotify track object. It never replaces a stored value. Where references disagree with the primary value, every code stays stored and is listed in the track's details.
- ISRC-04: Recovery reads only data already stored: the ISRC already on a library track, Spotify track and search responses stored by artist enrichment and track search, and the candidates saved by track search jobs. A track object is matched to a library track by Spotify track ID only, so a search candidate gives its ISRC to the library track with that Spotify ID, never to the track it was searched for. Album payloads hold only simplified track objects without ISRCs, and playlist imports write the ISRC directly. Running recovery again changes nothing. A playlist import never replaces a stored ISRC with an empty one, and each import, track search and manual addition records its ISRC as a reference too.
- ISRC-05: Album UPCs found in stored Spotify album payloads but missing from the album's references are recorded the same way, as `spotify` `upc` references. (On 2026-11-22 every stored album UPC was already a reference.)
- ISRC-06: The legacy Spotify responses are present in the app. Legacy Spotify responses that are on disk but not in the database are imported as provider snapshots attributed to the legacy import, through the existing legacy import path, which reuses an identical earlier snapshot. The result of the search, the import and what remains missing is reported to the owner.
- ISRC-07: Recovery writes in bounded batches so that each statement stays small for the Browse cache and duplicate-group triggers. A run in a scheduled Worker invocation issues tens of statements, not thousands.
- ISRC-08: Track details list every ISRC with the service it came from. The Spotify track search review in Tracks → Matches shows the library track's ISRC above the candidates' ISRCs. Both use existing components.
- ISRC-09: Tracks with a Spotify ID and no ISRC after recovery, nearly all from album track lists, need new Spotify requests. Spotify's batch track endpoint (`GET /v1/tracks?ids=`, up to 50 IDs) still answered for this app on 2026-11-22, so this is one request per 50 tracks. That fetch is a Spotify job that stores its responses, and it is not started until the owner agrees to the request count and rate.

Why a provider reference and not a column or a new table: a single column cannot hold several codes or say where each came from. `provider_reference` already gives a per-provider source, a unique key per item, provider, type and value, an index for lookup by value and removal with the media item, and album UPCs already use it. A dedicated table would duplicate those.

## Stage 2: TIDAL provider

Needs the owner's agreement on these requirements first. A small live test (about ten albums by UPC and twenty tracks by ISRC, dance releases included) runs before the build, and the design is adjusted to what it shows.

- TIDAL-01: A built-in provider `tidal` for albums and tracks. It uses the client-credentials grant; the token is cached until shortly before it expires and never reaches the browser. The client ID and secret are provider secrets (`TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`).
- TIDAL-02: Requests go through the project's request gate with a concurrency of one until the live test shows otherwise. A 429 starts a cooldown from its `Retry-After` header or a conservative default. Every request and response is stored like every other provider's, and every payload is validated with a schema before use.
- TIDAL-03: Albums match by UPC with `filter[barcodeId]` only, never by a text search. A match stores the TIDAL album ID and link as a `tidal` reference. The album's TIDAL tracks are then aligned to the library album's tracks by position, duration and title. An aligned track gains its TIDAL track ID, its ISRC as a `tidal` `isrc` reference, and BPM and key in its TIDAL provider data.
- TIDAL-04: Tracks match by ISRC with `filter[isrc]`. When several TIDAL tracks share the ISRC, the choice uses the album UPC, then duration, then version. A track that is still ambiguous is offered for review in Tracks → Matches instead of being guessed.
- TIDAL-05: A job is one provider and one media item. Metadata selection shows TIDAL freshness like the other providers. A bulk run is started by the owner and checked on one item first.

## Stage 3: Similar albums and tracks

Needs the owner's agreement on these requirements and their choice of an interface concept.

- SIMILAR-01: For a matched album, TIDAL `similarAlbums`; for a matched track, the most useful of `similarTracks`, `radio` and `suggestedTracks`, chosen after comparing them on a few dance tracks. Results are stored as the TIDAL provider data of the item they were read for, not as library items, and are read by a TIDAL job.
- SIMILAR-02: Each suggestion is mapped for playback through Spotify: first to library items by ISRC or UPC, then, for the rest, by a Spotify `isrc:` or `upc:` search, storing the Spotify ID found. A suggestion is shown as in the library, on Spotify only, or with no Spotify match.
- SIMILAR-03: A suggestion in the library opens it. One on Spotify only can be played or queued with the existing play controls and opened on Spotify. One with no Spotify match links to TIDAL and has no play control. Nothing starts playing unless the owner presses play.
- SIMILAR-04: The interface follows the concept the owner accepts and is added to the design system before the feature uses it.

## Not in scope

TIDAL account sign-in, TIDAL playlists and TIDAL playback. A later stage that needs the owner's TIDAL account uses the callback route `/api/v1/tidal/callback`, which is registered with TIDAL.
