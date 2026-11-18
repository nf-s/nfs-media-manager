import { describe, expect, it } from 'vitest'
import { TrackPositionsQuerySchema, TrackQuerySchema } from '../src/tracks'
import {
  buildAlbumBrowseFilterLabel,
  buildFilmBrowseFilterLabel,
  formatFilmSourceKindValue,
  parseAlbumBrowseFiltersParam,
  parseFilmBrowseFiltersParam,
  serializeAlbumBrowseFilters,
  serializeFilmBrowseFilters,
} from '../src/media'

describe('browse filter helpers', () => {
  it('keeps recording grouping opt-in for API and playback queries', () => {
    expect(TrackQuerySchema.parse({}).groupRecordings).toBeUndefined()
    expect(
      TrackQuerySchema.parse({ groupRecordings: 'false' }).groupRecordings,
    ).toBe(false)
    expect(
      TrackQuerySchema.parse({ groupRecordings: true }).groupRecordings,
    ).toBe(true)
    expect(
      TrackPositionsQuerySchema.parse({
        groupRecordings: 'true',
        positions: '0,4',
      }).groupRecordings,
    ).toBe(true)
    expect(
      TrackQuerySchema.safeParse({ groupRecordings: 'maybe' }).success,
    ).toBe(false)
  })

  it('serializes and parses album filters', () => {
    const serializedFilters = serializeAlbumBrowseFilters([
      {
        field: 'artist',
        value: 'David Bowie',
      },
    ])

    expect(serializedFilters).toBe('[{"field":"artist","value":"David Bowie"}]')
    expect(parseAlbumBrowseFiltersParam(serializedFilters)).toEqual([
      {
        field: 'artist',
        value: 'David Bowie',
      },
    ])
  })

  it('returns no album filters when the param is invalid', () => {
    expect(parseAlbumBrowseFiltersParam('not-json')).toEqual([])
  })

  it('serializes and parses film filters', () => {
    const serializedFilters = serializeFilmBrowseFilters([
      {
        field: 'source',
        value: 'imdb-rating',
      },
    ])

    expect(parseFilmBrowseFiltersParam(serializedFilters)).toEqual([
      {
        field: 'source',
        value: 'imdb-rating',
      },
    ])
  })

  it('formats labels for browse filters', () => {
    expect(
      buildAlbumBrowseFilterLabel({
        field: 'genre',
        value: 'Art Rock',
      }),
    ).toBe('Tags: Art Rock')

    expect(
      buildFilmBrowseFilterLabel({
        field: 'source',
        value: 'imdb-watchlist',
      }),
    ).toBe('Source: IMDb Watchlist')

    expect(formatFilmSourceKindValue('file')).toBe('File')
  })
})
