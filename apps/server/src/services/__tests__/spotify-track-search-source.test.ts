import { describe, expect, it, vi } from 'vitest'
import type { SpotifyTrackSearchCandidate } from '@repo/schemas/spotify-track-search'
import {
  spotifySearchHasAlternateVersion,
  spotifySearchMatchesObservedAlbum,
  spotifySearchMatchesSource,
  spotifySearchMatchesTitleVersion,
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
    expect(
      spotifySearchMatchesSource(
        recording(patch),
        result({ artists: ['Café Signal', 'Glass Bell'] }),
      ),
    ).toBe(false)
  })
})
