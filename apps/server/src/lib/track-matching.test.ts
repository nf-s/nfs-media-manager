import { describe, expect, it } from 'vitest'
import {
  createScrobbleTrackMatcher,
  createTrackAlbumMatcher,
  trackBaseKey,
  trackVersionKey,
  type MatchTrackAlbum,
} from './track-matching'

describe('track title keys', () => {
  it('ignores featured credits, remaster notes and the default mix', () => {
    const key = trackVersionKey('Night Drive')
    expect(trackVersionKey('Night Drive (feat. Example Singer)')).toBe(key)
    expect(trackVersionKey('Night Drive - 2011 Remaster')).toBe(key)
    expect(trackVersionKey('Night Drive (Original Mix)')).toBe(key)
    expect(trackVersionKey('Night Drive feat. Example Singer')).toBe(key)
  })

  it('keeps mixes, edits and live versions apart, in any punctuation', () => {
    expect(trackVersionKey('Night Drive - Example Remix')).toBe(
      trackVersionKey('Night Drive (Example Remix)'),
    )
    expect(trackVersionKey('Night Drive - Example Remix')).not.toBe(
      trackVersionKey('Night Drive'),
    )
    expect(trackVersionKey('Night Drive (Live)')).not.toBe(
      trackVersionKey('Night Drive'),
    )
    expect(trackVersionKey('Night Drive - Radio Edit')).not.toBe(
      trackVersionKey('Night Drive - Extended Mix'),
    )
  })

  it('drops every qualifier from the base title', () => {
    expect(trackBaseKey('Night Drive - Example Remix')).toBe('night drive')
    expect(trackBaseKey('(Interlude)')).toBe('interlude')
  })
})

describe('scrobble to track matching', () => {
  const match = createScrobbleTrackMatcher([
    {
      id: 'original',
      title: 'Night Drive',
      artists: ['The Examples'],
      albumId: 'album',
    },
    {
      id: 'remix',
      title: 'Night Drive - Other Artist Remix',
      artists: ['The Examples', 'Other Artist'],
      albumId: null,
    },
    {
      id: 'single',
      title: 'Night Drive',
      artists: ['The Examples'],
      albumId: null,
    },
    {
      id: 'closer',
      title: 'Closing Time (Reprise)',
      artists: ['The Examples'],
      albumId: 'album',
    },
  ])
  const scrobble = (
    artistName: string,
    trackName: string,
    albumIds: string[] = [],
  ) => match({ artistName, trackName, albumIds })

  it('counts an exact name towards every listing of the recording', () => {
    expect(scrobble('the examples', 'night drive')).toEqual({
      trackIds: ['original', 'single'],
      strategy: 'exact',
    })
  })

  it('ignores punctuation and a leading article', () => {
    expect(scrobble('Examples', 'Night, Drive!')).toEqual({
      trackIds: ['original', 'single'],
      strategy: 'normalized',
    })
  })

  it('matches a remix only to the remix', () => {
    expect(
      scrobble('The Examples', 'Night Drive (Other Artist Remix)'),
    ).toEqual({ trackIds: ['remix'], strategy: 'normalized' })
  })

  it('ignores a remaster note and a collaborator credit', () => {
    expect(
      scrobble('The Examples & Guest', 'Night Drive - 2011 Remaster'),
    ).toEqual({ trackIds: ['original', 'single'], strategy: 'version' })
  })

  it('uses the linked album when only the base title agrees', () => {
    expect(scrobble('Someone Else', 'Closing Time', ['album'])).toEqual({
      trackIds: ['closer'],
      strategy: 'album',
    })
    expect(scrobble('Someone Else', 'Closing Time')).toBeNull()
  })

  it('does not match another artist or an unknown title', () => {
    expect(scrobble('Different Band', 'Night Drive')).toBeNull()
    expect(scrobble('The Examples', 'Morning Walk')).toBeNull()
  })
})

describe('track to album matching', () => {
  const album = (
    input: Partial<MatchTrackAlbum> & { id: string },
  ): MatchTrackAlbum => ({
    title: 'Example Album',
    releaseDate: '2020-01-01',
    artists: ['The Examples'],
    spotifyAlbumIds: [],
    tracks: [{ title: 'Night Drive', externalId: null }],
    ...input,
  })
  const track = {
    spotifyTrackId: 'spotify-track',
    spotifyAlbumId: 'spotify-album',
    title: 'Night Drive',
    albumName: 'Example Album',
    artists: ['The Examples'],
  }

  it('prefers the Spotify album ID, then the Spotify track ID', () => {
    const match = createTrackAlbumMatcher([
      album({ id: 'by-title' }),
      album({
        id: 'by-track',
        title: 'Other',
        tracks: [{ title: 'Renamed', externalId: 'spotify-track' }],
      }),
      album({
        id: 'by-album',
        title: 'Other',
        spotifyAlbumIds: ['spotify-album'],
      }),
    ])
    expect(match(track)).toEqual({
      albumId: 'by-album',
      strategy: 'spotify-album',
    })
    expect(match({ ...track, spotifyAlbumId: null })).toEqual({
      albumId: 'by-track',
      strategy: 'spotify-track',
    })
  })

  it('links another edition of the same album by title', () => {
    const match = createTrackAlbumMatcher([
      album({ id: 'deluxe', title: 'Example Album (Deluxe Edition)' }),
      album({ id: 'standard' }),
    ])
    expect(match(track)).toEqual({
      albumId: 'standard',
      strategy: 'album-title',
    })
    expect(
      match({ ...track, albumName: 'Example Album - Remastered' }),
    ).toMatchObject({ strategy: 'album-title' })
  })

  it('links a single to the earliest album that lists the track', () => {
    const match = createTrackAlbumMatcher([
      album({
        id: 'compilation',
        title: 'Collected',
        releaseDate: '2024-01-01',
      }),
      album({ id: 'studio', releaseDate: '2020-01-01' }),
    ])
    expect(match({ ...track, albumName: 'Night Drive' })).toEqual({
      albumId: 'studio',
      strategy: 'artist-title',
    })
  })

  it('does not link another artist or a different version', () => {
    const match = createTrackAlbumMatcher([album({ id: 'studio' })])
    expect(match({ ...track, artists: ['Different Band'] })).toBeNull()
    expect(
      match({ ...track, albumName: 'Live Set', title: 'Night Drive - Live' }),
    ).toBeNull()
  })
})
