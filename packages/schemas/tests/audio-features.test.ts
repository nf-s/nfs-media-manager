import { describe, expect, it } from 'vitest'
import { removeSpotifyAudioFeatures } from '../src/audio-features'
import { albumBrowseFields, BrowseKeySchema } from '../src/browse'
import { normalizeSavedView } from '../src/imports'

describe('discontinued Spotify audio features', () => {
  it('removes stored aggregates and nested feature payloads without mutating input', () => {
    const input = {
      title: 'Album',
      mode: 0,
      key: 7,
      energy: 0,
      metadata: {
        browse: { acousticness: 0.5, popularitySpotify: 0, ratingRymValue: 4 },
      },
      spotify: { id: 'album', audioFeatures: [{ id: 'track', tempo: 120 }] },
      tracks: [
        {
          id: 'track',
          duration_ms: 1000,
          audio_features: { tempo: 120 },
          artists: ['Artist'],
        },
      ],
      options: { mode: 1, key: 'cache-key' },
      filters: [{ field: 'genre', value: 'ambient', mode: 'any' }],
    }
    const before = JSON.stringify(input)
    const result = removeSpotifyAudioFeatures(input)
    expect(result.value).toEqual({
      title: 'Album',
      metadata: { browse: { popularitySpotify: 0, ratingRymValue: 4 } },
      spotify: { id: 'album' },
      tracks: [{ id: 'track', duration_ms: 1000, artists: ['Artist'] }],
      options: { mode: 1, key: 'cache-key' },
      filters: [{ field: 'genre', value: 'ambient', mode: 'any' }],
    })
    expect(JSON.stringify(input)).toBe(before)
    expect(result.removed).toEqual({
      mode: 1,
      key: 1,
      energy: 1,
      acousticness: 1,
      audioFeatures: 1,
      audio_features: 1,
    })
    expect(removeSpotifyAudioFeatures(result.value)).toEqual({
      value: result.value,
      removed: {},
      changed: false,
    })
  })

  it('removes standalone track feature keys including analysis and time signature', () => {
    expect(
      removeSpotifyAudioFeatures({
        tracks: {
          items: [
            {
              mode: 1,
              key: 2,
              time_signature: 4,
              analysis_url: 'analysis',
              uri: 'track-uri',
              duration_ms: 23,
            },
          ],
        },
      }).value,
    ).toEqual({ tracks: { items: [{ uri: 'track-uri', duration_ms: 23 }] } })
  })

  it('retires filters and sorts while preserving other definition values', () => {
    expect(
      normalizeSavedView({
        name: 'Saved',
        destination: 'unchanged',
        sort: ['energy', 'ASC'],
        limit: 20,
        filters: [
          { field: 'energy', min: 0.5 },
          { field: 'genres', value: 'ambient', intersection: true },
        ],
      }),
    ).toEqual({
      name: 'Saved',
      sortBy: 'dateAdded',
      direction: 'desc',
      limit: 20,
      filters: [{ field: 'genre', value: 'ambient', mode: 'required' }],
      ranges: [],
    })
    const result = removeSpotifyAudioFeatures({
      name: 'Saved',
      destination: 'unchanged',
      filters: [{ field: 'mode', min: 0 }],
    })
    expect(result.value).toEqual({
      name: 'Saved',
      destination: 'unchanged',
      filters: [],
    })
  })

  it('rejects retired browse keys but preserves real music metrics', () => {
    for (const key of ['energy', 'mode', 'tempo', 'audio_features']) {
      expect(BrowseKeySchema.safeParse(key).success).toBe(false)
      expect(albumBrowseFields.some((field) => field.key === key)).toBe(false)
    }
    expect(BrowseKeySchema.parse('popularitySpotify')).toBe('popularitySpotify')
  })

  it('validates unknown input before traversal', () => {
    expect(() => removeSpotifyAudioFeatures({ energy: undefined })).toThrow()
  })
})
