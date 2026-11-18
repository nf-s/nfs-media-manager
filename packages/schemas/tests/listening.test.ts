import { describe, expect, it } from 'vitest'
import {
  ListeningFilterParamSchema,
  ListeningFilterSchema,
  ListeningHistogramSchema,
  listeningHistogramEdges,
  ListeningPeriodParamSchema,
  ListeningPeriodSchema,
  ListeningRuleSchema,
} from '../src/listening'
import {
  AlbumListeningHistogramQuerySchema,
  AlbumQuerySchema,
} from '../src/media'
import { TrackQuerySchema } from '../src/tracks'
import { ArtistQuerySchema } from '../src/creators'

describe('listening controls', () => {
  it('parses optional URL state and preserves zero count bounds', () => {
    const listening = {
      match: 'all',
      rules: [{ period: { kind: 'all' }, max: 0 }],
    }
    expect(ListeningFilterParamSchema.parse(JSON.stringify(listening))).toEqual(
      listening,
    )
    expect(ListeningFilterParamSchema.parse(null)).toBeUndefined()
    expect(ListeningPeriodParamSchema.parse('')).toBeUndefined()
    expect(
      AlbumQuerySchema.parse({
        listening: JSON.stringify(listening),
        listeningSort: '{"kind":"all"}',
      }),
    ).toMatchObject({
      listening,
      listeningSort: { kind: 'all' },
    })
    expect(ListeningFilterParamSchema.safeParse('not json').success).toBe(false)
  })

  it('validates calendar dates, date ordering and open date ranges', () => {
    expect(
      ListeningPeriodSchema.parse({ kind: 'dates', from: '2024-02-29' }),
    ).toEqual({ kind: 'dates', from: '2024-02-29' })
    expect(
      ListeningPeriodSchema.safeParse({ kind: 'dates', to: '2025-02-29' })
        .success,
    ).toBe(false)
    expect(
      ListeningPeriodSchema.safeParse({
        kind: 'dates',
        from: '2026-03-02',
        to: '2026-03-01',
      }).success,
    ).toBe(false)
    expect(ListeningPeriodSchema.safeParse({ kind: 'dates' }).success).toBe(
      false,
    )
  })

  it('requires whole nonnegative counts, at least one bound and ordered bounds', () => {
    for (const bounds of [
      {},
      { min: -1 },
      { max: 1.5 },
      { min: 3, max: 2 },
      { min: Infinity },
      { max: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(
        ListeningRuleSchema.safeParse({ period: { kind: 'all' }, ...bounds })
          .success,
      ).toBe(false)
    }
    expect(
      ListeningRuleSchema.safeParse({ period: { kind: 'all' }, min: 0, max: 0 })
        .success,
    ).toBe(true)
  })

  it('bounds rolling windows and the number of rules', () => {
    for (const amount of [0, -1, 1.5, 1001]) {
      expect(
        ListeningPeriodSchema.safeParse({
          kind: 'rolling',
          amount,
          unit: 'years',
        }).success,
      ).toBe(false)
    }
    expect(
      ListeningFilterSchema.safeParse({
        match: 'all',
        rules: Array.from({ length: 11 }, () => ({
          period: { kind: 'all' },
          min: 1,
        })),
      }).success,
    ).toBe(false)
    expect(
      ListeningFilterSchema.safeParse({ match: 'invalid', rules: [] }).success,
    ).toBe(false)
  })

  it('accepts listening rules and a sort period on tracks and artists', () => {
    const listening = {
      match: 'any',
      rules: [
        { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 0 },
      ],
    }
    const params = {
      listening: JSON.stringify(listening),
      listeningSort: '{"kind":"all"}',
      sortBy: 'listeningScrobbles',
    }
    for (const schema of [TrackQuerySchema, ArtistQuerySchema])
      expect(schema.parse(params)).toMatchObject({
        listening,
        listeningSort: { kind: 'all' },
        sortBy: 'listeningScrobbles',
      })
    expect(TrackQuerySchema.parse({}).listening).toBeUndefined()
  })

  it('requires a period for a histogram and one count per bar', () => {
    expect(AlbumListeningHistogramQuerySchema.safeParse({}).success).toBe(false)
    expect(
      AlbumListeningHistogramQuerySchema.parse({ period: '{"kind":"all"}' })
        .period,
    ).toEqual({ kind: 'all' })
    const edges = [...listeningHistogramEdges.album]
    expect(
      ListeningHistogramSchema.safeParse({ edges, counts: edges.map(() => 0) })
        .success,
    ).toBe(true)
    expect(
      ListeningHistogramSchema.safeParse({ edges, counts: [1] }).success,
    ).toBe(false)
  })
})
