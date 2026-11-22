# Sonovault identifiers and track facts

Status: stage 1 (SONO-01 to SONO-12) and stage 4 (SONO-23 to SONO-25) are built and released through `main`. The owner agreed on 2026-11-22 to stages 1 to 4 and to SONO-26 from stage 5, built side by side where they do not depend on each other, with a live run on one large playlist and the album library. The other stage 5 uses wait until asked for.

Sonovault is a paid lookup service. Given a track's ISRC or its ID on one service, it returns the same recording's IDs on the other services, with its ISRC, tempo, key, genre, label and releases. It is added as a provider that fills identifiers and track facts. It does not play music and it has no similar-track or recommendation endpoint, so TIDAL and Last.fm stay the sources of related music. If it stops being good enough, another lookup provider can take its place: everything it reports is stored under its own provider name and can be removed or replaced without touching what other providers reported.

The build has five stages, each released through `main` on its own:

1. The provider, and track lookups by Spotify ID or ISRC.
2. Tempo, key and genre on tracks.
3. Albums, through Sonovault releases.
4. Tracks with no identifier, by artist and title, for review.
5. Later uses, each only when the owner asks for it. SONO-26 is asked for.

## What the service returns

Checked against its published API specification and with live requests on 2026-11-22.

- A track: Sonovault track ID, title, duration, one ISRC, tempo (BPM, two decimals), key in three notations (musical, Camelot, Open Key) with the tool that measured it, genre and subgenre lists, artists each marked primary or remixer, and the releases it is on (release ID, title, artist, label, release date).
- A track's links: at most one ID and URL each for Spotify, Apple Music, TIDAL, Beatport, Discogs (release ID and track position), MusicBrainz (recording ID) and YouTube (video ID).
- A release (`GET /v1/releases/{id}`): title, artist, label, catalogue number, release date, digital UPC, MusicBrainz release and release-group IDs, every track with the track fields above and its disc and track number, and its editions. An edition is one listing on Spotify, Discogs, MusicBrainz, Beatport or Apple Music: that service's ID, a group ID (the Discogs master), kind, format, country, date, barcode, label, catalogue number and track count.
- An artist: country, year formed, social links, Wikidata ID, MusicBrainz artist ID, release count, and a dated feed of releases.
- A label: release and artist counts, a dated feed of releases, and its artists.
- For a composition code (ISWC): every recording of that composition, and the ISWCs of a recording.
- Paid plans add: 20 tracks by label, artist, genre or year (newest, or random from the popular ones), a feed of all new releases, and recognition of a track from an audio file.

Lookups: one track by ISRC, Sonovault ID or artist and title; one release by Sonovault ID or by title; and a bulk call (`POST /v1/tracks/resolve`) that takes up to 100 ISRCs, Spotify, Apple Music, TIDAL, Beatport, Discogs or MusicBrainz IDs, or artist-and-title pairs, and returns each track with its links. A release cannot be looked up by UPC or by a service's album ID, and the bulk call does not take releases. An album is reached through one of its tracks (stage 3).

What it does not have: similar or recommended tracks, lyrics, artwork, audio previews, popularity figures. Its "suggestions" endpoints submit genre corrections to Sonovault; they are not recommendations.

Live test (2026-11-22, three random samples of 1,000 library tracks and 32 library albums, chosen read-only):

- By ISRC: 99.8% found. By Spotify track ID: 99% found, and 99.6% of those came with an ISRC. On tracks whose ISRC was already stored, the ISRC returned for the Spotify ID equalled it for 91%; two thirds of the rest shared the stored code's registrant, which points to another issue of the same recording.
- Sonovault keeps one Spotify ID per recording. It recognised the library's Spotify IDs, but the Spotify ID it returned was a different one for half of the tracks: the same recording on another release.
- On tracks found by ID: Apple Music and TIDAL IDs for 96%, YouTube for 95%, MusicBrainz for 83 to 92%, Discogs for 75 to 84%, Beatport for 60 to 73%, tempo and key for 90%.
- About 8% of records carried another version's duration or title on the ISRC asked for (an extended mix listed at the radio edit's length), so the tempo, key and links of those records may belong to a different mix.
- By artist and title, on tracks with no identifier: 94% returned a track, with an exactly equal title for 83% of those. The search ignores version text: an edit or remix can return the original, or the reverse.
- Albums: the first track of 32 albums was looked up by Spotify track ID, and its release fetched. 28 releases were confirmed as the library album: 25 by an edition holding the album's Spotify ID, 26 by barcode, 23 by MusicBrainz release group. 88% of the tracks on those releases had an ISRC and 84% a tempo. A Sonovault release merges every edition, so 17 of the 28 listed more tracks than the library album. Release search by title found the same release for 25 of the 28, but its results carried no UPC.
- One bulk response for 100 tracks was about 115 KB. Each response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and the bulk response states the credits left for the month.

## Stage 1: Provider and track lookups by ID

- SONO-01: A built-in provider `sonovault` for tracks and albums. Its API key is a provider secret (`SONOVAULT_API_KEY`) sent in the `x-api-key` header; it never reaches the browser. The plan's limits (requests per minute, credits per month) are provider settings with the Starter plan's values as defaults: 60 and 50,000.
- SONO-02: Every request goes through the project's request gate, one at a time and at least 1.1 seconds apart. A 429 starts a cooldown for the seconds in `RateLimit-Reset`. Credits are charged per input line, not per request, so the monthly budget counts lines: before a batch the job compares its size with the credits the last response reported, and a bulk run stops when a reserve (default 2,000 credits) would be crossed. A `skipped_no_credits` line is left unlooked-up and is not recorded as a miss.
- SONO-03: Every request and response is stored with its job, like every other provider's, and every payload is validated with a schema before use. A stored response is the source for every later stage: tempo, key, genre, release and artist facts are read from stored responses where one exists, and a new request is made only for what no stored response answers.
- SONO-04: A track lookup job takes library tracks that have a Spotify track ID or an ISRC and sends them through the bulk call, up to 100 per request: by Spotify ID where the track has one, otherwise by ISRC. A lookup by ID needs no text matching: the input is the library track.
- SONO-05: Each link of a matched track is stored as a provider reference on the library track with provider `sonovault` and a reference type that names the service and kind: `spotify-track`, `applemusic-track`, `tidal-track`, `beatport-track`, `musicbrainz-recording`, `discogs-release-track`, `youtube-video`, and `sonovault-track` for its own ID. `metadata` holds the URL, the response it was read from and when. The ISRC is stored as an `isrc` reference with provider `sonovault`, as in ISRC-01.
- SONO-06: A reference reported by Sonovault never replaces or removes an identifier another provider reported. The library track's Spotify track ID is never changed by this provider: its `spotify-track` reference is the recording's representative Spotify ID and is kept only as a reference.
- SONO-07: A track's primary ISRC (`library_track.isrc`, ISRC-03) is filled from Sonovault only when it is empty and only for a lookup by Spotify ID. The value is marked as Sonovault's. An ISRC that Spotify later reports for the track replaces it; this is the one case where a primary ISRC is replaced.
- SONO-08: Each matched record is compared with the library track before its facts are trusted: the durations agree within five seconds where both are known, and the titles agree once case, punctuation and the notation of version text are ignored. A record that fails is stored with its references marked unverified. Unverified references are listed in track details and are not used by other features.
- SONO-09: A lookup that finds nothing is recorded with its date and is not repeated for 30 days.
- SONO-10: Sonovault's terms require stored results to be refreshed within 12 months of the request that returned them and removed within 30 days of the subscription ending. Every stored response, reference and fact from this provider carries the date it was fetched. A refresh job re-requests records older than 11 months. One action removes everything stored from this provider: responses, references, facts, and any primary ISRC marked as Sonovault's. Because every row carries the provider name, that removal is one bounded set of statements.
- SONO-11: Fixtures and documentation use invented responses. Real Sonovault responses are not committed, published or passed to another service.
- SONO-12: Track details list the Sonovault references with the other sources, each opening its service page. Metadata selection shows Sonovault freshness like the other providers. A bulk run is started by the owner and checked on one track, then one request of 100, before the rest. This uses existing components.

Why its own provider name and reference types: a link from Sonovault is a claim by Sonovault, not a match that TIDAL, Discogs or MusicBrainz confirmed, and one record in twelve belongs to another version. Kept apart, such a link cannot be mistaken for a confirmed match, the removal and refresh the terms require stay simple, and a later lookup provider can be added beside it or instead of it.

This stage replaces the Spotify fetch in ISRC-09: tracks with a Spotify ID and no ISRC get one from Sonovault at one credit a track, with no Spotify requests.

## Stage 2: Tempo, key and genre on tracks

- SONO-13: A verified Sonovault record (SONO-08) gives the library track a tempo, a key and genre and subgenre names. They are stored as track facts attributed to `sonovault` with the fetch date, read from the responses stage 1 stored. No new requests are made for tracks already looked up.
- SONO-14: Track details show tempo and key with their source. Tracks Browse gains tempo and key as columns, sort orders, a tempo range filter and a key filter, through the shared Browse pattern and the existing `bpm` field format. The key is shown in one notation chosen in settings (musical, Camelot or Open Key); all three are stored.
- SONO-15: Genres and subgenres become track tags attributed to `sonovault`, placed in the tag hierarchy by the existing tag rules. A genre name with no place in the hierarchy is listed for the owner and is not added automatically.
- SONO-16: MUSIC-07 retired Spotify's audio features and stays in force for them. Tempo and key from Sonovault are new fields from a different source and do not bring those values back; MUSIC-07's wording is narrowed to name Spotify's audio features.
- SONO-17: An unverified record's tempo and key are stored and not shown in Browse. Track details show them marked as possibly belonging to another version.

## Stage 3: Albums through releases

- SONO-18: An album is looked up through one of its tracks. The job takes a track of the library album that has a Sonovault record, or looks one up by Spotify ID or ISRC (one credit), reads the releases on that record, and fetches each candidate release (one credit each, five at most).
- SONO-19: A release is accepted as the library album only when an identifier confirms it: one of its editions holds the album's Spotify album ID, a barcode equals the album's UPC with leading zeros ignored, or its MusicBrainz release group equals the album's. Titles alone never confirm an album. A release that no identifier confirms is recorded as not found.
- SONO-20: The accepted release is read in the numbering of the edition that matched (`edition` parameter), and its tracks are aligned to the library album's tracks by position, duration and title, as in TIDAL-03. An aligned track gains the references and facts of stages 1 and 2 without a lookup of its own, so an album costs two credits whatever its length. Tracks that do not align keep nothing and can still be looked up singly.
- SONO-21: The album gains `sonovault` references for the release ID, the digital UPC, and each edition's Discogs release and master, MusicBrainz release and release group, Beatport and Apple Music IDs, with the label and catalogue number of the matched edition.
- SONO-22: Where the album's stored Discogs master or MusicBrainz release group differs from the one on the confirmed Sonovault release, the album is listed for match review with both values. Where the album has no Discogs or MusicBrainz match, Sonovault's ID is offered as a candidate in the existing album match review. Nothing is changed without the review.

Why through a track: the service has no release lookup by UPC or album ID, and its title search returns no UPC to confirm a result. A track's Spotify ID or ISRC is exact, and the release it leads to carries the identifiers that confirm the album.

## Stage 4: Tracks with no identifier

- SONO-23: Library tracks with neither a Spotify ID nor an ISRC are looked up by artist and title, in bulk. A result is a candidate, never a match by itself.
- SONO-24: A candidate is accepted automatically only when the artist is equal, the title is equal including its version text, and the duration agrees within five seconds. A track with no stored duration is never accepted automatically. Every other candidate goes to Tracks → Matches beside the Spotify search candidates, showing its title, artists, release, duration and ISRC, with the same accept and reject controls.
- SONO-25: An accepted candidate gives the track its references and ISRC. A Spotify track ID is taken from the candidate only on acceptance, and through the existing acceptance path, so that the uniqueness of Spotify IDs and the duplicate groups are handled as they are for a Spotify search match.

## Stage 5: Later uses

Each is a separate piece of work, started only when the owner asks for it.

- SONO-26: Similar tracks from TIDAL are mapped to Spotify by sending their ISRCs through the bulk call, in place of one Spotify search per suggestion. Similar albums keep the Spotify lookup by UPC, because Sonovault cannot look up a barcode. Built and released through `main`:
  - After a TIDAL similar-tracks read, the suggestions not in the library and not yet looked up go to one Sonovault task job (`sonovault-similar-lookup`) for that library track: one bulk request of at most 20 ISRCs, through the Sonovault request gate and credit reserve (SONO-02), its response stored with the job (SONO-03).
  - A matched record gives the suggestion its Spotify track only when the record has a Spotify link and agrees with TIDAL's title (with its version) and duration as in SONO-08. Sonovault keeps one Spotify ID per recording, so the match can be the same recording on another release than TIDAL's; no Spotify album or artwork is claimed for it.
  - The match is stored in `spotify_code_lookup`, which the Similar tab already reads, with `source` `sonovault`, the stored response (`response_id`) and its fetch time, so the tab's states are unchanged. A row from a Spotify search has `source` `spotify`.
  - A miss from Sonovault (not found, no Spotify link, a record that fails the check, or skipped for credits) is not "Not on Spotify": the job queues the existing Spotify search (`spotify-similar-lookup`) for those ISRCs only. When Sonovault cannot take the job (not configured, a cooldown, or the credit reserve), every suggestion goes to the Spotify search. Each job's message says how many it mapped, and the Similar tab follows the latest of the two jobs.
  - SONO-10 covers these rows: the removal deletes every `sonovault` row of `spotify_code_lookup`, and the refresh deletes those older than 11 months, so the suggestion is looked up again the next time its similar tracks are read; such a row is also due for lookup on that read.
  - Nothing plays as a result of a lookup, and the interface is unchanged.
- SONO-27: A library track's `tidal-track` and `musicbrainz-recording` references let the TIDAL similar-tracks job and a ListenBrainz similar-recordings source run for tracks that have no confirmed match on those services. The suggestion list says which reference it used.
- SONO-28: Artist facts (country, year formed, Wikidata and MusicBrainz artist IDs, social links) are stored on library artists and used as an independent check of a saved artist match.
- SONO-29: New releases by library artists and on library labels, from the dated artist and label feeds, as a list the owner can open. This is the closest the service comes to discovery.
- SONO-30: Other recordings of the same composition (by ISWC) listed on a track: covers and other versions.

## Not in scope

Audio recognition (the library holds no audio files), radio stream monitoring and its webhooks, submitting genre corrections to Sonovault, and the all-releases feed. Sonovault is not a playback source and is not used to replace an identifier that another provider confirmed.

## Decisions

The owner asked for the build on 2026-11-22 without changing the proposals, so they stand:

- SONO-07: a Sonovault ISRC may become a track's primary ISRC when it has none, marked and replaceable.
- SONO-17: tempo and key of unverified records are hidden in Browse and marked in track details.
- SONO-08: an unverified record's ISRC is not written as an `isrc` reference, because other features read those references, and it does not fill the primary ISRC. It is kept on the `sonovault-track` reference and listed in track details.
- SONO-02: the credits a response reports apply to the UTC calendar month of that response. A report from an earlier month counts as the full monthly credits setting.
