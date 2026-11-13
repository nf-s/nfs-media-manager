import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `browse_listening_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false

async function addScrobbles(
  albumId: string | null,
  date: string,
  count: number,
) {
  await databaseClient.insert(schema.lastfmScrobble).values(
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      username: 'fixture-listener',
      listenedAt: new Date(date),
      artistName: 'Fixture artist',
      albumName: 'Fixture album',
      trackName: `Fixture track ${index}`,
      artistKey: 'fixture artist',
      albumKey: 'fixture album',
      trackKey: `fixture track ${index}`,
      albumMediaItemId: albumId,
    })),
  )
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-03-31T12:00:00Z'))
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  for (const id of ['a', 'b', 'c', 'd']) {
    await databaseClient.insert(schema.mediaItem).values({
      id,
      slug: id,
      mediaType: 'album',
      title: `Album ${id}`,
      metadata: {
        browse: { scrobbles: 999, popularitySpotify: id === 'd' ? 75 : 20 },
      },
    })
    await databaseClient.insert(schema.album).values({ mediaItemId: id })
  }
  await addScrobbles('a', '2022-06-01T00:00:00Z', 5)
  await addScrobbles('a', '2025-06-01T00:00:00Z', 2)
  await addScrobbles('a', '2024-03-31T12:00:00Z', 1)
  await addScrobbles('a', '2024-03-31T11:59:59.999Z', 1)
  await addScrobbles('a', '2026-03-31T12:00:00Z', 1)
  await addScrobbles('a', '2026-03-31T12:00:00.001Z', 1)
  await addScrobbles('b', '2022-06-01T00:00:00Z', 3)
  await addScrobbles('b', '2025-06-01T00:00:00Z', 6)
  await addScrobbles('d', '2022-06-01T00:00:00Z', 10)
  await addScrobbles(null, '2025-06-01T00:00:00Z', 20)
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function query(input: z.input<typeof AlbumQuerySchema>) {
  const { queryBrowseIds } = await import('@/services/browse')
  return queryBrowseIds(
    'album',
    AlbumQuerySchema.parse({ sortBy: 'title', direction: 'asc', ...input }),
  )
}

describe('album listening browse queries', () => {
  it('counts zero linked plays without falling back to provider totals', async () => {
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, max: 0 }],
          },
        })
      ).ids,
    ).toEqual(['c'])
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'rolling', amount: 2, unit: 'years' },
                min: 4,
                max: 6,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['a', 'b'])
  })

  it('combines different periods with all or any and ANDs other browse filters', async () => {
    const rules = [
      { period: { kind: 'all' }, min: 10 },
      { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 0 },
    ]
    expect((await query({ listening: { match: 'all', rules } })).ids).toEqual([
      'd',
    ])
    expect((await query({ listening: { match: 'any', rules } })).ids).toEqual([
      'a',
      'c',
      'd',
    ])
    expect(
      (
        await query({
          listening: { match: 'any', rules },
          ranges: [{ field: 'popularitySpotify', min: 70 }],
        })
      ).ids,
    ).toEqual(['d'])
    expect(
      (
        await query({
          listening: { match: 'all', rules },
          filters: JSON.stringify([
            { field: 'title', value: 'Album d', mode: 'exclude' },
          ]),
        })
      ).ids,
    ).toEqual([])
  })

  it('uses inclusive UTC dates and keeps different periods separate in the count cache', async () => {
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'dates', from: '2024-03-31', to: '2024-03-31' },
                min: 2,
                max: 2,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['a'])
    const first = await query({
      listening: {
        match: 'all',
        rules: [{ period: { kind: 'dates', to: '2023-01-01' }, min: 6 }],
      },
    })
    const second = await query({
      listening: {
        match: 'all',
        rules: [{ period: { kind: 'dates', from: '2025-01-01' }, min: 6 }],
      },
    })
    expect(first.ids).toEqual(['d'])
    expect(first.totalCount).toBe(1)
    expect(second.ids).toEqual(['b'])
    expect(second.totalCount).toBe(1)
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, min: 6 }],
          },
        })
      ).totalCount,
    ).toBe(3)
  })

  it('sorts and paginates counts with stable IDs and returns the displayed values', async () => {
    const listeningSort = { kind: 'rolling', amount: 2, unit: 'years' }
    const first = await query({
      listeningSort,
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 2,
    })
    const second = await query({
      listeningSort,
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 2,
      page: 2,
    })
    expect(first).toMatchObject({
      ids: ['b', 'a'],
      totalCount: 4,
      pageCount: 2,
    })
    expect([...(first.listeningScrobbles ?? [])]).toEqual([
      ['b', 6],
      ['a', 4],
    ])
    expect(second.ids).toEqual(['c', 'd'])
    expect(
      (
        await query({
          listeningSort,
          sortBy: 'listeningScrobbles',
          direction: 'asc',
        })
      ).ids,
    ).toEqual(['c', 'd', 'a', 'b'])
    const { listAlbums } = await import('@/services/media')
    const albums = await listAlbums(
      AlbumQuerySchema.parse({
        listeningSort,
        sortBy: 'title',
        direction: 'asc',
      }),
    )
    expect(
      albums.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['a', 4],
      ['b', 6],
      ['c', 0],
      ['d', 0],
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('defaults custom count sorting to one year and rejects film listening controls', async () => {
    expect(
      (await query({ sortBy: 'listeningScrobbles', direction: 'desc' })).ids,
    ).toEqual(['b', 'a', 'c', 'd'])
    const { queryBrowseIds } = await import('@/services/browse')
    await expect(
      queryBrowseIds(
        'film',
        AlbumQuerySchema.parse({ listeningSort: { kind: 'all' } }),
      ),
    ).rejects.toThrow('Listening controls are only available for albums')
  })

  it('includes both ends of a UTC calendar day while excluding adjacent days', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'date-edges',
      slug: 'date-edges',
      mediaType: 'album',
      title: 'Date edge fixture',
    })
    await databaseClient
      .insert(schema.album)
      .values({ mediaItemId: 'date-edges' })
    for (const date of [
      '2024-02-28T23:59:59.999Z',
      '2024-02-29T00:00:00Z',
      '2024-02-29T23:59:59.999Z',
      '2024-03-01T00:00:00Z',
    ]) {
      await addScrobbles('date-edges', date, 1)
    }
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'dates', from: '2024-02-29', to: '2024-02-29' },
                min: 2,
                max: 2,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['date-edges'])
  })
})
