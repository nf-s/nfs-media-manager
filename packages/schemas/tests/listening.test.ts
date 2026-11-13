import { describe, expect, it } from 'vitest'
import {
  ListeningFilterParamSchema,
  ListeningFilterSchema,
  ListeningPeriodParamSchema,
  ListeningPeriodSchema,
  ListeningRuleSchema,
} from '../src/listening'
import { AlbumQuerySchema } from '../src/media'

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
})
