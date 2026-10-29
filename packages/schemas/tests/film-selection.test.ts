import { describe, expect, it } from 'vitest'
import {
  FilmSelectionQuerySchema,
  QueueFilmSelectionSchema,
} from '../src/film-selection'

describe('film selection contracts', () => {
  it('accepts existing browse filters and provider freshness sort', () => {
    const result = FilmSelectionQuerySchema.parse({
      provider: 'fixture',
      sortBy: 'lastScrapedAt',
      filters: JSON.stringify([
        { field: 'country', value: 'France', mode: 'required' },
      ]),
      olderThanDays: '180',
    })
    expect(result.olderThanDays).toBe(180)
    expect(result.filters[0]?.field).toBe('country')
  })
  it('requires explicit selection, providers and a batch identifier', () => {
    expect(QueueFilmSelectionSchema.safeParse({}).success).toBe(false)
    expect(FilmSelectionQuerySchema.parse({}).sortBy).toBe('dateAdded')
  })
  it('accepts independent per-provider freshness and rejects ambiguous or malformed filters', () => {
    const freshness = [
      { provider: 'one', mode: 'never' },
      { provider: 'two', mode: 'older', olderThanDays: 90 },
    ]
    expect(
      FilmSelectionQuerySchema.parse({ freshness: JSON.stringify(freshness) })
        .freshness,
    ).toEqual(freshness)
    for (const value of [
      'broken',
      [{}],
      [{ provider: 'one', mode: 'older' }],
      [{ provider: 'one', mode: 'older', olderThanDays: 0 }],
      [freshness[0], freshness[0]],
    ])
      expect(
        FilmSelectionQuerySchema.safeParse({ freshness: value }).success,
      ).toBe(false)
    expect(
      FilmSelectionQuerySchema.safeParse({ sortBy: 'lastScrapedAt' }).success,
    ).toBe(false)
    expect(
      FilmSelectionQuerySchema.safeParse({ olderThanDays: 30 }).success,
    ).toBe(false)
  })
  it('bounds a transport chunk but allows batching large selections', () => {
    const input = {
      batchId: '97d0dc00-0294-4232-9de1-a5178280c332',
      providers: ['fixture'],
      mediaItemIds: Array.from({ length: 100 }, (_, i) => `film-${i}`),
    }
    expect(QueueFilmSelectionSchema.parse(input).confirmBroadRun).toBe(false)
    expect(
      QueueFilmSelectionSchema.safeParse({
        ...input,
        mediaItemIds: [...input.mediaItemIds, 'extra'],
      }).success,
    ).toBe(false)
  })
})
