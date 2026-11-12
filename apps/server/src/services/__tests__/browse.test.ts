import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import { FilmQuerySchema } from '@repo/schemas/media'

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  rows: vi.fn(),
  limit: vi.fn(),
  order: vi.fn(),
  execute: vi.fn(),
  plugins: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    execute: mocks.execute,
    select: (selection: object) => {
      const builder = {
        from: () => builder,
        leftJoin: () => builder,
        where: (where: SQL) =>
          'value' in selection ? mocks.count(where) : builder,
        orderBy: (...order: unknown[]) => {
          mocks.order(...order)
          return builder
        },
        limit: (limit: number) => {
          mocks.limit(limit)
          return builder
        },
        offset: mocks.rows,
      }
      return builder
    },
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: mocks.plugins,
}))

const dialect = new PgDialect()
let version = '100:100:'
let facetReads = 0

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  version = '100:100:'
  facetReads = 0
  mocks.plugins.mockResolvedValue([])
  mocks.count.mockResolvedValue([{ value: 250 }])
  mocks.rows.mockResolvedValue([{ id: 'film-1' }])
  mocks.execute.mockImplementation(async (query: SQL) => {
    if (dialect.sqlToQuery(query).sql.includes('pg_current_snapshot'))
      return {
        rows: [
          { version, database: 'test', role: 'test', schemas: '{public}' },
        ],
      }
    facetReads += 1
    return { rows: [{ field: 'genre', value: 'drama', count: 2 }] }
  })
})

describe('bounded browse reads', () => {
  it('reuses a count across random page jumps without caching page IDs', async () => {
    const { queryBrowseIds } = await import('../browse')
    const first = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({ size: 50 }),
    )
    const last = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({ page: 5, size: 50 }),
    )
    expect(first.totalCount).toBe(250)
    expect(last.pageCount).toBe(5)
    expect(mocks.rows.mock.calls).toEqual([[0], [200]])
    expect(mocks.count).toHaveBeenCalledTimes(1)
  })

  it('reuses facets only while the database version is unchanged', async () => {
    const { listBrowseFacets } = await import('../browse')
    const first = await listBrowseFacets('film')
    expect(await listBrowseFacets('film')).toEqual(first)
    expect(facetReads).toBe(1)
    version = '101:101:'
    await listBrowseFacets('film')
    expect(facetReads).toBe(2)
  })

  it('keeps filters, libraries, SQL options and archive visibility in count identities', async () => {
    const { queryBrowseIds } = await import('../browse')
    for (const input of [
      {},
      { q: 'one' },
      { q: 'two' },
      { includeArchived: 'true' },
      {
        filters: JSON.stringify([
          { field: 'genre', value: 'drama', mode: 'exclude' },
        ]),
      },
      { ranges: [{ field: 'runtimeMinutes', min: 10, includeMissing: true }] },
      { sourceKind: 'imdb' },
    ])
      await queryBrowseIds('film', FilmQuerySchema.parse(input))
    await queryBrowseIds('album', FilmQuerySchema.parse({}))
    await queryBrowseIds('film', FilmQuerySchema.parse({}), {
      conditions: [sql`false`],
    })
    expect(mocks.count).toHaveBeenCalledTimes(9)
  })

  it('invalidates counts when an already-running writer commits', async () => {
    const { queryBrowseIds } = await import('../browse')
    version = '100:103:100,102'
    await queryBrowseIds('film', FilmQuerySchema.parse({}))
    version = '100:103:100'
    mocks.count.mockResolvedValue([{ value: 251 }])
    expect(
      await queryBrowseIds('film', FilmQuerySchema.parse({})),
    ).toMatchObject({ totalCount: 251 })
    expect(mocks.count).toHaveBeenCalledTimes(2)
  })

  it('limits every field independently and searches literal values before grouping', async () => {
    const { listBrowseFacets, listBrowseFields } = await import('../browse')
    let captured: SQL | undefined
    mocks.execute.mockImplementation(async (query: SQL) => {
      if (dialect.sqlToQuery(query).sql.includes('pg_current_snapshot'))
        return {
          rows: [
            { version, database: 'test', role: 'test', schemas: '{public}' },
          ],
        }
      captured = query
      return { rows: [] }
    })
    await listBrowseFacets('film', { q: '50%_ needle' })
    if (!captured) throw new Error('Expected facet SQL')
    const query = dialect.sqlToQuery(captured)
    const fields = (await listBrowseFields('film')).filter(
      (field) => field.type === 'text' && field.filterable,
    )
    expect(query.sql.match(/limit \$/g)).toHaveLength(fields.length)
    expect(query.params.filter((param) => param === 25)).toHaveLength(
      fields.length,
    )
    expect(query.params).toContain('%50\\%\\_%')
    expect(query.params).toContain('%needle%')
    expect(query.sql.indexOf('value ilike')).toBeLessThan(
      query.sql.indexOf('group by value'),
    )
    expect(query.sql).toContain('order by case when lower(value)')
  })

  it('separates searches and per-field limits in the facet cache', async () => {
    const { listBrowseFacets } = await import('../browse')
    await listBrowseFacets('film', { q: 'one' })
    await listBrowseFacets('film', { q: 'two' })
    await listBrowseFacets('film', { q: 'one', limitPerField: 50 })
    await listBrowseFacets('film', { q: 'one' })
    expect(facetReads).toBe(3)
    await expect(
      listBrowseFacets('film', { q: 'x'.repeat(201) }),
    ).rejects.toThrow()
    expect(facetReads).toBe(3)
  })

  it('keeps stable ID tie-breaking and directional ordering on every page', async () => {
    const { queryBrowseIds } = await import('../browse')
    const { mediaItem } = await import('@/schemas/db')
    await queryBrowseIds('film', FilmQuerySchema.parse({ direction: 'asc' }))
    await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({ direction: 'desc', page: 3 }),
    )
    expect(mocks.order).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      mediaItem.id,
    )
    expect(mocks.order).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      mediaItem.id,
    )
    expect(mocks.count).toHaveBeenCalledTimes(1)
  })

  it('keeps result caps and empty far pages exact when sharing the raw count', async () => {
    const { queryBrowseIds } = await import('../browse')
    const capped = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({ limitResults: 75, page: 2, size: 50 }),
    )
    const far = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({ limitResults: 75, page: 8, size: 50 }),
    )
    const uncapped = await queryBrowseIds('film', FilmQuerySchema.parse({}))
    expect(capped).toMatchObject({ totalCount: 75, pageCount: 2 })
    expect(far).toMatchObject({ totalCount: 75, pageCount: 2 })
    expect(uncapped.totalCount).toBe(250)
    expect(mocks.limit.mock.calls.slice(0, 2)).toEqual([[25], [0]])
    expect(mocks.rows.mock.calls.slice(0, 2)).toEqual([[50], [350]])
    expect(mocks.count).toHaveBeenCalledTimes(1)
  })
})
