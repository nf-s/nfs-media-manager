import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FilmCollectionQuerySchema,
  FilmCollectionSortSchema,
} from '@repo/schemas/film-collections'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `film_collections_${randomUUID().replaceAll('-', '')}`
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
import {
  getFilmCollection,
  listFilmCollections,
} from '@/services/film-collections'

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in collection tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  const collectionRows: Array<{
    id: string
    name: string
    kind: 'collection' | 'playlist'
  }> = [
    { id: 'collection', name: 'Fixture collection', kind: 'collection' },
    { id: 'music-only', name: 'Music collection', kind: 'collection' },
    { id: 'playlist', name: 'Music playlist', kind: 'playlist' },
    { id: 'empty', name: 'Empty collection', kind: 'collection' },
  ]
  await databaseClient.insert(schema.playlist).values(collectionRows)
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'alpha',
      slug: 'alpha',
      title: 'Alpha film',
      mediaType: 'film',
      releaseDate: new Date('2001-01-01'),
      sourceLabel: 'A source',
    },
    {
      id: 'beta',
      slug: 'beta',
      title: 'Beta film',
      mediaType: 'film',
      releaseDate: new Date('2002-01-01'),
      sourceLabel: 'B source',
    },
    {
      id: 'gamma',
      slug: 'gamma',
      title: 'Gamma film',
      mediaType: 'film',
      releaseDate: null,
      sourceLabel: null,
    },
    { id: 'album', slug: 'album', title: 'Album', mediaType: 'album' },
  ])
  await databaseClient.insert(schema.film).values([
    {
      mediaItemId: 'alpha',
      runtimeMinutes: 100,
      watched: false,
      dateAdded: new Date('2020-01-01'),
    },
    {
      mediaItemId: 'beta',
      runtimeMinutes: 200,
      watched: true,
      dateAdded: new Date('2021-01-01'),
    },
    {
      mediaItemId: 'gamma',
      runtimeMinutes: null,
      watched: false,
      dateAdded: new Date('2022-01-01'),
    },
  ])
  await databaseClient.insert(schema.album).values({ mediaItemId: 'album' })
  await databaseClient.insert(schema.playlistItem).values([
    { playlistId: 'collection', mediaItemId: 'alpha', position: 8 },
    { playlistId: 'collection', mediaItemId: 'beta', position: 2 },
    { playlistId: 'collection', mediaItemId: 'gamma', position: 8 },
    { playlistId: 'collection', mediaItemId: 'album', position: 0 },
    { playlistId: 'music-only', mediaItemId: 'album', position: 0 },
    { playlistId: 'playlist', mediaItemId: 'alpha', position: 1 },
  ])
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('film collections', () => {
  it('lists only collections containing films and counts only their films', async () => {
    const rows = await listFilmCollections()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'collection',
      name: 'Fixture collection',
      filmCount: 3,
    })
  })

  it('defaults to stored positions before pagination, keeping gaps and stable ties', async () => {
    const first = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({ size: 1 }),
    )
    expect(first.items).toMatchObject({
      page: 1,
      size: 1,
      totalCount: 3,
      pageCount: 3,
    })
    expect(first.items.items.map((row) => [row.id, row.position])).toEqual([
      ['beta', 2],
    ])
    const second = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({ page: 2, size: 1 }),
    )
    expect(second.items.items.map((row) => [row.id, row.position])).toEqual([
      ['alpha', 8],
    ])
    const third = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({ page: 3, size: 1 }),
    )
    expect(third.items.items.map((row) => [row.id, row.position])).toEqual([
      ['gamma', 8],
    ])
    const empty = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({ page: 4, size: 1 }),
    )
    expect(empty.items.items).toEqual([])
    expect(empty.items.totalCount).toBe(3)
  })

  it('sorts every data column across all members, with nulls last in either direction', async () => {
    for (const sortBy of FilmCollectionSortSchema.options) {
      for (const direction of ['asc', 'desc']) {
        const query = FilmCollectionQuerySchema.parse({
          sortBy,
          direction,
          size: 1,
        })
        const page = await getFilmCollection('collection', query)
        const expected =
          sortBy === 'position'
            ? direction === 'asc'
              ? 'beta'
              : 'alpha'
            : sortBy === 'dateAdded' || sortBy === 'title'
              ? direction === 'asc'
                ? 'alpha'
                : 'gamma'
              : direction === 'asc'
                ? 'alpha'
                : 'beta'
        expect(page.items.items[0]?.id, `${sortBy} ${direction}`).toBe(expected)
      }
    }
    for (const sortBy of ['releaseDate', 'runtimeMinutes', 'source']) {
      for (const direction of ['asc', 'desc']) {
        const result = await getFilmCollection(
          'collection',
          FilmCollectionQuerySchema.parse({ sortBy, direction }),
        )
        expect(result.items.items.at(-1)?.id).toBe('gamma')
      }
    }
  })

  it('refuses music playlists, collections without films and missing IDs', async () => {
    for (const id of ['playlist', 'music-only', 'empty', 'missing'])
      await expect(
        getFilmCollection(id, FilmCollectionQuerySchema.parse({})),
      ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })
})
