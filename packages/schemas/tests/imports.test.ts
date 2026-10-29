import { describe, expect, it } from 'vitest'
import {
  FilmImportPreviewSchema,
  normalizeSavedView,
  StartImportSchema,
} from '../src/imports'

describe('local imports and saved views', () => {
  it('exposes unchanged rows and specific before/after changes in CSV previews', () => {
    const preview = FilmImportPreviewSchema.parse({
      id: 'preview',
      kind: 'csv',
      source: 'ratings.csv',
      expiresAt: '2026-01-01',
      existing: 2,
      skipped: 0,
      warnings: [],
      items: [
        {
          row: 0,
          title: 'Unchanged',
          identifiers: [],
          action: 'unchanged',
          needsIdentification: true,
        },
        {
          row: 1,
          title: 'Changed rating',
          identifiers: ['imdb: tt1234567'],
          action: 'update',
          needsIdentification: false,
          changes: [
            {
              field: 'metadata.browse.ratingImdbPersonal',
              label: 'Your IMDb rating',
              before: 6,
              after: 8,
            },
          ],
        },
      ],
    })
    expect(preview.items[0]?.changes).toEqual([])
    expect(preview.items[1]?.changes[0]).toMatchObject({ before: 6, after: 8 })
  })
  it('defaults to a small subset and requires an explicit broad import', () => {
    expect(StartImportSchema.parse({})).toEqual({
      fullLibrary: false,
      albumLimit: 2,
      filmLimit: 2,
    })
    expect(StartImportSchema.safeParse({ albumLimit: 6 }).success).toBe(false)
    expect(StartImportSchema.safeParse({ fullLibrary: 'true' }).success).toBe(
      false,
    )
  })

  it('accepts a legacy playlist without a sort and removes repeated filters', () => {
    const view = normalizeSavedView({
      name: 'House',
      filters: [
        { field: 'genres', value: 'house' },
        { field: 'genres', value: 'house' },
        { field: 'genres', value: 'classical', exclude: true },
        { field: 'energy', min: 0.4, max: 1, includeUndefined: false },
      ],
      limit: 100,
    })
    expect(view.sortBy).toBe('dateAdded')
    expect(view.direction).toBe('desc')
    expect(view.filters).toEqual([
      { field: 'genre', value: 'house', mode: 'any' },
      { field: 'genre', value: 'classical', mode: 'exclude' },
    ])
    expect(view.ranges).toEqual([])
  })

  it('preserves required filters, date aliases, ranges, direction and limits', () => {
    const view = normalizeSavedView({
      name: 'Recent',
      filters: [
        { field: 'artists', value: 'Artist', intersection: true },
        { field: 'dateReleased', min: 0, includeUndefined: true },
      ],
      sort: ['dateReleased', 'ASC'],
      limit: 30,
    })
    expect(view).toMatchObject({
      sortBy: 'releaseDate',
      direction: 'asc',
      limit: 30,
      filters: [{ field: 'artist', value: 'Artist', mode: 'required' }],
      ranges: [{ field: 'releaseDate', min: 0, includeMissing: true }],
    })
  })
})
