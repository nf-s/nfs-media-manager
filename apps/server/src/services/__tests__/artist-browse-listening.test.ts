import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createArtistBrowseListening } from '../artist-browse-listening'

const dialect = new PgDialect()
const twoYears = { kind: 'rolling', amount: 2, unit: 'years' } as const

describe('artist listening queries', () => {
  it('reads every requested period from one grouped read of the scrobbles', () => {
    const listening = createArtistBrowseListening(
      {
        match: 'all',
        rules: [
          { period: { kind: 'all' }, min: 1 },
          { period: twoYears, max: 10 },
          { period: { kind: 'all' }, max: 100 },
        ],
      },
      twoYears,
      new Date('2026-03-31T12:00:00Z'),
    )
    if (!listening) throw new Error('Expected a listening query')
    const join = dialect.sqlToQuery(listening.join).sql
    expect(join.match(/from lastfm_scrobble/g)).toHaveLength(1)
    expect(join.match(/count\(\*\) filter/g)).toHaveLength(2)
    expect(join).toContain('union')
    expect(join).toContain('on listening_counts.artist_id = a.id')
    expect(listening.sort && dialect.sqlToQuery(listening.sort).sql).toBe(
      'coalesce("listening_counts"."count_1", 0)',
    )
  })

  it('matches all or any rule and leaves out a sort period without rules', () => {
    const rules = [
      { period: { kind: 'all' }, min: 1 },
      { period: twoYears, max: 0 },
    ] as const
    const all = createArtistBrowseListening(
      { match: 'all', rules: [...rules] },
      undefined,
    )
    const any = createArtistBrowseListening(
      { match: 'any', rules: [...rules] },
      undefined,
    )
    expect(all?.condition && dialect.sqlToQuery(all.condition).sql).toContain(
      ') and (',
    )
    expect(any?.condition && dialect.sqlToQuery(any.condition).sql).toContain(
      ') or (',
    )
    expect(all?.sort).toBeUndefined()
    expect(
      createArtistBrowseListening(undefined, twoYears)?.condition,
    ).toBeUndefined()
    expect(createArtistBrowseListening(undefined, undefined)).toBeUndefined()
  })
})
