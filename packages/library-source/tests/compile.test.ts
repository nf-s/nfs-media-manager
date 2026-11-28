import { describe, expect, it } from 'vitest'
import { ListeningPeriodSchema } from '@repo/schemas/listening'
import { millisecondsToMicroseconds } from '../src/compile/fields'
import { listeningPeriodBounds, playTimeBounds } from '../src/compile/listening'
import {
  capCount,
  isMemberScope,
  listWindow,
  pageWindow,
  positionsWithin,
} from '../src/compile/query'
import { searchWords } from '../src/compile/search'
import { and, join, not, or, sql, values } from '../src/compile/sql'

describe('listeningPeriodBounds', () => {
  /**
   * The server's listeningPeriodBounds, browse-listening.ts, gave these for
   * the same inputs (run on 2026-11-28); the device copy must agree.
   */
  const server = [
    {
      now: '2024-03-31T10:20:30.456Z',
      period: { kind: 'rolling', amount: 1, unit: 'months' },
      from: '2024-02-29T10:20:30.456Z',
      to: '2024-03-31T10:20:30.456Z',
      inclusiveTo: true,
    },
    {
      now: '2024-03-31T10:20:30.456Z',
      period: { kind: 'rolling', amount: 13, unit: 'months' },
      from: '2023-02-28T10:20:30.456Z',
      to: '2024-03-31T10:20:30.456Z',
      inclusiveTo: true,
    },
    {
      now: '2024-02-29T23:59:59.999Z',
      period: { kind: 'rolling', amount: 1, unit: 'years' },
      from: '2023-02-28T23:59:59.999Z',
      to: '2024-02-29T23:59:59.999Z',
      inclusiveTo: true,
    },
    {
      now: '2024-01-15T00:00:00.000Z',
      period: { kind: 'rolling', amount: 1, unit: 'months' },
      from: '2023-12-15T00:00:00.000Z',
      to: '2024-01-15T00:00:00.000Z',
      inclusiveTo: true,
    },
    {
      now: '2024-03-01T05:00:00.000Z',
      period: { kind: 'rolling', amount: 2, unit: 'weeks' },
      from: '2024-02-16T05:00:00.000Z',
      to: '2024-03-01T05:00:00.000Z',
      inclusiveTo: true,
    },
    {
      now: '2024-03-01T05:00:00.000Z',
      period: { kind: 'rolling', amount: 1, unit: 'days' },
      from: '2024-02-29T05:00:00.000Z',
      to: '2024-03-01T05:00:00.000Z',
      inclusiveTo: true,
    },
    {
      now: '2024-12-31T23:00:00.000Z',
      period: { kind: 'dates', from: '2024-01-01', to: '2024-12-31' },
      from: '2024-01-01T00:00:00.000Z',
      to: '2025-01-01T00:00:00.000Z',
      inclusiveTo: false,
    },
    {
      now: '2024-12-31T23:00:00.000Z',
      period: { kind: 'dates', to: '2023-02-28' },
      from: undefined,
      to: '2023-03-01T00:00:00.000Z',
      inclusiveTo: false,
    },
  ]

  it.each(server)('matches the server for $period at $now', (expected) => {
    const bounds = listeningPeriodBounds(
      ListeningPeriodSchema.parse(expected.period),
      new Date(expected.now),
    )
    expect({
      from: bounds.from?.toISOString(),
      to: bounds.to?.toISOString(),
      inclusiveTo: bounds.inclusiveTo,
    }).toEqual({
      from: expected.from,
      to: expected.to,
      inclusiveTo: expected.inclusiveTo,
    })
  })

  it('has no bounds for all time', () => {
    expect(listeningPeriodBounds({ kind: 'all' }, new Date())).toEqual({})
  })

  it('turns millisecond bounds into whole play seconds on the inside', () => {
    const now = new Date('2024-03-31T10:20:30.456Z')
    expect(
      playTimeBounds({ kind: 'rolling', amount: 1, unit: 'months' }, now),
    ).toEqual({
      min: Date.parse('2024-02-29T10:20:31Z') / 1000,
      max: Date.parse('2024-03-31T10:20:30Z') / 1000,
    })
    expect(
      playTimeBounds(
        { kind: 'dates', from: '2024-01-01', to: '2024-01-31' },
        now,
      ),
    ).toEqual({
      min: Date.parse('2024-01-01T00:00:00Z') / 1000,
      max: Date.parse('2024-01-31T23:59:59Z') / 1000,
    })
  })
})

describe('millisecondsToMicroseconds', () => {
  it('multiplies whole milliseconds exactly', () => {
    expect(millisecondsToMicroseconds(1_700_000_000_000, 'min')).toBe(
      1_700_000_000_000_000,
    )
    expect(millisecondsToMicroseconds(-5, 'max')).toBe(-5000)
  })

  it('rounds a fraction to the inside of the bound, from its decimal form', () => {
    expect(millisecondsToMicroseconds(1_700_000_000_000.001, 'min')).toBe(
      1_700_000_000_000_001,
    )
    expect(millisecondsToMicroseconds(0.0015, 'min')).toBe(2)
    expect(millisecondsToMicroseconds(0.0015, 'max')).toBe(1)
    expect(millisecondsToMicroseconds(-0.0015, 'min')).toBe(-1)
    expect(millisecondsToMicroseconds(-0.0015, 'max')).toBe(-2)
    expect(millisecondsToMicroseconds(1.5e-7, 'min')).toBe(1)
    expect(millisecondsToMicroseconds(1.5e-7, 'max')).toBe(0)
  })

  it('clamps bounds beyond any stored date', () => {
    expect(millisecondsToMicroseconds(1e300, 'min')).toBe(2 ** 53)
    expect(millisecondsToMicroseconds(-1e300, 'max')).toBe(-(2 ** 53))
  })
})

describe('sql fragments', () => {
  it('binds values and inlines fragments in order', () => {
    const inner = sql`b = ${2}`
    const statement = sql`SELECT 1 WHERE a = ${'x'} AND ${inner} AND c = ${null}`
    expect(statement.text).toBe('SELECT 1 WHERE a = ? AND b = ? AND c = ?')
    expect(statement.params).toEqual(['x', 2, null])
  })

  it('combines conditions', () => {
    expect(and([]).text).toBe('1')
    expect(or([]).text).toBe('0')
    expect(and([sql`a = ${1}`, sql`b = ${2}`]).text).toBe('(a = ? AND b = ?)')
    expect(or([sql`a`, sql`b`]).text).toBe('(a OR b)')
    expect(not(sql`a`).text).toBe('NOT (a)')
    expect(join([sql`a`, sql`${3}`], ', ').params).toEqual([3])
  })

  it('binds a list as one JSON parameter', () => {
    const list = values(['a', "b'c"])
    expect(list.text).toBe('(SELECT value FROM json_each(?))')
    expect(list.params).toEqual(['["a","b\'c"]'])
  })
})

describe('shared query rules', () => {
  it('splits search words on whitespace, once each', () => {
    expect(searchWords(undefined)).toEqual([])
    expect(searchWords('  ')).toEqual([])
    expect(searchWords(' a\tb  a c ')).toEqual(['a', 'b', 'c'])
  })

  it('serves only the library member scope', () => {
    expect(isMemberScope({})).toBe(true)
    expect(isMemberScope({ libraryScope: 'library' })).toBe(true)
    expect(isMemberScope({ libraryScope: 'outside' })).toBe(false)
    expect(
      isMemberScope(
        {
          discoverySources: 'scrobble,playback',
          discoverySourceScope: 'selection',
        },
        'track',
      ),
    ).toBe(true)
    expect(
      isMemberScope({
        discoverySources: 'scrobble',
        discoverySourceScope: 'selection',
      }),
    ).toBe(false)
  })

  it('pages as the Browse routes do', () => {
    expect(pageWindow({ page: 2, size: 10 })).toEqual({ offset: 10, limit: 11 })
    expect(pageWindow({ page: 2, size: 10, limitResults: 15 })).toEqual({
      offset: 10,
      limit: 5,
    })
    expect(pageWindow({ page: 3, size: 10, limitResults: 15 })).toBeNull()
    expect(listWindow({ page: 2, size: 10 }, 15)).toEqual({
      offset: 10,
      limit: 5,
    })
    expect(listWindow({ page: 3, size: 10 }, 15)).toEqual({
      offset: 20,
      limit: 0,
    })
    expect(capCount(20, 5)).toBe(5)
    expect(capCount(20)).toBe(20)
    expect(positionsWithin([5, 1, 5, 9], 6)).toEqual([5, 1])
  })
})
