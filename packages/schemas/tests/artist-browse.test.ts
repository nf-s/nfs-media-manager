import { describe, expect, it } from 'vitest'
import {
  ArtistQuerySchema,
  ArtistMetadataQuerySchema,
  ArtistSummarySchema,
} from '../src/creators'
import { artistBrowseFields, getArtistBrowseValues } from '../src/artist-browse'

describe('artist browse query', () => {
  it('accepts shared serialized filters, ranges and limits in browse and metadata', () => {
    const input = {
      filters: JSON.stringify([
        { field: 'playlist', value: 'Fixture playlist', mode: 'required' },
      ]),
      ranges: JSON.stringify([{ field: 'trackCount', min: 2 }]),
      limitResults: '10',
    }
    for (const schema of [ArtistQuerySchema, ArtistMetadataQuerySchema]) {
      const query = schema.parse(input)
      expect(query.filters).toEqual([
        { field: 'playlist', value: 'Fixture playlist', mode: 'required' },
      ])
      expect(query.ranges).toEqual([
        { field: 'trackCount', min: 2, includeMissing: false },
      ])
      expect(query.limitResults).toBe(10)
    }
  })

  it('rejects unknown filters, invalid ranges and malformed URL state', () => {
    for (const query of [
      { filters: [{ field: 'watched', value: 'yes' }] },
      { ranges: [{ field: 'genre', min: 1 }] },
      { ranges: [{ field: 'trackCount', min: 4, max: 2 }] },
      { filters: 'invalid' },
      { ranges: 'invalid' },
      { limitResults: 0 },
      { limitResults: 10001 },
    ])
      expect(ArtistQuerySchema.safeParse(query).success).toBe(false)
    for (const field of artistBrowseFields)
      expect(ArtistQuerySchema.safeParse({ sortBy: field.key }).success).toBe(
        true,
      )
  })

  it('keeps missing profile values missing and emits epoch dates for ranges', () => {
    const artist = ArtistSummarySchema.parse({
      id: 'fixture',
      name: 'Fixture artist',
      sortName: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      artworkUrl: null,
      albumCount: 0,
      trackCount: 1,
      playlistCount: 0,
    })
    expect(getArtistBrowseValues(artist)).toEqual({
      name: 'Fixture artist',
      createdAt: Date.parse(artist.createdAt),
      albumCount: 0,
      trackCount: 1,
      playlistCount: 0,
    })
  })
})
