import { describe, expect, it } from 'vitest'
import { isMediaProviderPlugin } from '@repo/media-plugin-sdk'
import {
  LegacyBrowseRecordSchema,
  normalizeLegacyBrowse,
  mergeLegacyFilmRows,
} from './legacy-browse'

describe('legacy browse normalization', () => {
  it('merges duplicate films without erasing watched state or the original rows', () => {
    const rows = mergeLegacyFilmRows([
      { id: 'tt1', title: 'Film', watched: 'Yes', ratingImdbPersonal: 8 },
      { id: 'tt1', title: 'Film', watched: 'No' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ watched: 'Yes', ratingImdbPersonal: 8 })
    expect(rows[0]?.legacyDuplicateRows).toHaveLength(2)
  })
  it('preserves derived zero values, dates, credits and readable memberships', () => {
    const result = normalizeLegacyBrowse(
      LegacyBrowseRecordSchema.parse({
        title: 'Fixture album',
        artists: ['First', 'Second'],
        genres: ['ambient'],
        countries: ['Australia'],
        dateAdded: 1609459200000,
        dateReleased: 0,
        durationSec: 60.4,
        scrobbles: 0,
        energy: 0,
        ratingRymValue: 3.5,
        playlists: ['saved'],
        links: { spotify: { href: 'https://open.spotify.com/album/fixture' } },
      }),
      'album',
      { saved: 'Saved albums' },
    )
    expect(result.normalized.mediaPatch?.metadata?.browse).toMatchObject({
      scrobbles: 0,
      country: ['Australia'],
    })
    expect(result.normalized.mediaPatch?.metadata?.browse).not.toHaveProperty(
      'energy',
    )
    expect(result.payload).not.toHaveProperty('energy')
    expect(result.normalized.mediaPatch?.releaseDate).toBe(
      '1970-01-01T00:00:00.000Z',
    )
    expect(result.normalized.albumPatch).toMatchObject({
      durationSec: 60,
      dateAdded: '2021-01-01T00:00:00.000Z',
    })
    expect(result.normalized.credits.map((credit) => credit.name)).toEqual([
      'First',
      'Second',
    ])
    expect(result.normalized.playlists[0]?.name).toBe('Saved albums')
    expect(result.normalized.links[0]?.label).toBe('Spotify')
  })
  it('retains film sources, all credit roles, ratings and collection names', () => {
    const result = normalizeLegacyBrowse(
      LegacyBrowseRecordSchema.parse({
        title: 'Film',
        source: 'bluray',
        watched: 'Yes',
        directors: ['Director'],
        writers: ['Writer'],
        actors: ['Actor'],
        tags: ['drama'],
        collections: ['Collection'],
        ratingImdbValue: 0,
        ratingMine: 8,
        runTime: 99,
      }),
      'film',
    )
    expect(result.normalized.mediaPatch?.sourceLabel).toBe('Blu-ray')
    expect(result.normalized.filmPatch).toMatchObject({
      watched: true,
      sourceKind: 'bluray',
      runtimeMinutes: 99,
    })
    expect(result.normalized.credits.map((credit) => credit.role)).toEqual([
      'director',
      'actor',
      'writer',
    ])
    expect(result.normalized.playlists[0]?.kind).toBe('collection')
    expect(result.normalized.mediaPatch?.metadata?.browse).toMatchObject({
      ratingImdbValue: 0,
    })
  })
})

describe('plugin boundaries', () => {
  const manifest = {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: { minTimeMs: 2000, maxConcurrent: 1 },
  }
  it('validates rate limits, media kinds, callable hooks and metric namespaces', () => {
    expect(isMediaProviderPlugin({ manifest })).toBe(true)
    expect(isMediaProviderPlugin({ manifest, scrapeMediaItem: true })).toBe(
      false,
    )
    expect(
      isMediaProviderPlugin({
        manifest: {
          ...manifest,
          rateLimit: { minTimeMs: -1, maxConcurrent: 1 },
        },
      }),
    ).toBe(false)
    expect(
      isMediaProviderPlugin({
        manifest: { ...manifest, mediaTypes: ['video'] },
      }),
    ).toBe(false)
    expect(
      isMediaProviderPlugin({
        manifest: {
          ...manifest,
          browseFields: [
            { key: 'title', label: 'Title', type: 'text', filterable: true },
          ],
        },
      }),
    ).toBe(false)
  })
})
