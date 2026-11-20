import { describe, expect, it, vi } from 'vitest'
import type { SpotifyTrackSearchCandidate } from '@repo/schemas/spotify-track-search'
import {
  spotifySearchDestinationReasons,
  spotifySearchHasAlternateVersion,
  spotifySearchMatchesDestination,
  spotifySearchMatchesObservedAlbum,
  spotifySearchMatchesSource,
  spotifySearchMatchesTitleVersion,
  spotifySearchSourceReasons,
} from '../spotify-track-search-evidence'

vi.mock('../album-library-tracks', () => ({}))

const trackId = '1111111111111111111111'
const albumId = '2222222222222222222222'
const artistId = '3333333333333333333333'
const otherId = '4444444444444444444444'

type Recording = Parameters<typeof spotifySearchMatchesSource>[0]

function recording(patch: Partial<Recording> = {}): Recording {
  return {
    title: 'Harbour Lights',
    spotify_track_id: null,
    has_manual_overrides: false,
    artists: ['Café Signal'],
    artist_credits: [],
    track_ids: [],
    spotify_url: null,
    isrc: null,
    durations: [],
    position_titles: [],
    album_ids: [],
    album_names: [],
    scrobbled_albums: [],
    standalone_lastfm: true,
    scrobbles: [],
    ...patch,
  }
}

function result(
  patch: Partial<SpotifyTrackSearchCandidate> = {},
): SpotifyTrackSearchCandidate {
  return {
    spotifyTrackId: trackId,
    title: 'Harbour Lights',
    artists: ['Café Signal'],
    artistCredits: [{ id: artistId, name: 'Café Signal' }],
    albumName: 'Tidal Atlas',
    spotifyAlbumId: albumId,
    durationSec: 174,
    isrc: 'AA-FI1-20-00001',
    artworkUrl: null,
    spotifyUrl: `https://open.spotify.com/track/${trackId}`,
    ...patch,
  }
}

describe('Spotify track search source evidence', () => {
  it('accepts matching punctuation and diacritics across the track, credit and recorded name', () => {
    const source = recording({
      title: 'Hárbour Lights!',
      artists: ['Cafe Signal'],
      scrobbles: [
        { title: 'hárbour lights!', artist: 'cafe signal', manual: false },
      ],
    })
    expect(spotifySearchMatchesSource(source, result())).toBe(true)
  })

  it('accepts one second of duration rounding', () => {
    expect(
      spotifySearchMatchesSource(recording({ durations: [173] }), result()),
    ).toBe(true)
  })

  it('accepts a featured artist either in the title or as a credit with the same lead', () => {
    const source = recording({
      title: 'Harbour Lights (feat. Glass Bell)',
      scrobbles: [
        {
          title: 'harbour lights',
          artist: 'café signal featuring glass bell',
          manual: false,
        },
      ],
    })
    expect(
      spotifySearchMatchesSource(
        source,
        result({ artists: ['Café Signal', 'Glass Bell'] }),
      ),
    ).toBe(true)
  })

  it('accepts supplementary Spotify billing for a track with only the matching lead in Last.fm', () => {
    expect(
      spotifySearchMatchesSource(
        recording(),
        result({ artists: ['Café Signal', 'Glass Bell'] }),
      ),
    ).toBe(true)
  })

  it('preserves exact scrobbled billing for artists with commas in their name', () => {
    const source = recording({
      artists: ['Signal, North', 'Glass Bell'],
      scrobbles: [
        {
          title: 'harbour lights',
          artist: 'signal, north, glass bell',
          manual: false,
        },
      ],
    })
    expect(
      spotifySearchMatchesSource(
        source,
        result({ artists: ['Signal, North', 'Glass Bell'] }),
      ),
    ).toBe(true)
  })

  it.each([' & ', ' and ', ' x ', ' / ', ' + '])(
    'recognizes complete, ordered Spotify billing joined by %j',
    (separator) => {
      const artist = ['Café Signal', 'Glass Bell', 'Clear Field'].join(
        separator,
      )
      expect(
        spotifySearchMatchesSource(
          recording({
            artists: [artist],
            scrobbles: [{ title: 'harbour lights', artist, manual: false }],
          }),
          result({ artists: ['Cafe Signal', 'Glass Bell', 'Clear Field'] }),
        ),
      ).toBe(true)
      expect(
        spotifySearchMatchesSource(
          recording({ artists: [artist] }),
          result({ artists: ['Cafe Signal', 'Clear Field', 'Glass Bell'] }),
        ),
      ).toBe(false)
    },
  )

  it.each([
    'Harbour Lights (Original Mix)',
    'Harbour Lights - Original Version',
    'Harbour Lights (Remastered)',
    'Harbour Lights - 2020 Remaster',
  ])('accepts a standalone name with the compatible suffix in %j', (title) => {
    expect(spotifySearchMatchesSource(recording({ title }), result())).toBe(
      true,
    )
    expect(spotifySearchMatchesSource(recording(), result({ title }))).toBe(
      true,
    )
  })

  it('keeps separately specified versions and authoritative position names distinct', () => {
    expect(
      spotifySearchMatchesSource(
        recording({ title: 'Harbour Lights (2019 Remaster)' }),
        result({ title: 'Harbour Lights (2020 Remaster)' }),
      ),
    ).toBe(false)
    expect(
      spotifySearchMatchesSource(
        recording({
          position_titles: ['Harbour Lights (2020 Remaster)'],
          standalone_lastfm: false,
        }),
        result(),
      ),
    ).toBe(false)
    expect(
      spotifySearchMatchesSource(
        recording({
          title: 'Harbour Lights (2019 Remaster)',
          scrobbles: [
            {
              title: 'Harbour Lights (2020 Remaster)',
              artist: 'Café Signal',
              manual: false,
            },
          ],
        }),
        result(),
      ),
    ).toBe(false)
  })

  it('distinguishes an exact title version from a compatible title suffix', () => {
    const source = recording({
      title: 'Hárbour Lights (feat. Glass Bell)',
    })
    expect(spotifySearchMatchesTitleVersion(source, result())).toBe(true)
    expect(
      spotifySearchMatchesTitleVersion(
        source,
        result({ title: 'Harbour Lights (2020 Remaster)' }),
      ),
    ).toBe(false)
  })

  it('recognizes the same named recording across original mix tags on observed releases', () => {
    const source = recording({
      scrobbled_albums: ['Tidal Atlas', 'Harbour Anthology'],
    })
    const chosen = result()
    expect(
      spotifySearchHasAlternateVersion(source, chosen, [
        chosen,
        result({
          spotifyTrackId: otherId,
          title: 'Harbour Lights - Original Mix',
          albumName: 'Harbour Anthology',
        }),
      ]),
    ).toBe(false)
  })

  it('allows a different ordinary album name on an unlinked scrobble', () => {
    expect(
      spotifySearchMatchesSource(
        recording({
          album_names: ['Uncatalogued Single'],
          scrobbled_albums: ['Uncatalogued Single'],
        }),
        result(),
      ),
    ).toBe(true)
  })

  it('keeps an alternate version from another observed album reviewable', () => {
    const source = recording({
      scrobbled_albums: ['Tidal Atlas', 'Harbour Anthology'],
    })
    const chosen = result()
    expect(
      spotifySearchHasAlternateVersion(source, chosen, [
        chosen,
        result({
          spotifyTrackId: otherId,
          title: 'Harbour Lights: Acoustic',
          albumName: 'Hárbour Anthology!',
          artists: ['Cafe Signal', 'Glass Bell'],
        }),
      ]),
    ).toBe(true)
  })

  it('identifies normalized observed standalone album names without dropping edition words', () => {
    const source = recording({ scrobbled_albums: ['Tídal Atlas!'] })
    expect(spotifySearchMatchesObservedAlbum(source, result())).toBe(true)
    expect(
      spotifySearchMatchesObservedAlbum(
        source,
        result({ albumName: 'Tidal Atlas (Deluxe)' }),
      ),
    ).toBe(false)
    expect(spotifySearchMatchesObservedAlbum(recording(), result())).toBe(false)
  })

  it('keeps an unmatched version album reviewable with no album name on the result', () => {
    const source = recording({ scrobbled_albums: ['Harbour Live'] })
    const chosen = result({ albumName: null })
    expect(spotifySearchHasAlternateVersion(source, chosen, [chosen])).toBe(
      true,
    )
  })

  it.each<Partial<Recording>>([
    { title: 'Harbour Lights (Named Remix)' },
    { title: 'Harbour Lights (Clean)' },
    { title: 'Harbour Lights (feat. Glass Bell - Live)' },
    { artists: ['Different Lead', 'Café Signal'] },
    { artists: ['Café Signal featuring Different Guest'] },
    { title: 'Harbour Lights (feat. Different Guest)' },
    { position_titles: ['Harbour Lights (Radio Edit)'] },
    { track_ids: [otherId] },
    { spotify_url: `https://open.spotify.com/track/${otherId}` },
    { album_ids: [otherId] },
    { album_names: ['Tidal Atlas (Deluxe)'], standalone_lastfm: false },
    { artist_credits: [{ id: otherId, name: 'Café Signal' }] },
    { isrc: 'AA-FI1-20-00002' },
    { durations: [174, 172] },
    { has_manual_overrides: true },
    {
      scrobbles: [
        {
          title: 'harbour lights (acoustic)',
          artist: 'café signal',
          manual: false,
        },
      ],
    },
    {
      scrobbles: [
        { title: 'harbour lights', artist: 'café signal', manual: true },
      ],
    },
  ])('keeps contradictory or manual evidence reviewable (%j)', (patch) => {
    const source = recording(patch)
    const candidate = result({ artists: ['Café Signal', 'Glass Bell'] })
    expect(spotifySearchMatchesSource(source, candidate)).toBe(false)
    expect(
      spotifySearchSourceReasons(source, candidate, [candidate]),
    ).not.toEqual([])
  })
})

describe('Spotify track search audit reasons', () => {
  it('has no source reason for supported punctuation, title versions or featured billing', () => {
    const source = recording({
      title: 'Hárbour Lights! (feat. Glass Bell)',
      artists: ['Cafe Signal'],
      durations: [175],
      scrobbled_albums: ['Uncatalogued Single'],
    })
    const candidate = result({
      title: 'Harbour Lights - Original Mix',
      artists: ['Café Signal', 'Glass Bell'],
    })
    expect(spotifySearchMatchesSource(source, candidate)).toBe(true)
    expect(
      spotifySearchHasAlternateVersion(source, candidate, [candidate]),
    ).toBe(false)
    expect(spotifySearchSourceReasons(source, candidate, [candidate])).toEqual(
      [],
    )
  })

  it('reports concrete conflicts and missing metadata together', () => {
    const source = recording({
      title: 'Harbour Lights (Radio Edit)',
      position_titles: ['Harbour Lights (Radio Edit)'],
      spotify_url: 'https://example.invalid/fixture-account?fixture=private',
      album_ids: [albumId],
      isrc: 'AA-FI1-20-00001',
      durations: [172],
    })
    const candidate = result({
      spotifyAlbumId: null,
      isrc: null,
      durationSec: 0,
    })
    expect(
      spotifySearchSourceReasons(source, candidate, [candidate]),
    ).toMatchObject([
      {
        code: 'source-spotify-album-id',
        library: albumId,
        spotify: 'Unavailable',
      },
      {
        code: 'source-title',
        library: 'Harbour Lights (Radio Edit)',
        spotify: 'Harbour Lights',
      },
      {
        code: 'source-position-title',
        library: 'Harbour Lights (Radio Edit)',
        spotify: 'Harbour Lights',
      },
      {
        code: 'source-spotify-track-link',
        library: 'Unrecognised Spotify link',
        spotify: trackId,
      },
      {
        code: 'source-isrc',
        library: 'AA-FI1-20-00001',
        spotify: 'Unavailable',
      },
      {
        code: 'source-duration',
        library: '172 seconds',
        spotify: 'Unavailable',
      },
    ])
  })

  it('describes both alternate version vetoes that can block a compatible source', () => {
    const candidate = result()
    const other = result({
      spotifyTrackId: otherId,
      title: 'Harbour Lights (Acoustic)',
      albumName: 'Harbour Anthology',
    })
    const explicitRelease = recording({ scrobbled_albums: ['Harbour Live'] })
    const competingResult = recording({
      scrobbled_albums: ['Tidal Atlas', 'Harbour Anthology'],
    })
    for (const source of [explicitRelease, competingResult]) {
      expect(spotifySearchMatchesSource(source, candidate)).toBe(true)
      expect(
        spotifySearchHasAlternateVersion(source, candidate, [candidate, other]),
      ).toBe(true)
    }
    expect(
      spotifySearchSourceReasons(explicitRelease, candidate, [
        candidate,
        other,
      ]),
    ).toMatchObject([
      {
        code: 'source-alternate-version',
        library: 'Harbour Live',
        spotify: 'Tidal Atlas',
      },
    ])
    expect(
      spotifySearchSourceReasons(competingResult, candidate, [
        candidate,
        other,
      ]),
    ).toMatchObject([
      {
        code: 'source-alternate-version',
        library: 'Harbour Anthology',
        spotify: 'Harbour Lights (Acoustic) · Harbour Anthology',
      },
    ])
  })

  it('shows independently billed guest and artist IDs', () => {
    const source = recording({
      title: 'Harbour Lights (feat. Different Guest)',
      artist_credits: [{ id: otherId, name: 'Café Signal' }],
    })
    const candidate = result({ artists: ['Café Signal', 'Glass Bell'] })
    expect(
      spotifySearchSourceReasons(source, candidate, [candidate]),
    ).toMatchObject([
      {
        code: 'source-artist-credit',
        library: 'Café Signal · Featuring Different Guest',
        spotify: 'Café Signal, Glass Bell',
      },
      {
        code: 'source-spotify-artist-id',
        library: 'Café Signal (' + otherId + ')',
        spotify: 'Café Signal (' + artistId + ')',
      },
    ])
  })

  it.each([
    { spotify_track_id: trackId, has_manual_overrides: false, expected: true },
    { spotify_track_id: trackId, has_manual_overrides: true, expected: false },
    { spotify_track_id: null, has_manual_overrides: false, expected: false },
  ])(
    'reports precisely when destination title and duration tolerances are disabled (%j)',
    ({ expected, ...stored }) => {
      const destination = recording({
        title: 'Hárbour Lights',
        position_titles: ['Hárbour Lights'],
        durations: [175],
        ...stored,
      })
      const candidate = result()
      expect(spotifySearchMatchesDestination(destination, candidate)).toBe(
        expected,
      )
      const reasons = spotifySearchDestinationReasons(destination, candidate)
      expect(reasons.length === 0).toBe(expected)
      if (!expected)
        expect(reasons).toMatchObject([
          {
            code: 'destination-title',
            library: 'Hárbour Lights',
            spotify: 'Harbour Lights',
          },
          {
            code: 'destination-position-title',
            library: 'Hárbour Lights',
            spotify: 'Harbour Lights',
          },
          {
            code: 'destination-duration',
            library: '175 seconds',
            spotify: '174 seconds',
          },
        ])
    },
  )

  it('preserves stricter destination artist and scrobbled-name rules', () => {
    const destination = recording({
      spotify_track_id: trackId,
      artists: ['Cafe Signal'],
      scrobbles: [
        {
          title: 'harbour lights remix',
          artist: 'different artist',
          manual: true,
        },
      ],
    })
    const candidate = result()
    expect(spotifySearchMatchesDestination(destination, candidate)).toBe(false)
    expect(
      spotifySearchDestinationReasons(destination, candidate),
    ).toMatchObject([
      {
        code: 'destination-artist-credit',
        library: 'Cafe Signal',
        spotify: 'Café Signal',
      },
      {
        code: 'destination-manual-scrobble',
        library: 'harbour lights remix · different artist',
      },
      {
        code: 'destination-scrobble-title',
        library: 'harbour lights remix',
        spotify: 'Harbour Lights',
      },
      {
        code: 'destination-scrobble-artist-credit',
        library: 'different artist',
        spotify: 'Café Signal',
      },
    ])
  })
})
