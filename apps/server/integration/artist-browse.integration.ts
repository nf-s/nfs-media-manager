import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { ArtistProfileProviderSchema } from '@repo/schemas/artist-profiles'
import {
  ArtistMetadataQuerySchema,
  ArtistQuerySchema,
} from '@repo/schemas/creators'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = 'artist_browse_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const database = drizzle(pool, { schema, logger: { logQuery } })
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listArtistEnrichmentProviderIds: async () =>
    ArtistProfileProviderSchema.options,
  listLoadedScrapePlugins: async () => [],
}))
let created = false

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    }),
  )
  await admin.connect()
  await admin.query('create database ' + name)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
  await pool.query(`
    insert into artist (id, name) select 'artist-' || n, 'Fixture artist ' || lpad(n::text, 6, '0') from generate_series(1, 5000) n;
    insert into media_item (id, slug, media_type, title) select 'album-' || n, 'album-' || n, 'album', 'Fixture album ' || n from generate_series(1, 5000) n;
    insert into album (media_item_id) select id from media_item;
    insert into media_credit (media_item_id, artist_id, role) select 'album-' || n, 'artist-' || n, 'artist' from generate_series(1, 5000) n;
    insert into media_item (id, slug, media_type, title) select 'track-' || n, 'track-' || n, 'track', 'Fixture track ' || n from generate_series(1, 20000) n;
    insert into library_track (media_item_id, album_media_item_id) select 'track-' || n, 'album-' || ((n-1) % 5000 + 1) from generate_series(1, 20000) n;
    insert into media_credit (media_item_id, artist_id, role) select 'track-' || n, 'artist-' || ((n-1) % 5000 + 1), 'artist' from generate_series(1, 20000) n;
    insert into playlist (id, name, kind, source) select 'playlist-' || n, 'Fixture playlist ' || n, 'playlist', 'fixture' from generate_series(1, 100) n;
    insert into playlist_item (playlist_id, media_item_id, position) select 'playlist-' || ((n-1) % 100 + 1), 'track-' || n, n from generate_series(1, 20000) n;
  `)
  for (const { artistId, country, type, tags } of [
    {
      artistId: 'artist-1',
      country: 'Australia',
      type: 'Group',
      tags: ['Post Rock', 'Ambient'],
    },
    {
      artistId: 'artist-2',
      country: 'Canada',
      type: 'Person',
      tags: ['ambient'],
    },
    {
      artistId: 'artist-5000',
      country: 'Australia',
      type: 'Person',
      tags: ['Jazz'],
    },
  ]) {
    await database.insert(schema.artistProviderSnapshot).values({
      id: 'profile-' + artistId,
      artistId,
      provider: 'musicbrainz',
      normalizedData: { country, type, tags },
      payload: {},
    })
    await database.insert(schema.artistProviderCurrentState).values({
      artistId,
      provider: 'musicbrainz',
      latestSnapshotId: 'profile-' + artistId,
    })
  }
  for (const table of [
    'artist',
    'media_item',
    'album',
    'library_track',
    'media_credit',
    'playlist',
    'playlist_item',
  ])
    await pool.query('vacuum analyze ' + table)
}, 60000)

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.unstubAllGlobals()
})

it('loads page IDs before hydration and without waiting for a count', async () => {
  const { listArtistMetadataBrowsePage } =
    await import('@/services/artist-browse')
  logQuery.mockClear()
  const result = await listArtistMetadataBrowsePage(
    ArtistMetadataQuerySchema.parse({ size: 50 }),
  )
  expect(result.items).toHaveLength(50)
  expect(result.items[0]?.trackCount).toBe(4)
  expect(result.hasMore).toBe(true)
  expect(logQuery.mock.calls[0]?.[0]).toContain('select a.id')
  expect(logQuery.mock.calls[0]?.[0]).toContain('limit')
  expect(logQuery.mock.calls[0]?.[0]).not.toContain('count(')
  expect(result.items[0]?.providers).toHaveLength(4)
})

it('shares exact filters, ranges, counts and result caps across browse and metadata', async () => {
  const {
    listArtistBrowsePage,
    countArtistBrowse,
    listArtistMetadataBrowsePage,
  } = await import('@/services/artist-browse')
  const input = {
    filters: [
      { field: 'country', value: 'australia', mode: 'any' },
      { field: 'type', value: 'person', mode: 'any' },
      { field: 'genre', value: 'ambient', mode: 'required' },
      { field: 'name', value: 'fixture ARTIST 000002', mode: 'exclude' },
    ],
  }
  const query = ArtistQuerySchema.parse(input)
  expect(
    (await listArtistBrowsePage(query)).items.map((item) => item.id),
  ).toEqual(['artist-1'])
  expect(await countArtistBrowse(query)).toEqual({ totalCount: 1 })
  expect(
    (
      await listArtistMetadataBrowsePage(ArtistMetadataQuerySchema.parse(input))
    ).items.map((item) => item.id),
  ).toEqual(['artist-1'])
  expect(
    (
      await listArtistBrowsePage(
        ArtistQuerySchema.parse({
          ranges: [{ field: 'trackCount', min: 3.5, max: 4 }],
        }),
      )
    ).items.length,
  ).toBeGreaterThan(0)
  expect(
    await countArtistBrowse(
      ArtistQuerySchema.parse({ ranges: [{ field: 'albumCount', min: 2 }] }),
    ),
  ).toEqual({ totalCount: 0 })
  const capped = ArtistQuerySchema.parse({ limitResults: 51, size: 50 })
  expect((await listArtistBrowsePage(capped)).hasMore).toBe(true)
  expect(
    (await listArtistBrowsePage({ ...capped, page: 2 })).items,
  ).toHaveLength(1)
  expect((await listArtistBrowsePage({ ...capped, page: 3 })).items).toEqual([])
  expect(await countArtistBrowse(capped)).toEqual({ totalCount: 51 })
})

it('searches across fields and escapes substring wildcard characters', async () => {
  const { listArtistBrowsePage, countArtistBrowse } =
    await import('@/services/artist-browse')
  expect(
    (
      await listArtistBrowsePage(
        ArtistQuerySchema.parse({ q: '000001 ambient australia' }),
      )
    ).items.map((item) => item.id),
  ).toEqual(['artist-1'])
  expect(await countArtistBrowse(ArtistQuerySchema.parse({ q: '%' }))).toEqual({
    totalCount: 0,
  })
  expect(await countArtistBrowse(ArtistQuerySchema.parse({ q: '_' }))).toEqual({
    totalCount: 0,
  })
})

it('names providers in suggestions and finds them by display name or ID', async () => {
  const { listArtistBrowseFacets } = await import('@/services/artist-browse')
  const providerRows = async (q: string) =>
    (await listArtistBrowseFacets({ q, limitPerField: 25 })).filter(
      (row) => row.field === 'provider',
    )
  for (const q of ['MusicBrainz', 'musicbrainz'])
    expect(await providerRows(q)).toEqual([
      {
        field: 'provider',
        value: 'musicbrainz',
        label: 'Provider: MusicBrainz',
        count: 3,
      },
    ])
  await database.insert(schema.artistProviderSnapshot).values({
    id: 'profile-lastfm-artist-2',
    artistId: 'artist-2',
    provider: 'lastfm',
    normalizedData: {},
    payload: {},
  })
  await database.insert(schema.artistProviderCurrentState).values({
    artistId: 'artist-2',
    provider: 'lastfm',
    latestSnapshotId: 'profile-lastfm-artist-2',
  })
  try {
    // "last.fm" is only in the display name; the filter value is the ID.
    expect(await providerRows('last.fm')).toEqual([
      {
        field: 'provider',
        value: 'lastfm',
        label: 'Provider: Last.fm',
        count: 1,
      },
    ])
  } finally {
    await pool.query(
      "delete from artist_provider_current_state where artist_id = 'artist-2' and provider = 'lastfm'",
    )
    await pool.query(
      "delete from artist_provider_snapshot where id = 'profile-lastfm-artist-2'",
    )
  }
})

it('offers whole-library facets and playlist filters beyond the loaded page', async () => {
  const { listArtistBrowseFacets, listArtistBrowsePage, countArtistBrowse } =
    await import('@/services/artist-browse')
  const facets = await listArtistBrowseFacets({
    q: '005000',
    limitPerField: 25,
  })
  expect(facets).toContainEqual({
    field: 'name',
    value: 'Fixture artist 005000',
    label: 'Artist: Fixture artist 005000',
    count: 1,
  })
  const tags = await listArtistBrowseFacets({ q: 'ambient', limitPerField: 25 })
  expect(
    tags.find(
      (tag) => tag.field === 'genre' && tag.value.toLowerCase() === 'ambient',
    )?.count,
  ).toBe(2)
  const query = ArtistQuerySchema.parse({
    filters: [
      { field: 'playlist', value: 'fixture PLAYLIST 100', mode: 'required' },
    ],
    size: 1,
    sortBy: 'playlistCount',
  })
  expect(await countArtistBrowse(query)).toEqual({ totalCount: 50 })
  expect((await listArtistBrowsePage(query)).items[0]?.playlistCount).toBe(1)
  expect(
    (await listArtistBrowsePage({ ...query, page: 50 })).items,
  ).toHaveLength(1)
  expect(
    (await listArtistBrowsePage({ ...query, page: 51 })).items,
  ).toHaveLength(0)
})

it('sorts every advertised field and keeps missing profile values last', async () => {
  const { listArtistBrowsePage } = await import('@/services/artist-browse')
  const { artistBrowseFields } = await import('@repo/schemas/artist-browse')
  for (const field of artistBrowseFields) {
    const result = await listArtistBrowsePage(
      ArtistQuerySchema.parse({
        sortBy: field.key,
        size: 2,
        direction: 'desc',
      }),
    )
    expect(result.items).toHaveLength(2)
  }
  const result = await listArtistBrowsePage(
    ArtistQuerySchema.parse({ sortBy: 'country', size: 1, direction: 'desc' }),
  )
  expect(result.items[0]?.id).toBe('artist-2')
})
