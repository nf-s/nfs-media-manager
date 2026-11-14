import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import {
  MediaPluginManifestSchema,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
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
const manifest = MediaPluginManifestSchema.parse({
  id: 'fixture',
  displayName: 'Fixture',
  description: '',
  mediaTypes: ['film'],
  secrets: [],
  rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
  sourceNavigation: {
    collectionUrlTemplate: 'https://example.test/collections/{id}',
  },
})
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [
    {
      manifest,
      readStoredCollections: (payload: JsonValue) =>
        z
          .object({
            collections: z.array(
              z.object({ id: z.string(), name: z.string() }),
            ),
          })
          .parse(payload).collections,
    },
    {
      manifest: {
        ...manifest,
        id: 'fixture-second',
        displayName: 'Second fixture',
        sourceNavigation: {
          collectionUrlTemplate: 'https://example.test/second/{id}',
        },
      },
    },
  ],
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
    { id: 'hidden-only', name: 'Hidden collection', kind: 'collection' },
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
      metadata: {
        'plugin.fixture.details': {
          collections: [
            { id: 17, name: 'Fixture collection' },
            { name: 'Fixture collection', url: 'javascript:invalid' },
            { id: 99, name: 'Different collection' },
          ],
        },
      },
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
    {
      id: 'hidden',
      slug: 'hidden',
      title: 'Hidden film',
      mediaType: 'film',
      metadata: { legacyHidden: true },
    },
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
    { mediaItemId: 'hidden' },
  ])
  await databaseClient.insert(schema.providerCurrentState).values({
    id: 'stored-collection-source',
    checksum: 'fixture',
    status: 'success',
    mediaItemId: 'beta',
    provider: 'legacy-record',
    payload: {
      collections: [
        { id: '17', name: 'Fixture collection' },
        { id: '18', name: 'Fixture collection' },
      ],
    },
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: 'album' })
  await databaseClient.insert(schema.playlistItem).values([
    { playlistId: 'collection', mediaItemId: 'alpha', position: 8 },
    { playlistId: 'collection', mediaItemId: 'beta', position: 2 },
    { playlistId: 'collection', mediaItemId: 'gamma', position: 8 },
    { playlistId: 'collection', mediaItemId: 'album', position: 0 },
    { playlistId: 'music-only', mediaItemId: 'album', position: 0 },
    { playlistId: 'playlist', mediaItemId: 'alpha', position: 1 },
    { playlistId: 'collection', mediaItemId: 'hidden', position: 1 },
    { playlistId: 'hidden-only', mediaItemId: 'hidden', position: 1 },
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
  it('uses only validated matching stored source links in lists and details', async () => {
    const expected = [
      'https://example.test/collections/17',
      'https://example.test/collections/18',
    ]
    expect(
      (await listFilmCollections())[0]?.sourceLinks.map((link) => link.url),
    ).toEqual(expected)
    expect(
      (
        await getFilmCollection(
          'collection',
          FilmCollectionQuerySchema.parse({ size: 1 }),
        )
      ).sourceLinks.map((link) => link.url),
    ).toEqual(expected)
  })

  it('filters multiple watched values before pagination', async () => {
    const both = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({
        watchedStates: JSON.stringify(['watched', 'unwatched']),
        size: 1,
        page: 3,
      }),
    )
    expect(both.items).toMatchObject({ totalCount: 3, pageCount: 3 })
    expect(both.items.items.map((row) => row.id)).toEqual(['gamma'])
    const one = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({
        watchedStates: ['unwatched'],
        size: 1,
        page: 2,
      }),
    )
    expect(one.items).toMatchObject({ totalCount: 2, pageCount: 2 })
    expect(one.items.items.map((row) => row.id)).toEqual(['gamma'])
  })

  it('filters title and watched status before pagination while preserving stored positions', async () => {
    const filtered = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({
        q: 'FILM',
        watched: 'unwatched',
        size: 1,
        page: 2,
      }),
    )
    expect(filtered.filmCount).toBe(3)
    expect(filtered.items).toMatchObject({ totalCount: 2, pageCount: 2 })
    expect(filtered.items.items.map((row) => [row.id, row.position])).toEqual([
      ['gamma', 8],
    ])
    const watched = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({ watched: 'watched' }),
    )
    expect(watched.items.items.map((row) => row.id)).toEqual(['beta'])
    const literal = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({ q: '%' }),
    )
    expect(literal.items).toMatchObject({
      totalCount: 0,
      pageCount: 0,
      items: [],
    })
  })

  it('excludes legacy-hidden films from collection counts, members and discovery', async () => {
    const detail = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({}),
    )
    expect(detail.filmCount).toBe(3)
    expect(detail.items.totalCount).toBe(3)
    expect(detail.items.items.map((row) => row.id)).toEqual([
      'beta',
      'alpha',
      'gamma',
    ])
    expect((await listFilmCollections()).map((row) => row.id)).toEqual([
      'collection',
    ])
    await expect(
      getFilmCollection('hidden-only', FilmCollectionQuerySchema.parse({})),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

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

  it('retains every source across overlapping collections and multiple read batches', async () => {
    const collections: Array<typeof schema.playlist.$inferInsert> = Array.from(
      { length: 105 },
      (_, index) => ({
        id: `batch-collection-${index}`,
        name: `Batch collection ${index}`,
        kind: 'collection',
      }),
    )
    const sourceNames = ['Batch collection 0', 'Batch collection 1']
    const items: Array<typeof schema.mediaItem.$inferInsert> = Array.from(
      { length: 205 },
      (_, index) => ({
        id: `batch-film-${index}`,
        slug: `batch-film-${index}`,
        title: `Batch film ${index}`,
        mediaType: 'film',
        metadata:
          index === 204
            ? {
                unrelated: {
                  content:
                    'Unrelated metadata must not affect collection provenance',
                },
                'plugin.fixture.details': {
                  collections: sourceNames.map((name) => ({
                    id: 'saved',
                    name,
                  })),
                  unrelated: { details: 'Not collection data' },
                },
                'plugin.fixture-second.details': {
                  collections: sourceNames.map((name) => ({
                    id: 'second',
                    name,
                  })),
                },
              }
            : {},
      }),
    )
    try {
      await databaseClient.insert(schema.playlist).values(collections)
      await databaseClient.insert(schema.mediaItem).values(items)
      await databaseClient
        .insert(schema.film)
        .values(items.map((item) => ({ mediaItemId: item.id })))
      await databaseClient.insert(schema.playlistItem).values(
        collections.flatMap((collection, index) =>
          (index < 2 ? items : items.slice(0, 1)).map((item, position) => ({
            playlistId: collection.id,
            mediaItemId: item.id,
            position,
          })),
        ),
      )
      await databaseClient.insert(schema.providerCurrentState).values({
        id: 'batch-source',
        checksum: 'fixture',
        status: 'success',
        mediaItemId: 'batch-film-203',
        provider: 'legacy-record',
        payload: {
          collections: sourceNames.map((name) => ({ id: 'legacy', name })),
        },
      })
      const listed = await listFilmCollections()
      const expected = [
        'https://example.test/collections/legacy',
        'https://example.test/collections/saved',
        'https://example.test/second/second',
      ]
      for (const id of ['batch-collection-0', 'batch-collection-1']) {
        expect(
          listed
            .find((row) => row.id === id)
            ?.sourceLinks.map((link) => link.url)
            .sort(),
        ).toEqual(expected)
        const detail = await getFilmCollection(
          id,
          FilmCollectionQuerySchema.parse({ size: 1 }),
        )
        expect(detail.sourceLinks.map((link) => link.url).sort()).toEqual(
          expected,
        )
        expect(detail.items.totalCount).toBe(205)
      }
      expect(
        listed.find((row) => row.id === 'batch-collection-104')?.sourceLinks,
      ).toEqual([])
    } finally {
      await databaseClient.delete(schema.playlist).where(
        inArray(
          schema.playlist.id,
          collections.map((collection) => collection.id),
        ),
      )
      await databaseClient.delete(schema.mediaItem).where(
        inArray(
          schema.mediaItem.id,
          items.map((item) => item.id),
        ),
      )
    }
  })
})
