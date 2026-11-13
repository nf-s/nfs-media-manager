import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  createBrowseListening,
  listeningPeriodBounds,
} from '../browse-listening'

describe('listening query periods', () => {
  it('subtracts calendar months and years with leap-day and month-end clamping', () => {
    expect(
      listeningPeriodBounds(
        { kind: 'rolling', amount: 1, unit: 'months' },
        new Date('2024-03-31T12:34:56Z'),
      ).from?.toISOString(),
    ).toBe('2024-02-29T12:34:56.000Z')
    expect(
      listeningPeriodBounds(
        { kind: 'rolling', amount: 1, unit: 'years' },
        new Date('2024-02-29T12:34:56Z'),
      ).from?.toISOString(),
    ).toBe('2023-02-28T12:34:56.000Z')
    expect(
      listeningPeriodBounds(
        { kind: 'rolling', amount: 2, unit: 'weeks' },
        new Date('2026-01-05T12:34:56Z'),
      ).from?.toISOString(),
    ).toBe('2025-12-22T12:34:56.000Z')
  })

  it('covers the entire inclusive end date with a next-day exclusive boundary', () => {
    const bounds = listeningPeriodBounds(
      { kind: 'dates', from: '2024-02-29', to: '2024-02-29' },
      new Date('2026-01-01'),
    )
    expect(bounds).toEqual({
      from: new Date('2024-02-29T00:00:00Z'),
      to: new Date('2024-03-01T00:00:00Z'),
      inclusiveTo: false,
    })
    expect(listeningPeriodBounds({ kind: 'all' }, new Date())).toEqual({})
  })

  it('deduplicates shared filter/sort periods into a single aggregate count', () => {
    const query = createBrowseListening(
      {
        match: 'all',
        rules: [
          { period: { kind: 'all' }, min: 1 },
          { period: { kind: 'all' }, max: 10 },
        ],
      },
      { kind: 'all' },
    )
    if (!query) throw new Error('Expected a listening query')
    const sql = new PgDialect().sqlToQuery(query.source).sql
    expect(sql.match(/count\(\*\)/g)).toHaveLength(1)
    expect(createBrowseListening(undefined, undefined)).toBeUndefined()
  })
})
