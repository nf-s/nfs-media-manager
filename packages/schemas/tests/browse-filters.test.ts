import { describe, expect, it } from 'vitest'
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
