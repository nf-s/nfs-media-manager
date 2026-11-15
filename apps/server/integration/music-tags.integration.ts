import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `music_tags_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database, statement_timeout: 10000 })
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const databaseClient = drizzle(pool, { schema, logger: { logQuery } })
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in music tag tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient
    .insert(schema.artist)
    .values({ id: 'fixture-artist', name: 'Fixture Artist' })
  await databaseClient.insert(schema.artistProviderSnapshot).values({
    id: 'fixture-profile',
    artistId: 'fixture-artist',
    provider: 'lastfm',
    payload: {},
    normalizedData: { tags: ['Ambient', 'Jazz', 'ambient'] },
  })
  await databaseClient.insert(schema.artistProviderCurrentState).values({
    artistId: 'fixture-artist',
    provider: 'lastfm',
    latestSnapshotId: 'fixture-profile',
  })
  for (const count of [0, 1, 2]) {
    const id = `fixture-album-${count}`
    const trackId = `fixture-track-${count}`
    await databaseClient.insert(schema.mediaItem).values([
      { id, slug: id, title: id, mediaType: 'album' },
      { id: trackId, slug: trackId, title: trackId, mediaType: 'track' },
    ])
    await databaseClient.insert(schema.album).values({ mediaItemId: id })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: trackId, albumMediaItemId: id })
    await databaseClient.insert(schema.mediaCredit).values([
      { mediaItemId: id, artistId: 'fixture-artist', role: 'artist' },
      { mediaItemId: trackId, artistId: 'fixture-artist', role: 'artist' },
    ])
  }
  await databaseClient.insert(schema.tag).values([
    { id: 'jazz', name: 'Jazz', mediaType: 'album' },
    { id: 'soul', name: 'Soul', mediaType: 'album' },
  ])
  await databaseClient.insert(schema.mediaItemTag).values([
    { mediaItemId: 'fixture-album-1', tagId: 'jazz' },
    { mediaItemId: 'fixture-album-2', tagId: 'jazz' },
    { mediaItemId: 'fixture-album-2', tagId: 'soul' },
  ])
  await databaseClient.insert(schema.mediaItem).values({
    id: 'fixture-unlinked',
    slug: 'fixture-unlinked',
    title: 'Unlinked fixture',
    mediaType: 'track',
  })
  await databaseClient
    .insert(schema.libraryTrack)
    .values({ mediaItemId: 'fixture-unlinked' })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('artist tag projections', () => {
  it('uses the same sparse-release rule for album and track filtering', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    for (const mediaType of ['album', 'track']) {
      const querySchema =
        mediaType === 'album' ? AlbumQuerySchema : TrackQuerySchema
      const query = (field: string, mode = 'required') =>
        querySchema.parse({
          filters: JSON.stringify([{ field, value: 'Ambient', mode }]),
        })
      const type = mediaType === 'album' ? 'album' : 'track'
      expect((await queryBrowseIds(type, query('genre'))).ids.sort()).toEqual([
        `fixture-${type}-0`,
        `fixture-${type}-1`,
      ])
      expect(
        (await queryBrowseIds(type, query('genre', 'exclude'))).ids.sort(),
      ).toEqual(
        type === 'album'
          ? ['fixture-album-2']
          : ['fixture-track-2', 'fixture-unlinked'],
      )
      expect((await queryBrowseIds(type, query('artistTag'))).totalCount).toBe(
        3,
      )
      expect((await queryBrowseIds(type, query('albumTag'))).totalCount).toBe(0)
    }
  })

  it('retains unlinked tracks when excluding a release tag', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    for (const field of ['genre', 'albumTag']) {
      const result = await queryBrowseIds(
        'track',
        TrackQuerySchema.parse({
          filters: JSON.stringify([{ field, value: 'Jazz', mode: 'exclude' }]),
        }),
      )
      expect(result.ids).toContain('fixture-unlinked')
    }
  })

  it('exposes fallback tags in search and facets without changing album membership', async () => {
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    const { loadArtistTags } = await import('@/services/music-tags')
    expect(
      (await queryBrowseIds('track', TrackQuerySchema.parse({ q: 'Ambient' })))
        .totalCount,
    ).toBe(3)
    const facets = await listBrowseFacets('album', { q: 'Ambient' })
    expect(facets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'genre', value: 'ambient', count: 2 }),
        expect.objectContaining({
          field: 'artistTag',
          value: 'ambient',
          count: 3,
        }),
      ]),
    )
    expect(
      (await loadArtistTags(['fixture-album-0']))
        .get('fixture-album-0')
        ?.map((name) => name.toLowerCase()),
    ).toEqual(['ambient', 'jazz'])
    expect(
      await databaseClient.select().from(schema.mediaItemTag),
    ).toHaveLength(3)
  })

  it('projects album aliases and hidden groups without changing artist evidence or film tag groups', async () => {
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    const { loadArtistTags } = await import('@/services/music-tags')
    const { mergeTags, setTagVisibility } = await import('@/services/tags')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'fixture-film',
      slug: 'fixture-film',
      title: 'Fixture feature',
      mediaType: 'film',
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: 'fixture-film' })
    await databaseClient.insert(schema.tag).values([
      { id: 'ambient-album', name: 'Ambient', mediaType: 'album' },
      { id: 'drone-album', name: 'Drone', mediaType: 'album' },
      { id: 'ambient-film', name: 'Ambient', mediaType: 'film' },
    ])
    await databaseClient.insert(schema.tagIdentity).values({
      mediaType: 'album',
      normalizedName: 'ambient',
      kind: 'general',
      tagId: 'ambient-album',
    })
    await databaseClient
      .insert(schema.mediaItemTag)
      .values({ mediaItemId: 'fixture-film', tagId: 'ambient-film' })
    const memberships = await databaseClient.select().from(schema.mediaItemTag)
    await mergeTags(
      {
        mediaType: 'album',
        sourceIds: ['ambient-album'],
        targetId: 'drone-album',
      },
      null,
    )

    const mediaIds = ['fixture-album-0', 'fixture-track-1']
    expect(await loadArtistTags(mediaIds)).toEqual(
      new Map(mediaIds.map((id) => [id, ['Drone', 'Jazz']])),
    )
    expect(await listBrowseFacets('album', { q: 'Drone' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'genre', value: 'drone', count: 2 }),
        expect.objectContaining({
          field: 'artistTag',
          value: 'drone',
          count: 3,
        }),
      ]),
    )
    expect(
      (await queryBrowseIds('track', TrackQuerySchema.parse({ q: 'Drone' })))
        .totalCount,
    ).toBe(3)
    expect(
      (await queryBrowseIds('track', TrackQuerySchema.parse({ q: 'Ambient' })))
        .totalCount,
    ).toBe(0)
    expect(
      (await queryBrowseIds('film', FilmQuerySchema.parse({ q: 'Ambient' })))
        .ids,
    ).toEqual(['fixture-film'])

    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['drone-album'],
      hidden: true,
    })
    expect(await loadArtistTags(mediaIds)).toEqual(
      new Map(mediaIds.map((id) => [id, ['Jazz']])),
    )
    expect(await listBrowseFacets('album', { q: 'Drone' })).toEqual([])
    expect(
      (await queryBrowseIds('track', TrackQuerySchema.parse({ q: 'Drone' })))
        .totalCount,
    ).toBe(0)
    for (const value of ['Ambient', 'Drone']) {
      for (const field of ['genre', 'artistTag']) {
        const filters = JSON.stringify([{ field, value, mode: 'required' }])
        expect(
          (await queryBrowseIds('album', AlbumQuerySchema.parse({ filters })))
            .totalCount,
        ).toBe(field === 'genre' ? 2 : 3)
      }
    }
    expect(await listBrowseFacets('film', { q: 'Ambient' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'genre', value: 'ambient', count: 1 }),
      ]),
    )
    expect(await databaseClient.select().from(schema.mediaItemTag)).toEqual(
      memberships,
    )
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toMatchObject([
      { normalizedData: { tags: ['Ambient', 'Jazz', 'ambient'] } },
    ])
  })

  it('expands profiles by provider state before joining thousands of media credits', async () => {
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    await pool.query(`
      insert into artist (id, name) values
        ('fixture-profiled', 'Fixture Profiled Artist'), ('fixture-uncatalogued', 'Fixture Uncatalogued Artist');
      insert into artist_provider_snapshot (id, artist_id, provider, normalized_data, payload)
        values ('fixture-perf-profile', 'fixture-profiled', 'lastfm', '{"tags":["Spectralneedle"]}', '{}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
        values ('fixture-profiled', 'lastfm', 'fixture-perf-profile');
      insert into media_item (id, slug, media_type, title)
        select 'performance-track-' || n, 'performance-track-' || n, 'track', 'Fixture song ' || n
        from generate_series(1, 4000) n;
      insert into library_track (media_item_id)
        select 'performance-track-' || n from generate_series(1, 4000) n;
      insert into media_credit (media_item_id, artist_id, role)
        select 'performance-track-' || n,
          case when n <= 1000 then 'fixture-profiled' else 'fixture-uncatalogued' end, 'artist'
        from generate_series(1, 4000) n;
    `)
    await pool.query(
      'analyze media_item; analyze library_track; analyze media_credit; analyze artist_provider_current_state; analyze artist_provider_snapshot',
    )
    logQuery.mockClear()
    const result = await queryBrowseIds(
      'track',
      TrackQuerySchema.parse({ q: 'Spectralneedle', size: 2 }),
    )
    expect(result).toMatchObject({
      totalCount: 1000,
      ids: expect.arrayContaining([
        expect.stringContaining('performance-track-'),
      ]),
    })
    const search = logQuery.mock.calls.find(([query]) =>
      query.includes('searchable_values'),
    )
    expect(await listBrowseFacets('track', { q: 'Spectralneedle' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'genre',
          value: 'spectralneedle',
          count: 1000,
        }),
        expect.objectContaining({
          field: 'artistTag',
          value: 'spectralneedle',
          count: 1000,
        }),
      ]),
    )
    const facets = logQuery.mock.calls.find(([query]) =>
      query.includes('values_for_field'),
    )
    const ExplainRows = z.array(z.object({ 'QUERY PLAN': z.string() }))
    for (const call of [search, facets]) {
      if (!call) throw new Error('Expected a browse query to explain')
      const [query, params] = call
      const plan = ExplainRows.parse(
        (await pool.query(`explain (analyze, format text) ${query}`, params))
          .rows,
      )
      const providerScans = plan
        .map((row) => row['QUERY PLAN'])
        .filter((row) =>
          row.includes(
            'Function Scan on jsonb_array_elements_text provider_tag',
          ),
        )
      expect(providerScans).toHaveLength(2)
      for (const scan of providerScans)
        expect(Number(/loops=(\d+)/.exec(scan)?.[1]), scan).toBeLessThanOrEqual(
          2,
        )
    }
  })
})
