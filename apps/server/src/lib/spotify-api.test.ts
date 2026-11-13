import { describe, expect, it } from 'vitest'
import {
  normalizeSpotifyTrackEntry,
  spotifyTrackAdditions,
} from './spotify-api'

const TRACK_ID = 'T'.repeat(22)
const ALBUM_ID = 'A'.repeat(22)

function track(overrides: Record<string, unknown> = {}) {
  return {
    type: 'track',
    id: TRACK_ID,
    name: 'Night Drive',
    duration_ms: 215_499,
    artists: [
      { name: 'The Examples' },
      { name: 'Example Singer' },
      { name: 'The Examples' },
    ],
    album: {
      id: ALBUM_ID,
      name: 'Example Album',
      release_date: '2019-03-01',
      images: [{ url: 'https://images.example.test/cover.jpg' }],
    },
    external_ids: { isrc: ' usabc1900001 ' },
    ...overrides,
  }
}

describe('normalizeSpotifyTrackEntry', () => {
  it('reads a playlist entry', () => {
    expect(
      normalizeSpotifyTrackEntry({
        added_at: '2024-05-06T07:08:09Z',
        item: track(),
      }),
    ).toEqual({
      track: {
        spotifyTrackId: TRACK_ID,
        title: 'Night Drive',
        artists: ['The Examples', 'Example Singer'],
        durationSec: 215,
        albumName: 'Example Album',
        spotifyAlbumId: ALBUM_ID,
        artworkUrl: 'https://images.example.test/cover.jpg',
        releaseDate: '2019-03-01',
        isrc: 'USABC1900001',
        addedAt: '2024-05-06T07:08:09Z',
      },
    })
  })

  it('reads a saved track from the older `track` field', () => {
    const result = normalizeSpotifyTrackEntry({ track: track() })
    expect(result.track?.spotifyTrackId).toBe(TRACK_ID)
  })

  it('keeps a track whose album details are missing or unusable', () => {
    const result = normalizeSpotifyTrackEntry({
      // Spotify reports the Unix epoch for entries older than the field.
      added_at: '1970-01-01T00:00:00Z',
      item: track({
        album: { id: 'not-an-id', name: '', release_date: '0000', images: [] },
        external_ids: undefined,
      }),
    })
    expect(result.track).toMatchObject({
      albumName: null,
      spotifyAlbumId: null,
      artworkUrl: null,
      releaseDate: null,
      isrc: null,
      addedAt: null,
    })
  })

  it.each([
    { name: 'a local file', entry: { is_local: true, item: track() } },
    { name: 'an episode', entry: { item: track({ type: 'episode' }) } },
    { name: 'a removed track', entry: { item: null } },
    { name: 'a track without an ID', entry: { item: track({ id: null }) } },
    { name: 'a track without a title', entry: { item: track({ name: '' }) } },
  ])('skips $name', ({ entry }) => {
    expect(normalizeSpotifyTrackEntry(entry)).toEqual({
      track: null,
      reason: 'skipped',
    })
  })

  it.each([
    { name: 'an unrecognised ID', overrides: { id: 'short' } },
    { name: 'no artists', overrides: { artists: [] } },
    { name: 'no duration', overrides: { duration_ms: undefined } },
  ])('reports a track with $name as invalid', ({ overrides }) => {
    expect(normalizeSpotifyTrackEntry({ item: track(overrides) })).toEqual({
      track: null,
      reason: 'invalid',
    })
  })
})

describe('spotifyTrackAdditions', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((letter) =>
    letter.repeat(22),
  )
  const uri = (id: string | undefined) => `spotify:track:${id}`

  it('keeps album order, drops tracks already present and repeats, and splits requests', () => {
    const album = [a, b, a, c, d, e].flatMap((id) => (id ? [id] : []))
    expect(spotifyTrackAdditions(album, new Set(b ? [b] : []), 2)).toEqual([
      [uri(a), uri(c)],
      [uri(d), uri(e)],
    ])
  })

  it('sends nothing when every track is present', () => {
    const album = [a, b].flatMap((id) => (id ? [id] : []))
    expect(spotifyTrackAdditions(album, new Set(album))).toEqual([])
  })

  it('uses requests of 100 by default', () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      `t${String(index).padStart(3, '0')}`.padEnd(22, 'x'),
    )
    expect(
      spotifyTrackAdditions(many, new Set()).map((batch) => batch.length),
    ).toEqual([100, 100, 50])
  })
})
