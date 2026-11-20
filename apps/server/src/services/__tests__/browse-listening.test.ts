import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  createBrowseListening,
  listeningPeriodBounds,
  type BrowseListening,
  type ListeningSubject,
} from '../browse-listening'

const dialect = new PgDialect()

function sourceQuery(query: BrowseListening, subject: ListeningSubject) {
  const source = query.source(subject)
  if (!source) throw new Error('Expected an exact listening count')
  return dialect.sqlToQuery(source).sql
}

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
    for (const subject of ['album', 'track', 'recording'] as const)
      expect(sourceQuery(query, subject).match(/count\(\*\)/g)).toHaveLength(1)
    expect(createBrowseListening(undefined, undefined)).toBeUndefined()
  })

  it('counts tracks and recordings through linked scrobbled names', () => {
    const query = createBrowseListening(undefined, { kind: 'all' })
    if (!query) throw new Error('Expected a listening query')
    const track = sourceQuery(query, 'track')
    expect(track).toContain('from lastfm_track_link linked')
    expect(track).toContain('group by username, artist_key, track_key')
    expect(track).toContain('group by linked.track_media_item_id')
    const recording = sourceQuery(query, 'recording')
    // Each linked name of a group's members is counted once.
    expect(recording).toContain('select distinct m.group_key')
    expect(recording).toContain('group by linked.group_key')
    expect(sourceQuery(query, 'album')).toContain(
      'group by album_media_item_id',
    )
  })

  it('uses an existence check for zero-play rules without reading an exact count', () => {
    const query = createBrowseListening(
      {
        match: 'all',
        rules: [
          { period: { kind: 'rolling', amount: 1, unit: 'years' }, max: 0 },
        ],
      },
      undefined,
      new Date('2026-03-31T12:00:00Z'),
    )
    const condition = query?.condition('recording', sql`g.group_key`)
    if (!condition) throw new Error('Expected a listening rule')
    expect(query?.source('recording')).toBeUndefined()
    const compiled = dialect.sqlToQuery(condition)
    expect(compiled.sql).toContain(
      'not (exists (select 1 from recording_members',
    )
    expect(compiled.sql).toContain('listening_member.group_key = g.group_key')
    expect(compiled.params).toEqual([
      '2025-03-31T12:00:00.000Z',
      '2026-03-31T12:00:00.000Z',
    ])
  })
})
