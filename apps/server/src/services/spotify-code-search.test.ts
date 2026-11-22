import { describe, expect, it } from 'vitest'
import {
  chooseSpotifyTrack,
  codeKey,
  upcKey,
  upcVariants,
  type SpotifyCodeTrackCandidate,
} from './spotify-code-search'

const candidate = (
  n: number,
  overrides: Partial<SpotifyCodeTrackCandidate> = {},
): SpotifyCodeTrackCandidate => ({
  spotifyId: `fixturespotify${String(n).padStart(8, '0')}`,
  url: `https://open.spotify.com/track/fixturespotify${String(n).padStart(8, '0')}`,
  title: `Fixture ${n}`,
  artists: ['Halcyon Grid'],
  albumName: null,
  spotifyAlbumId: null,
  artworkUrl: null,
  durationSec: 300,
  trackCount: null,
  isrc: 'QZFX22800001',
  albumType: 'album',
  releaseDate: '2022-01-01',
  ...overrides,
})

describe('Spotify code search helpers', () => {
  it('keys UPCs without leading zeros and lists the padded forms', () => {
    expect(upcKey('0000000000017')).toBe('17')
    expect(upcKey('000000000017')).toBe('17')
    expect(upcKey('12-34')).toBeNull()
    expect(upcVariants('123456789012')).toEqual([
      '123456789012',
      '0123456789012',
      '00123456789012',
    ])
    expect(codeKey('track', 'qz-fx2-28-00001')).toBe('QZFX22800001')
    expect(codeKey('track', 'not an isrc')).toBeNull()
  })

  it('prefers a library track, then the earliest release that is not a compilation', () => {
    const tracks = [
      candidate(1, { albumType: 'compilation', releaseDate: '2018-01-01' }),
      candidate(2, { releaseDate: '2022-01-01' }),
      candidate(3, { albumType: 'single', releaseDate: '2021-01-01' }),
      candidate(4, { isrc: 'QZFX22800009', releaseDate: '2010-01-01' }),
    ]
    expect(
      chooseSpotifyTrack('QZFX22800001', tracks, new Set())?.spotifyId,
    ).toBe(candidate(3).spotifyId)
    expect(
      chooseSpotifyTrack(
        'QZFX22800001',
        tracks,
        new Set([candidate(2).spotifyId]),
      )?.spotifyId,
    ).toBe(candidate(2).spotifyId)
    expect(
      chooseSpotifyTrack('QZFX22800001', tracks.slice(0, 1), new Set())
        ?.spotifyId,
    ).toBe(candidate(1).spotifyId)
    expect(chooseSpotifyTrack('QZFX22800001', [], new Set())).toBeNull()
  })
})
