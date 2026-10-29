# Albums, music and playlists

## Existing behaviour and data

`Models/Album.tsx` and `music/clean/index.ts` define title, artists, artwork, duration, release/added dates, genres, countries, playlist memberships, provider IDs and links. Latest cleaned album title/art/artist selection is authoritative for initial browse parity; a different release returned by another service must not silently replace it.

Retain, display, filter and sort scrobbles; RYM rating/votes; Discogs rating/votes/popularity; Metacritic rating/votes; Spotify popularity; and Last.fm listeners. Preserve raw rating units, distinguish milliseconds/seconds correctly, and use UTC dates. Zero is a valid value. Default browse order is added date descending.

Spotify audio features are intentionally discontinued. Remove existing acousticness, danceability, energy, instrumentalness, liveness, loudness, musical mode/key, speechiness, tempo, valence, time signatures, analysis URLs and audio-feature containers from active storage, not just UI. Original source JSON and private restore backups remain unchanged. This is the sole targeted exception to raw-provider preservation below. Do not delete unrelated configuration/filter `mode` values, ratings, popularity, duration or track identity. See [cleanup and audit procedure](../spotify-audio-feature-removal.md).

## Requirements

- MUSIC-01: Preserve every current cleaned album and all raw provider snapshots; match by provider references to canonical IDs. Keep non-Spotify provider references and support future services without changing IDs.
- MUSIC-02: A clearly labelled Spotify outbound link is visible on cards, table/detail views when available. Other service links include MusicBrainz, Discogs, Last.fm, RYM/Sonemic and Metacritic. Do not fabricate broken URLs for missing IDs.
- MUSIC-03: Overview shows art, title, artists, dates, duration, useful ratings and clickable genres/countries/playlists. Tracks are a separate tab, not an unexplained wall of default content. Preserve disc/track order, artists, duration and external IDs.
- MUSIC-04: Preserve artist metadata used to derive genres/countries, blacklist/missing-match information, playlist memberships and playlist definitions. The old empty Playlist UI is not a working feature; imported playlists should instead be browseable through their memberships and saved views.
- MUSIC-05: Smart playlist definitions retain name, filter modes/ranges, sort, limit and provider destination. Preview locally. Never mutate remote playlists implicitly; publishing/synchronization requires a separate explicit action.
- MUSIC-06: Existing optional playback included sign-in, album play, queue album/track, a queue playlist, device selection and save. Earlier agreed scope replaces these with outbound links; do not silently recreate remote playlists or initiate OAuth during testing.
- MUSIC-07: Audio-feature cleanup is explicit, backed up, auditable and idempotent. Remove retired feature values from raw snapshots, current provider state, normalized metadata, tracks, overrides, stored job payloads and saved-view filters/sorts. Keep history rows, timestamps and references. Legacy imports and provider persistence must not reintroduce them; no audio-feature fetches or browse fields remain supported.

## Acceptance

Reconcile all 3,360 current albums against cleaned input, excluding only retired audio features while preserving every other nonempty metric, dates and links. Test an album with zero values, one with many genres, one missing artwork, one with Spotify data and one with playlist membership. Verify raw snapshots and track lists match input apart from this targeted removal without making Spotify requests. A cleanup dry run after apply must report zero changed rows; retained backup copies must contain the original removed values.
