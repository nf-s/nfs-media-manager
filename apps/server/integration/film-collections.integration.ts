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
  AlbumCollectionBrowseQuerySchema,
  AlbumCollectionQuerySchema,
  AlbumCollectionSortSchema,
} from '@repo/schemas/album-collections'
import {
  FilmCollectionBrowseQuerySchema,
  FilmCollectionQuerySchema,
  FilmCollectionSortSchema,
} from '@repo/schemas/film-collections'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { AlbumQuerySchema } from '@repo/schemas/media'

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
const readStoredCollections = vi.fn(
  (payload: JsonValue) =>
    z
      .object({
        collections: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(payload).collections,
)
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [
    {
      manifest,
      readStoredCollections,
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
    {
      manifest: {
        ...manifest,
        id: 'fixture-album',
        displayName: 'Album fixture',
        mediaTypes: ['album'],
        sourceNavigation: {
          collectionUrlTemplate: 'https://example.test/albums/{id}',
        },
      },
      readStoredCollections,
    },
  ],
}))
import {
  countAlbumCollections,
  countFilmCollections,
  getAlbumCollection,
  getFilmCollection,
  listAlbumCollectionBrowsePage,
  listFilmCollectionBrowsePage,
} from '@/services/collections'

const browseQuery = FilmCollectionBrowseQuerySchema.parse

async function listFilmCollections() {
  return (
    await listFilmCollectionBrowsePage(browseQuery({ includeSources: 'true' }))
  ).items
}

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
    {
      id: 'outside-film',
      slug: 'outside-film',
      title: 'Outside film',
      mediaType: 'film',
      inLibrary: false,
    },
    {
      id: 'other-outside-film',
      slug: 'other-outside-film',
      title: 'Other outside film',
      mediaType: 'film',
      inLibrary: false,
    },
    { id: 'album', slug: 'album', title: 'Album', mediaType: 'album' },
    {
      id: 'album-beta',
      slug: 'album-beta',
      title: 'Beta',
      mediaType: 'album',
      releaseDate: new Date('2020-01-01'),
      sourceLabel: 'A source',
    },
    {
      id: 'album-gamma',
      slug: 'album-gamma',
      title: 'Gamma',
      mediaType: 'album',
      releaseDate: new Date('2019-01-01'),
      sourceLabel: 'B source',
    },
    {
      id: 'album-hidden',
      slug: 'album-hidden',
      title: 'Hidden album',
      mediaType: 'album',
      metadata: { legacyHidden: true },
    },
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
    { mediaItemId: 'outside-film' },
    { mediaItemId: 'other-outside-film' },
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
  await databaseClient.insert(schema.album).values([
    {
      mediaItemId: 'album',
      metadata: {
        'plugin.fixture-album.details': {
          collections: [{ id: 'mixed', name: 'Fixture collection' }],
        },
        'plugin.fixture.details': {
          collections: [{ id: 'wrong', name: 'Fixture collection' }],
        },
      },
    },
    {
      mediaItemId: 'album-beta',
      durationSec: 2400,
      dateAdded: new Date('2024-01-01'),
    },
    {
      mediaItemId: 'album-gamma',
      durationSec: 1800,
      dateAdded: new Date('2023-01-01'),
    },
    { mediaItemId: 'album-hidden' },
  ])
  await databaseClient.insert(schema.artist).values([
    { id: 'first-artist', name: 'First artist' },
    { id: 'second-artist', name: 'Second artist' },
  ])
  await databaseClient.insert(schema.mediaCredit).values([
    { mediaItemId: 'album-beta', artistId: 'first-artist', role: 'artist' },
    {
      mediaItemId: 'album-beta',
      artistId: 'second-artist',
      role: 'artist',
      billingOrder: 1,
    },
    { mediaItemId: 'album-gamma', artistId: 'second-artist', role: 'artist' },
  ])
  await databaseClient.insert(schema.playlistItem).values([
    { playlistId: 'collection', mediaItemId: 'alpha', position: 8 },
    { playlistId: 'collection', mediaItemId: 'beta', position: 2 },
    { playlistId: 'collection', mediaItemId: 'gamma', position: 8 },
    { playlistId: 'collection', mediaItemId: 'outside-film', position: 3 },
    {
      playlistId: 'collection',
      mediaItemId: 'other-outside-film',
      position: 5,
    },
    { playlistId: 'collection', mediaItemId: 'album', position: 0 },
    { playlistId: 'music-only', mediaItemId: 'album', position: 0 },
    { playlistId: 'music-only', mediaItemId: 'album-beta', position: 8 },
    { playlistId: 'music-only', mediaItemId: 'album-gamma', position: 8 },
    { playlistId: 'music-only', mediaItemId: 'album-hidden', position: 1 },
    { playlistId: 'playlist', mediaItemId: 'alpha', position: 1 },
    { playlistId: 'collection', mediaItemId: 'hidden', position: 1 },
    { playlistId: 'hidden-only', mediaItemId: 'hidden', position: 1 },
  ])
  await databaseClient.insert(schema.catalogObservation).values([
    {
      id: 'outside-source',
      mediaItemId: 'outside-film',
      provider: 'fixture',
      operation: 'provider-result',
    },
    {
      id: 'outside-search',
      mediaItemId: 'outside-film',
      provider: 'fixture',
      operation: 'catalog-search',
    },
    {
      id: 'other-outside-source',
      mediaItemId: 'other-outside-film',
      provider: 'fixture',
      operation: 'catalog-search',
    },
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
  it('uses the selected catalogue scope for rows, positions and counts', async () => {
    const combined = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({
        libraryScope: 'all',
        discoverySources: 'provider-result,catalog-search',
        discoverySourceMode: 'all',
        includeSources: 'false',
      }),
    )
    expect(combined.filmCount).toBe(4)
    expect(combined.items.totalCount).toBe(4)
    expect(combined.items.items.map(({ id }) => id)).toEqual([
      'beta',
      'outside-film',
      'alpha',
      'gamma',
    ])
    expect(combined.items.items[1]).toMatchObject({
      position: 3,
      dateAdded: null,
    })

    const outside = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({
        libraryScope: 'outside',
        discoverySources: 'provider-result,catalog-search',
        includeSources: 'false',
        page: 2,
        size: 1,
      }),
    )
    expect(outside.filmCount).toBe(2)
    expect(outside.items).toMatchObject({
      totalCount: 2,
      items: [{ id: 'other-outside-film', position: 5 }],
    })
  })

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

  it('can page collection films without reading collection source payloads', async () => {
    readStoredCollections.mockClear()
    const detail = await getFilmCollection(
      'collection',
      FilmCollectionQuerySchema.parse({
        size: 1,
        page: 2,
        includeSources: 'false',
      }),
    )
    expect(detail.sourceLinks).toEqual([])
    expect(detail.items).toMatchObject({
      totalCount: 3,
      items: [{ id: 'alpha' }],
    })
    expect(readStoredCollections).not.toHaveBeenCalled()
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
    expect(await countFilmCollections(browseQuery({}))).toEqual({
      totalCount: 1,
    })
  })

  it('loads source payloads only for returned rows when requested', async () => {
    const id = 'a-collection'
    await databaseClient.insert(schema.playlist).values({
      id,
      name: 'fixture collection',
      kind: 'collection',
    })
    try {
      await databaseClient.insert(schema.playlistItem).values({
        playlistId: id,
        mediaItemId: 'gamma',
      })
      readStoredCollections.mockClear()
      const first = await listFilmCollectionBrowsePage(
        browseQuery({ q: 'FIXTURE', size: 1, includeSources: 'true' }),
      )
      expect(first).toMatchObject({
        hasMore: true,
        items: [{ id, sourceLinks: [] }],
      })
      expect(readStoredCollections).not.toHaveBeenCalled()

      const query = browseQuery({ q: 'FIXTURE', size: 1, page: 2 })
      const second = await listFilmCollectionBrowsePage(query)
      expect(second).toMatchObject({
        hasMore: false,
        items: [{ id: 'collection', sourceLinks: [] }],
      })
      expect(await countFilmCollections(query)).toEqual({ totalCount: 2 })
      expect(readStoredCollections).not.toHaveBeenCalled()

      const withSources = await listFilmCollectionBrowsePage({
        ...query,
        includeSources: 'true',
      })
      expect(withSources.items[0]?.sourceLinks).toHaveLength(2)
      expect(readStoredCollections).toHaveBeenCalledOnce()
      expect(await countFilmCollections(browseQuery({ q: '%' }))).toEqual({
        totalCount: 0,
      })
    } finally {
      await databaseClient
        .delete(schema.playlist)
        .where(inArray(schema.playlist.id, [id]))
    }
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
        createdAt: new Date(Date.UTC(2020, 0, index + 1)),
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
      expect(listed).toHaveLength(100)
      const lastPage = await listFilmCollectionBrowsePage(
        browseQuery({ page: 2 }),
      )
      expect(lastPage).toMatchObject({ page: 2, size: 100, hasMore: false })
      expect(lastPage.items).toHaveLength(6)
      expect(
        new Set([...listed, ...lastPage.items].map((row) => row.id)).size,
      ).toBe(106)

      const filtered = browseQuery({
        q: ' batch collection 10 ',
        sortBy: 'createdAt',
        direction: 'desc',
        page: 2,
        size: 2,
      })
      expect(await countFilmCollections(filtered)).toEqual({ totalCount: 6 })
      const filteredPage = await listFilmCollectionBrowsePage(filtered)
      expect(filteredPage.items.map((row) => row.id)).toEqual([
        'batch-collection-102',
        'batch-collection-101',
      ])
      expect(filteredPage.hasMore).toBe(true)

      const byCount = await listFilmCollectionBrowsePage(
        browseQuery({
          sortBy: 'filmCount',
          direction: 'desc',
          page: 2,
          size: 1,
        }),
      )
      expect(byCount.items.map((row) => row.id)).toEqual(['batch-collection-1'])
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

describe('album collection memberships', () => {
  const query = AlbumCollectionQuerySchema.parse
  const browseQuery = AlbumCollectionBrowseQuerySchema.parse

  it('includes canonical membership IDs in album Browse and detail', async () => {
    const { getAlbumDetail, listAlbumBrowsePage } =
      await import('@/services/media')
    const detail = await getAlbumDetail('album')
    const browse = await listAlbumBrowsePage(AlbumQuerySchema.parse({}))
    const memberships = [
      { id: 'collection', name: 'Fixture collection', kind: 'collection' },
      { id: 'music-only', name: 'Music collection', kind: 'collection' },
    ]
    for (const media of [
      detail,
      browse.items.find((row) => row.id === 'album'),
    ])
      expect(media?.playlists).toMatchObject(memberships)
  })

  it('uses only visible albums for directory pages, counts and mixed collections', async () => {
    expect(
      await listAlbumCollectionBrowsePage(
        browseQuery({ size: 1, sortBy: 'albumCount', direction: 'desc' }),
      ),
    ).toMatchObject({
      items: [{ id: 'music-only', albumCount: 3, sourceLinks: [] }],
      hasMore: true,
    })
    expect(
      await listAlbumCollectionBrowsePage(
        browseQuery({
          size: 1,
          page: 2,
          sortBy: 'albumCount',
          direction: 'desc',
        }),
      ),
    ).toMatchObject({
      items: [{ id: 'collection', albumCount: 1, sourceLinks: [] }],
      hasMore: false,
    })
    expect(await countAlbumCollections(browseQuery({}))).toEqual({
      totalCount: 2,
    })
    expect(await countAlbumCollections(browseQuery({ q: 'MUSIC' }))).toEqual({
      totalCount: 1,
    })
    expect(await countAlbumCollections(browseQuery({ q: '_' }))).toEqual({
      totalCount: 0,
    })
    const mixed = await getAlbumCollection('collection', query({}))
    expect(mixed).toMatchObject({
      albumCount: 1,
      items: { totalCount: 1, items: [{ id: 'album' }] },
    })
    expect(mixed.sourceLinks.map((link) => link.url)).toEqual([
      'https://example.test/albums/mixed',
    ])
    for (const id of ['playlist', 'hidden-only', 'empty', 'missing'])
      await expect(getAlbumCollection(id, query({}))).rejects.toMatchObject({
        response: { statusCode: 404 },
      })
  })

  it('retains stored positions, ranks album-only fields globally and searches credited artists', async () => {
    const stored = await getAlbumCollection(
      'music-only',
      query({ includeSources: 'false' }),
    )
    expect(stored.items.items.map((row) => [row.id, row.position])).toEqual([
      ['album', 0],
      ['album-beta', 8],
      ['album-gamma', 8],
    ])
    const search = await getAlbumCollection(
      'music-only',
      query({ q: 'second artist', page: 2, size: 1, includeSources: 'false' }),
    )
    expect(search.items).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      items: [{ id: 'album-gamma', artists: ['Second artist'] }],
    })
    for (const sortBy of AlbumCollectionSortSchema.options) {
      const detail = await getAlbumCollection(
        'music-only',
        query({ sortBy, direction: 'desc', size: 1, includeSources: 'false' }),
      )
      expect(detail.items.items).toHaveLength(1)
      expect(detail.items.items[0]?.id, sortBy).toBe(
        ['position', 'releaseDate', 'durationSec', 'dateAdded'].includes(sortBy)
          ? 'album-beta'
          : 'album-gamma',
      )
    }
  })

  it('resolves historical album source IDs and ignores unrelated normalized payloads', async () => {
    const snapshots = ['album-source-history', 'album-source-unrelated']
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'album-source-history',
        checksum: 'history',
        mediaItemId: 'album-beta',
        provider: 'legacy-browser',
        source: 'legacy-clean-import',
        payload: { collections: [{ id: 'history', name: 'MUSIC COLLECTION' }] },
        normalizedData: {
          playlists: [{ kind: 'collection', name: 'Music collection' }],
        },
      },
      {
        id: 'album-source-unrelated',
        checksum: 'unrelated',
        mediaItemId: 'album-beta',
        provider: 'fixture-album',
        source: 'fixture',
        payload: {
          collections: [{ id: 'other', name: 'Different collection' }],
        },
        normalizedData: {
          playlists: [{ kind: 'collection', name: 'Different collection' }],
        },
      },
    ])
    try {
      readStoredCollections.mockClear()
      const result = await getAlbumCollection(
        'music-only',
        query({ size: 1, includeSources: 'true' }),
      )
      expect(result.sourceLinks.map((link) => link.url)).toEqual([
        'https://example.test/albums/history',
      ])
      expect(readStoredCollections).toHaveBeenCalledOnce()
    } finally {
      await databaseClient
        .delete(schema.providerSnapshot)
        .where(inArray(schema.providerSnapshot.id, snapshots))
    }
  })
})
