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
    normalizedData: {
      tags: ['Ambient', 'Jazz', 'ambient'],
      tagReleaseSupport: [
        { name: 'Ambient', matchingReleases: 2, taggedReleases: 7 },
      ],
    },
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

  it('orders albums by the first alphabetized tag and keeps stable ties', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const result = await queryBrowseIds(
      'album',
      AlbumQuerySchema.parse({ sortBy: 'genre', direction: 'desc' }),
    )
    expect(result.ids).toEqual([
      'fixture-album-2',
      'fixture-album-0',
      'fixture-album-1',
    ])
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

  it('attributes visible album and track tags to the evidence used in each display', async () => {
    const { getItemTagProvenance } =
      await import('@/services/item-tag-provenance')
    const { ItemTagProvenanceQuerySchema, ItemTagProvenancePageSchema } =
      await import('@repo/schemas/tags')
    const query = (
      resourceType: 'album' | 'track' | 'artist',
      resourceId: string,
      name: string,
    ) => ItemTagProvenanceQuerySchema.parse({ resourceType, resourceId, name })
    const artistSource = {
      provider: 'lastfm',
      providerLabel: 'Last.fm',
      originType: 'artist',
      originId: 'fixture-artist',
      originTitle: 'Fixture Artist',
      snapshotId: 'fixture-profile',
    }
    expect(
      ItemTagProvenancePageSchema.parse(
        await getItemTagProvenance(query('artist', 'fixture-artist', 'Jazz')),
      ),
    ).toMatchObject({
      reason: 'direct',
      items: [artistSource],
    })
    for (const request of [
      query('album', 'fixture-album-0', 'Jazz'),
      query('track', 'fixture-track-0', 'Jazz'),
    ]) {
      expect(await getItemTagProvenance(request)).toMatchObject({
        reason: 'artist-fallback',
        items: [artistSource],
      })
    }
    expect(
      await getItemTagProvenance(query('album', 'fixture-album-1', 'Jazz')),
    ).toMatchObject({
      originType: 'album',
      reason: 'direct',
      items: [],
      totalCount: 0,
    })
    expect(
      await getItemTagProvenance(query('track', 'fixture-track-1', 'Jazz')),
    ).toMatchObject({
      originType: 'album',
      reason: 'linked-album',
      linkedAlbum: { id: 'fixture-album-1', title: 'fixture-album-1' },
      items: [],
      totalCount: 0,
    })
    await expect(
      getItemTagProvenance(query('track', 'fixture-track-2', 'Ambient')),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      getItemTagProvenance(query('track', 'fixture-unlinked', 'Jazz')),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      getItemTagProvenance(query('track', 'fixture-album-0', 'Jazz')),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('projects album aliases and hidden groups without changing artist evidence or film tag groups', async () => {
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    const { loadArtistTags } = await import('@/services/music-tags')
    const { getItemTagProvenance } =
      await import('@/services/item-tag-provenance')
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

    const alias = {
      resourceType: 'track',
      resourceId: 'fixture-track-1',
      name: 'Drone',
      page: 1,
      size: 1,
    } satisfies Parameters<typeof getItemTagProvenance>[0]
    expect(await getItemTagProvenance(alias)).toMatchObject({
      reason: 'artist-fallback',
      items: [
        {
          rawName: 'Ambient',
          snapshotId: 'fixture-profile',
          releaseSupport: { matchingReleases: 2, taggedReleases: 7 },
        },
      ],
    })

    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['drone-album'],
      hidden: true,
    })
    expect(await loadArtistTags(mediaIds)).toEqual(
      new Map(mediaIds.map((id) => [id, ['Jazz']])),
    )
    await expect(getItemTagProvenance(alias)).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
    expect(
      await getItemTagProvenance({
        ...alias,
        resourceType: 'artist',
        resourceId: 'fixture-artist',
        name: 'Ambient',
      }),
    ).toMatchObject({ reason: 'direct' })
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
    const facets = logQuery.mock.calls.find(
      ([query]) =>
        query.includes('values_for_field') &&
        query.includes('browse_artist_facet_keys as materialized'),
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
      expect(providerScans).toHaveLength(1)
      for (const scan of providerScans)
        expect(Number(/loops=(\d+)/.exec(scan)?.[1]), scan).toBeLessThanOrEqual(
          2,
        )
    }
  })

  it('reads exact shared tag counts from the durable Track vocabulary until source data commits', async () => {
    const { listBrowseFacets } = await import('@/services/browse')
    await pool.query(`
      insert into tag (id, media_type, name) values
        ('facet-parent', 'album', 'Fixture parent'), ('facet-child', 'album', 'Fixture child');
      insert into tag_ancestor (media_type, descendant_key, ancestor_key)
        values ('album', 'fixture child', 'fixture parent');
      insert into media_item (id, slug, media_type, title)
        values ('vocabulary-album', 'vocabulary-album', 'album', 'Fixture release'),
          ('vocabulary-track-1', 'vocabulary-track-1', 'track', 'Fixture recording one'),
          ('vocabulary-track-2', 'vocabulary-track-2', 'track', 'Fixture recording two');
      insert into album (media_item_id) values ('vocabulary-album');
      insert into library_track (media_item_id, album_media_item_id) values
        ('vocabulary-track-1', 'vocabulary-album'), ('vocabulary-track-2', 'vocabulary-album');
      insert into media_item_tag (media_item_id, tag_id) values ('vocabulary-album', 'facet-child');
      insert into artist (id, name) values
        ('vocabulary-artist-1', 'Fixture contributor one'), ('vocabulary-artist-2', 'Fixture contributor two');
      insert into media_credit (media_item_id, artist_id, role) values
        ('vocabulary-track-1', 'vocabulary-artist-1', 'artist'),
        ('vocabulary-track-1', 'vocabulary-artist-2', 'artist'),
        ('vocabulary-track-2', 'vocabulary-artist-1', 'artist');
      insert into artist_provider_snapshot (id, artist_id, provider, normalized_data, payload) values
        ('vocabulary-profile-1', 'vocabulary-artist-1', 'lastfm', '{"tags":["Fixture child","fixture child"]}', '{}'),
        ('vocabulary-profile-2', 'vocabulary-artist-2', 'lastfm', '{"tags":["Fixture child"]}', '{}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id) values
        ('vocabulary-artist-1', 'lastfm', 'vocabulary-profile-1'),
        ('vocabulary-artist-2', 'lastfm', 'vocabulary-profile-2');
      insert into playlist (id, name, kind, source) values
        ('vocabulary-playlist-1', 'Vocabulary playlist one', 'playlist', 'spotify'),
        ('vocabulary-playlist-2', 'Vocabulary playlist two', 'playlist', 'spotify');
      insert into playlist_item (playlist_id, media_item_id) values
        ('vocabulary-playlist-1', 'vocabulary-track-2'),
        ('vocabulary-playlist-2', 'vocabulary-track-2');
    `)
    const parentCounts = async (q: string) =>
      (await listBrowseFacets('track', { q }))
        .filter(({ value }) => value === 'fixture parent')
        .map(({ field, count, subtags }) => [field, count, subtags])
    const rolledUp = (total: number) => [
      ['albumTag', total, 1],
      ['artistTag', total, 1],
      ['genre', total, 1],
    ]
    expect(await parentCounts('')).toEqual(rolledUp(2))
    logQuery.mockClear()
    expect(await parentCounts('parent')).toEqual(rolledUp(2))
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('ready_track_facet_vocabulary'),
      ),
    ).toBe(true)
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('browse_artist_facet_keys'),
      ),
    ).toBe(false)

    const writer = await pool.connect()
    try {
      await writer.query('begin')
      await writer.query(`update media_item set metadata = '{"legacyHidden":true}'
        where id = 'vocabulary-track-1'`)
      expect(await parentCounts('fixture parent')).toEqual(rolledUp(2))
      await writer.query('rollback')
      expect(await parentCounts('parent')).toEqual(rolledUp(2))
      expect(
        (await pool.query('select 1 from track_facet_dirty')).rowCount,
      ).toBe(0)

      await writer.query(`update media_item set metadata = '{"legacyHidden":true}'
        where id = 'vocabulary-track-1';
        update track_facet_state set retry_after = 'infinity'`)
      expect(
        (await pool.query('select 1 from track_facet_dirty')).rowCount,
      ).toBe(1)
      expect(await parentCounts('fixture parent')).toEqual(rolledUp(1))
    } finally {
      await writer.query('rollback')
      writer.release()
    }
    logQuery.mockClear()
    expect(await parentCounts('p')).toEqual(rolledUp(1))
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('insert into track_facet_value'),
      ),
    ).toBe(false)
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('browse_artist_facet_keys'),
      ),
    ).toBe(true)
    expect((await pool.query('select 1 from track_facet_dirty')).rowCount).toBe(
      1,
    )
    await pool.query("update track_facet_state set retry_after = '-infinity'")
    expect(await parentCounts('fi')).toEqual(rolledUp(1))
    expect((await pool.query('select 1 from track_facet_dirty')).rowCount).toBe(
      0,
    )

    expect(await listBrowseFacets('track', { q: 'Source' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'source',
          value: 'Spotify playlists',
          count: 1,
        }),
      ]),
    )
    await pool.query(`
      update media_item set title = 'Renamed release' where id = 'vocabulary-album';
      update artist set name = 'Renamed contributor' where id = 'vocabulary-artist-1';
      update playlist set name = 'Renamed playlist', source = 'spotify-liked'
        where id = 'vocabulary-playlist-1';
    `)
    await pool.query("update track_facet_state set retry_after = '-infinity'")
    await listBrowseFacets('track', { q: '' })
    expect(await listBrowseFacets('track', { q: 'renamed' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'album',
          value: 'Renamed release',
          count: 1,
        }),
        expect.objectContaining({
          field: 'artist',
          value: 'Renamed contributor',
          count: 1,
        }),
        expect.objectContaining({
          field: 'playlist',
          value: 'Renamed playlist',
          count: 1,
        }),
      ]),
    )
    expect(await listBrowseFacets('track', { q: 'Source' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'source',
          value: 'Spotify playlists',
          count: 1,
        }),
        expect.objectContaining({
          field: 'source',
          value: 'Liked Songs',
          count: 1,
        }),
      ]),
    )
  })

  it('publishes a facet snapshot without waiting for a concurrent source writer', async () => {
    const { listBrowseFacets, refreshTrackFacetVocabularyForMaintenance } =
      await import('@/services/browse')
    const setTitle = (title: string) =>
      pool.query('update media_item set title = $1 where id = $2', [
        title,
        'fixture-track-0',
      ])
    const allowRefresh = () =>
      pool.query("update track_facet_state set retry_after = '-infinity'")
    const storedTitle = `select value from track_facet_value
      where field = 'title' and value like '% concurrency fixture'`
    await pool.query('delete from track_facet_state')
    await setTitle('Initial concurrency fixture')
    await listBrowseFacets('track', {})
    expect((await pool.query(storedTitle)).rows).toEqual([
      { value: 'Initial concurrency fixture' },
    ])

    const oldReader = await pool.connect()
    const publishLock = await pool.connect()
    try {
      await oldReader.query('begin isolation level repeatable read')
      expect((await oldReader.query(storedTitle)).rows).toEqual([
        { value: 'Initial concurrency fixture' },
      ])
      await setTitle('Snapshot concurrency fixture')
      await allowRefresh()
      await pool.query(`
        create function fixture_pause_facet_publication() returns trigger language plpgsql as $$
        begin
          while not pg_try_advisory_xact_lock(381026194) loop
            perform pg_sleep(0.005);
          end loop;
          return null;
        end;
        $$;
        create trigger fixture_pause_facet_publication before insert on track_facet_value
          for each statement execute function fixture_pause_facet_publication();
      `)
      await publishLock.query('select pg_advisory_lock(381026194)')
      logQuery.mockClear()
      const rebuild = refreshTrackFacetVocabularyForMaintenance()
      try {
        await vi.waitFor(() =>
          expect(
            logQuery.mock.calls.some(([statement]) =>
              statement.includes('insert into track_facet_value'),
            ),
          ).toBe(true),
        )
        // This commits before the paused builder resumes.
        await setTitle('Writer concurrency fixture')
      } finally {
        await publishLock.query('select pg_advisory_unlock(381026194)')
      }
      expect(await rebuild).toBe(true)
      expect((await oldReader.query(storedTitle)).rows).toEqual([
        { value: 'Initial concurrency fixture' },
      ])
      expect((await pool.query(storedTitle)).rows).toEqual([
        { value: 'Snapshot concurrency fixture' },
      ])
      expect(
        (await pool.query('select 1 from track_facet_dirty')).rowCount,
      ).toBe(1)
      expect(
        await listBrowseFacets('track', { q: 'Writer concurrency' }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'title',
            value: 'Writer concurrency fixture',
          }),
        ]),
      )
    } finally {
      await oldReader.query('rollback')
      await pool.query(`
        drop trigger if exists fixture_pause_facet_publication on track_facet_value;
        drop function if exists fixture_pause_facet_publication();
      `)
      publishLock.release()
      oldReader.release()
    }

    await allowRefresh()
    await pool.query(`
      create function fixture_cancel_facet_publication() returns trigger language plpgsql as $$
      begin
        raise exception 'Fixture statement canceled' using errcode = '57014';
      end;
      $$;
      create trigger fixture_cancel_facet_publication before insert on track_facet_value
        for each statement execute function fixture_cancel_facet_publication();
    `)
    try {
      expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(false)
      expect(
        (await pool.query('select 1 from track_facet_dirty')).rowCount,
      ).toBe(1)
      expect((await pool.query(storedTitle)).rows).toEqual([
        { value: 'Snapshot concurrency fixture' },
      ])
    } finally {
      await pool.query(`
        drop trigger fixture_cancel_facet_publication on track_facet_value;
        drop function fixture_cancel_facet_publication();
      `)
    }
    await allowRefresh()
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
    expect((await pool.query('select 1 from track_facet_dirty')).rowCount).toBe(
      0,
    )
    expect((await pool.query(storedTitle)).rows).toEqual([
      { value: 'Writer concurrency fixture' },
    ])
  })

  it('hands a slow vocabulary rebuild to maintenance and keeps foreground reads live', async () => {
    const { listBrowseFacets, refreshTrackFacetVocabularyForMaintenance } =
      await import('@/services/browse')
    await pool.query(`
      delete from track_facet_state;
      update media_item set title = 'Delayed fixture track' where id = 'fixture-track-0';
      create function fixture_delay_facet_refresh() returns trigger language plpgsql as $$
      begin
        perform pg_sleep(5.1);
        return null;
      end;
      $$;
      create trigger fixture_delay_facet_refresh after insert on track_facet_value
        for each statement execute function fixture_delay_facet_refresh();
    `)
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(false)
    const titles = async (q: string) =>
      (await listBrowseFacets('track', { q }))
        .filter(({ field }) => field === 'title')
        .map(({ value }) => value)

    try {
      expect(await titles('de')).toContain('Delayed fixture track')
      expect(
        (
          await pool.query(
            'select ready, maintenance_only from track_facet_state',
          )
        ).rows,
      ).toEqual([{ ready: false, maintenance_only: true }])
      logQuery.mockClear()
      expect(await titles('d')).toContain('Delayed fixture track')
      expect(
        logQuery.mock.calls.some(([query]) =>
          query.includes('insert into track_facet_value'),
        ),
      ).toBe(false)

      // An attempted vocabulary from before the migration learns the same policy.
      await pool.query('update track_facet_state set maintenance_only = false')
      expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
      expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(false)
      expect(
        (
          await pool.query(
            'select ready, maintenance_only from track_facet_state',
          )
        ).rows,
      ).toEqual([{ ready: true, maintenance_only: true }])
    } finally {
      await pool.query(
        'drop trigger fixture_delay_facet_refresh on track_facet_value',
      )
    }

    await pool.query(`
      update media_item set title = 'Finished fixture track' where id = 'fixture-track-0';
      update track_facet_state set retry_after = '-infinity';
    `)
    logQuery.mockClear()
    expect(await titles('fi')).toContain('Finished fixture track')
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('insert into track_facet_value'),
      ),
    ).toBe(false)
    const builder = await pool.connect()
    try {
      await builder.query('begin')
      await builder.query(`select pg_advisory_xact_lock(
        hashtextextended(current_schema() || ':track_facet_vocabulary', 0))`)
      expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(false)
    } finally {
      await builder.query('rollback')
      builder.release()
    }
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(false)
    await pool.query("update track_facet_state set retry_after = '-infinity'")
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
    logQuery.mockClear()
    expect(await titles('finished')).toContain('Finished fixture track')
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('ready_track_facet_vocabulary'),
      ),
    ).toBe(true)
    expect(
      logQuery.mock.calls.some(([query]) =>
        query.includes('browse_artist_facet_keys'),
      ),
    ).toBe(false)

    await pool.query(`
      update media_item set title = 'Rolling fixture track' where id = 'fixture-track-0';
      alter table track_facet_state rename column maintenance_only to fixture_missing_column;
    `)
    try {
      expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(false)
      expect(await titles('ro')).toContain('Rolling fixture track')
    } finally {
      await pool.query(`alter table track_facet_state
        rename column fixture_missing_column to maintenance_only`)
    }
  })

  it('paginates current evidence from every credited artist on a track without an album', async () => {
    const { getItemTagProvenance } =
      await import('@/services/item-tag-provenance')
    await databaseClient.insert(schema.artist).values({
      id: 'fixture-guest',
      name: 'Fixture Guest',
    })
    await databaseClient.insert(schema.mediaCredit).values([
      {
        mediaItemId: 'fixture-unlinked',
        artistId: 'fixture-artist',
        role: 'artist',
      },
      {
        mediaItemId: 'fixture-unlinked',
        artistId: 'fixture-guest',
        role: 'artist',
      },
    ])
    await databaseClient.insert(schema.artistProviderSnapshot).values([
      {
        id: 'fixture-guest-old',
        artistId: 'fixture-guest',
        provider: 'musicbrainz',
        payload: {},
        normalizedData: { tags: ['Soul'] },
      },
      {
        id: 'fixture-guest-current',
        artistId: 'fixture-guest',
        provider: 'musicbrainz',
        payload: {},
        normalizedData: {
          tags: ['Jazz'],
          url: 'https://example.com/fixture-guest',
        },
      },
      {
        id: 'fixture-second-provider',
        artistId: 'fixture-artist',
        provider: 'spotify',
        payload: {},
        normalizedData: { tags: ['Jazz'] },
      },
    ])
    await databaseClient.insert(schema.artistProviderCurrentState).values([
      {
        artistId: 'fixture-guest',
        provider: 'musicbrainz',
        latestSnapshotId: 'fixture-guest-current',
      },
      {
        artistId: 'fixture-artist',
        provider: 'spotify',
        latestSnapshotId: 'fixture-second-provider',
      },
    ])
    const query = {
      resourceType: 'track',
      resourceId: 'fixture-unlinked',
      name: 'Jazz',
      page: 1,
      size: 1,
    } satisfies Parameters<typeof getItemTagProvenance>[0]
    expect(await getItemTagProvenance(query)).toMatchObject({
      reason: 'artist-fallback',
      totalCount: 3,
      items: [{ provider: 'lastfm', originId: 'fixture-artist' }],
    })
    expect(await getItemTagProvenance({ ...query, page: 2 })).toMatchObject({
      totalCount: 3,
      items: [
        {
          provider: 'musicbrainz',
          originId: 'fixture-guest',
          snapshotId: 'fixture-guest-current',
          linkKind: 'item',
          link: { url: 'https://example.com/fixture-guest' },
        },
      ],
    })
    expect(
      await getItemTagProvenance({
        ...query,
        resourceType: 'artist',
        resourceId: 'fixture-artist',
        size: 25,
      }),
    ).toMatchObject({
      reason: 'direct',
      totalCount: 2,
      items: [{ provider: 'lastfm' }, { provider: 'spotify' }],
    })
    await expect(
      getItemTagProvenance({ ...query, name: 'Soul' }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })
})
