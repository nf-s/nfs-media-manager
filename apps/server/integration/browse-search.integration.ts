import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `browse_search_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const capturedQueries: Array<{ query: string; params: unknown[] }> = []
const databaseClient = drizzle(pool, {
  schema,
  logger: {
    logQuery: (query, params) => capturedQueries.push({ query, params }),
  },
})
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
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await pool.query(`
    insert into media_item (id, slug, title, media_type)
    select 'album-' || n, 'album-' || n, 'Synthetic album ' || n, 'album'
    from generate_series(1, 1000) n;
    insert into album (media_item_id) select id from media_item;
    insert into media_item (id, slug, title, media_type)
    select 'song-' || n, 'song-' || n,
      case when n = 20000 then 'Distinctive needle song' else 'Synthetic song ' || n end,
      'track' from generate_series(1, 20000) n;
    insert into library_track (media_item_id, album_media_item_id, spotify_track_id, date_added)
    select 'song-' || n, 'album-' || ((n - 1) / 20 + 1), lpad(n::text, 22, '0'),
      case when n % 10 = 0 then null else timestamp '2020-01-01' + (n % 31) * interval '1 day' end
    from generate_series(1, 20000) n;
    insert into track (id, album_media_item_id, track_media_item_id, title, position, external_id)
    select mi.id, lt.album_media_item_id, mi.id, mi.title,
      (substring(mi.id from 6)::int - 1) % 20 + 1,
      lpad(substring(mi.id from 6), 22, '0')
    from media_item mi join library_track lt on lt.media_item_id = mi.id;
    insert into artist (id, name, sort_name) values ('artist', 'Synthetic Performer', 'Synthetic Performer');
    insert into media_credit (media_item_id, artist_id, role)
    select media_item_id, 'artist', 'artist' from library_track;
    analyze media_item; analyze library_track; analyze track; analyze media_credit; analyze artist;
  `)
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

it('reads album positions only for matching rows in a selective track search', async () => {
  const { queryBrowseIds, listBrowseFacets } = await import('@/services/browse')
  capturedQueries.length = 0
  expect(
    await queryBrowseIds(
      'track',
      TrackQuerySchema.parse({ q: 'needle', sortBy: 'title' }),
    ),
  ).toMatchObject({ ids: ['song-20000'], totalCount: 1 })
  expect(await listBrowseFacets('track', { q: 'needle' })).toEqual([
    expect.objectContaining({
      field: 'title',
      value: 'Distinctive needle song',
      count: 1,
    }),
  ])
  const queries = capturedQueries.filter(
    ({ query }) => !query.includes('pg_current_snapshot'),
  )
  expect(queries).toHaveLength(3)
  for (const { query, params } of queries) {
    const result = await pool.query(
      `explain (analyze, format json) ${query}`,
      params,
    )
    const plans = PlanRowsSchema.parse(result.rows)
    const trackReads = plans
      .flatMap((row) =>
        row['QUERY PLAN'].flatMap((plan) => flattenPlan(plan.Plan)),
      )
      .filter((plan) => plan['Relation Name'] === 'track')
    expect(
      trackReads.reduce((sum, plan) => sum + plan['Actual Loops'], 0),
    ).toBeLessThanOrEqual(1)
    expect(
      trackReads.reduce(
        (sum, plan) => sum + plan['Actual Loops'] * plan['Actual Rows'],
        0,
      ),
    ).toBeLessThanOrEqual(1)
  }
})

type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Loops': number
  'Actual Rows': number
  Plans?: PlanNode[]
}
const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    'Node Type': z.string(),
    'Relation Name': z.string().optional(),
    'Index Name': z.string().optional(),
    'Actual Loops': z.number(),
    'Actual Rows': z.number(),
    Plans: z.array(PlanNodeSchema).optional(),
  }),
)
const PlanRowsSchema = z.array(
  z.object({
    'QUERY PLAN': z.array(z.object({ Plan: PlanNodeSchema })),
  }),
)
function flattenPlan(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flattenPlan)]
}

it('counts the same filtered, capped browse set without blocking any row-only page', async () => {
  const { queryBrowseCount, queryBrowseIds, queryBrowsePageIds } =
    await import('@/services/browse')
  const filters = JSON.stringify([
    { field: 'source', value: 'Album track list', mode: 'required' },
  ])
  const query = TrackQuerySchema.parse({ filters, size: 2, limitResults: 3 })

  capturedQueries.length = 0
  const first = await queryBrowsePageIds('track', query)
  expect(first.ids).toHaveLength(2)
  expect(first.hasMore).toBe(true)
  expect(capturedQueries).toHaveLength(1)
  expect(capturedQueries[0]?.query).toMatch(/^select "media_item"."id"/)

  const second = await queryBrowsePageIds('track', { ...query, page: 2 })
  expect(second.ids).toHaveLength(1)
  expect(second.hasMore).toBe(false)
  expect(first.ids).not.toContain(second.ids[0])
  expect(
    await queryBrowsePageIds('track', { ...query, page: 3 }),
  ).toMatchObject({
    ids: [],
    hasMore: false,
  })

  capturedQueries.length = 0
  expect(await queryBrowseCount('track', { ...query, page: 3 })).toEqual({
    totalCount: 3,
  })
  expect(
    capturedQueries.filter(
      ({ query }) => !query.includes('pg_current_snapshot'),
    ),
  ).toEqual([
    expect.objectContaining({
      query: expect.stringMatching(/^select count\(\*\)/),
    }),
  ])

  // The cache is versioned by the cluster's snapshot, so a commit anywhere in
  // the cluster (autovacuum, another database) between the two counts is a
  // miss by design. Read the pair again until nothing committed across it.
  const snapshot = async () =>
    (await pool.query('select pg_current_snapshot()::text as version')).rows
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await snapshot()
    await queryBrowseCount('track', { ...query, page: 3 })
    capturedQueries.length = 0
    expect(
      await queryBrowseCount('track', {
        ...query,
        sortBy: 'title',
        limitResults: 5,
      }),
    ).toEqual({ totalCount: 5 })
    if (JSON.stringify(await snapshot()) === JSON.stringify(before)) break
  }
  expect(capturedQueries.map(({ query }) => query)).toEqual([
    expect.stringContaining('pg_current_snapshot'),
  ])
  expect(await queryBrowseIds('track', query)).toMatchObject({
    ids: first.ids,
    totalCount: 3,
    pageCount: 2,
  })
})

it('uses the title index for both directions of Track Browse', async () => {
  const { queryBrowsePageIds } = await import('@/services/browse')
  for (const direction of ['asc', 'desc']) {
    capturedQueries.length = 0
    const page = await queryBrowsePageIds(
      'track',
      TrackQuerySchema.parse({ sortBy: 'title', direction, size: 2 }),
    )
    expect(page.ids).toEqual(
      direction === 'asc'
        ? ['song-20000', 'song-1']
        : ['song-9999', 'song-9998'],
    )
    const statement = capturedQueries.find(({ query }) =>
      query.includes('order by'),
    )
    if (!statement) throw new Error('Expected ordered track query')
    const result = await pool.query(
      `explain (analyze, format json) ${statement.query}`,
      statement.params,
    )
    const plans = PlanRowsSchema.parse(result.rows).flatMap((row) =>
      row['QUERY PLAN'].flatMap((plan) => flattenPlan(plan.Plan)),
    )
    expect(
      plans.some(
        (plan) => plan['Index Name'] === 'media_item_type_title_id_idx',
      ),
    ).toBe(true)
  }
})

it('uses the default track date ordering index', async () => {
  const { queryBrowseIds } = await import('@/services/browse')
  capturedQueries.length = 0
  const descending = await queryBrowseIds(
    'track',
    TrackQuerySchema.parse({ size: 25 }),
  )
  const query = capturedQueries.find(({ query }) => query.includes('order by'))
  if (!query) throw new Error('Expected ordered track query')
  const result = await pool.query(
    `explain (analyze, format json) ${query.query}`,
    query.params,
  )
  const plans = PlanRowsSchema.parse(result.rows)
  const names = plans
    .flatMap((row) =>
      row['QUERY PLAN'].flatMap((plan) => flattenPlan(plan.Plan)),
    )
    .map((plan) => plan['Index Name'])
  expect(names).toContain('library_track_added_id_idx')
  const albumTitle = (id: number) => `Synthetic album ${Math.ceil(id / 20)}`
  const sortedIds = (direction: 'asc' | 'desc') =>
    Array.from({ length: 20000 }, (_, index) => index + 1)
      .sort((a, b) => {
        const aDate = a % 10 === 0 ? null : a % 31
        const bDate = b % 10 === 0 ? null : b % 31
        if (aDate === null && bDate !== null) return 1
        if (bDate === null && aDate !== null) return -1
        const dateOrder =
          ((aDate ?? 0) - (bDate ?? 0)) * (direction === 'asc' ? 1 : -1)
        if (dateOrder) return dateOrder
        const aTitle = albumTitle(a)
        const bTitle = albumTitle(b)
        if (aTitle !== bTitle) return aTitle < bTitle ? -1 : 1
        return a - b
      })
      .slice(0, 25)
      .map((id) => `song-${id}`)
  expect(descending.ids).toEqual(sortedIds('desc'))
  expect(descending.totalCount).toBe(20000)
  const ascending = await queryBrowseIds(
    'track',
    TrackQuerySchema.parse({ direction: 'asc', size: 25 }),
  )
  expect(ascending.ids).toEqual(sortedIds('asc'))
})

it('preserves membership, match labels, album precedence and literal text searches', async () => {
  const { queryBrowseIds, listBrowseFacets } = await import('@/services/browse')
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'search-import',
      slug: 'search-import',
      title: 'Signal 50%_\\verbatim',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
    {
      id: 'search-derived',
      slug: 'search-derived',
      title: 'Synthetic song 1',
      mediaType: 'track',
    },
    {
      id: 'search-unmatched',
      slug: 'search-unmatched',
      title: 'Quiet echo',
      mediaType: 'track',
    },
    {
      id: 'search-hidden',
      slug: 'search-hidden',
      title: 'Archived signal',
      mediaType: 'track',
      metadata: { legacyHidden: true },
    },
  ])
  await databaseClient.insert(schema.libraryTrack).values([
    {
      mediaItemId: 'search-import',
      spotifyTrackId: 'S'.repeat(22),
      albumName: 'Stored album name',
      albumMediaItemId: 'album-1',
    },
    {
      mediaItemId: 'search-derived',
      albumMediaItemId: 'album-1',
      spotifyTrackId: 'D'.repeat(22),
    },
    { mediaItemId: 'search-unmatched' },
    { mediaItemId: 'search-hidden' },
  ])
  await databaseClient.insert(schema.track).values({
    id: 'search-derived-entry',
    albumMediaItemId: 'album-1',
    trackMediaItemId: 'search-derived',
    title: 'Synthetic song 1',
    position: 21,
    externalId: 'D'.repeat(22),
  })
  await databaseClient.insert(schema.artist).values([
    {
      id: 'search-artist-a',
      name: 'Fixture Marker',
      sortName: 'Fixture Marker',
    },
    { id: 'search-artist-b', name: 'Second Voice', sortName: 'Second Voice' },
  ])
  await databaseClient.insert(schema.mediaCredit).values([
    ...[
      'search-import',
      'search-derived',
      'search-unmatched',
      'search-hidden',
    ].map((mediaItemId) => ({
      mediaItemId,
      artistId: 'search-artist-a',
      role: 'artist',
    })),
    {
      mediaItemId: 'search-import',
      artistId: 'search-artist-b',
      role: 'artist',
    },
  ])
  await databaseClient.insert(schema.playlist).values([
    {
      id: 'search-list-a',
      name: 'First list',
      kind: 'playlist',
      source: 'spotify',
    },
    {
      id: 'search-list-b',
      name: 'Second list',
      kind: 'playlist',
      source: 'spotify',
    },
    {
      id: 'search-liked',
      name: 'Likes',
      kind: 'playlist',
      source: 'spotify-liked',
    },
  ])
  await databaseClient.insert(schema.playlistItem).values([
    { playlistId: 'search-list-a', mediaItemId: 'search-import', position: 1 },
    { playlistId: 'search-list-b', mediaItemId: 'search-import', position: 1 },
    { playlistId: 'search-liked', mediaItemId: 'search-import', position: 1 },
    { playlistId: 'search-liked', mediaItemId: 'search-derived', position: 2 },
  ])
  await databaseClient.insert(schema.lastfmTrackSource).values([
    {
      username: 'fixture-listener',
      artistKey: 'fixture-marker',
      trackKey: 'signal',
      trackMediaItemId: 'search-import',
    },
    {
      username: 'fixture-listener',
      artistKey: 'fixture-marker',
      trackKey: 'echo',
      trackMediaItemId: 'search-unmatched',
    },
  ])
  await databaseClient.insert(schema.tag).values([
    { id: 'search-visible-tag', name: 'Visible-motif', mediaType: 'album' },
    {
      id: 'search-hidden-tag',
      name: 'Hidden-motif',
      mediaType: 'album',
      hidden: true,
    },
  ])
  await databaseClient.insert(schema.mediaItemTag).values([
    { mediaItemId: 'album-1', tagId: 'search-visible-tag' },
    { mediaItemId: 'album-1', tagId: 'search-hidden-tag' },
  ])
  const ids = async (q: string) =>
    (
      await queryBrowseIds(
        'track',
        TrackQuerySchema.parse({ q, sortBy: 'title' }),
      )
    ).ids.sort()
  expect(await ids('marker signal')).toEqual(['search-import'])
  expect(await ids('marker voice')).toEqual(['search-import'])
  expect(await ids('marker 50%_\\verbatim')).toEqual(['search-import'])
  expect(await ids('marker 50%X')).toEqual([])
  expect(await ids('marker Spotify playlist')).toEqual(['search-import'])
  expect(await ids('marker Album track list')).toEqual(['search-derived'])
  expect(await ids('marker Unmatched')).toEqual(['search-unmatched'])
  expect(await ids('marker Last.fm')).toEqual([
    'search-import',
    'search-unmatched',
  ])
  expect(await ids('marker Liked Songs')).toEqual([
    'search-derived',
    'search-import',
  ])
  expect(await ids('marker Spotify playlists')).toEqual(['search-import'])
  expect(await ids('marker Not in library')).toEqual(['search-unmatched'])
  expect(await ids('marker Stored album')).toEqual(['search-import'])
  expect(await ids('marker Synthetic album')).toEqual(['search-derived'])
  expect(await ids('marker Visible-motif')).toEqual([
    'search-derived',
    'search-import',
  ])
  expect(await ids('marker Hidden-motif')).toEqual([])
  expect(await ids('marker Archived')).toEqual([])
  expect(
    (await listBrowseFacets('track', { q: 'Source' })).filter(
      (row) => row.field === 'source',
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: 'Spotify playlists', count: 1 }),
      expect.objectContaining({ value: 'Liked Songs', count: 2 }),
      expect.objectContaining({ value: 'Last.fm', count: 2 }),
    ]),
  )
  expect(fetch).not.toHaveBeenCalled()
})

it('groups a broad listening page and count without rereading shared scrobbles', async () => {
  const { queryBrowseCount, queryBrowsePageIds } =
    await import('@/services/browse')
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'scrobbles',
    size: 25,
  })
  const baseline = await queryBrowseCount('track', query)
  await pool.query(`
    insert into media_item (id, slug, title, media_type)
    select 'edition-' || n, 'edition-' || n, mi.title, 'track'
    from generate_series(1, 2500) n join media_item mi on mi.id = 'song-' || n;
    insert into library_track (media_item_id, spotify_track_id, scrobble_count, last_listened_at)
    select 'edition-' || n, lpad((n + 20000)::text, 22, '0'), 40, timestamp '2026-01-01'
    from generate_series(1, 2500) n;
    update library_track lt set scrobble_count = 40, last_listened_at = timestamp '2026-01-01'
    from generate_series(1, 2500) n where lt.media_item_id = 'song-' || n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'edition-' || n, 'artist', 'artist' from generate_series(1, 2500) n;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'listener', 'synthetic performer', 'synthetic song ' || n, prefix || n, 'exact'
    from generate_series(1, 2500) n cross join (values ('song-'), ('edition-')) editions(prefix);
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'event-' || n || '-' || event, 'listener', timestamp '2026-01-01' - (40 - event) * interval '1 minute',
      'Synthetic Performer', 'Synthetic song ' || n, 'synthetic performer', 'synthetic song ' || n
    from generate_series(1, 2500) n cross join generate_series(1, 40) event;
    analyze media_item; analyze library_track; analyze media_credit;
    analyze lastfm_track_link; analyze lastfm_scrobble;
  `)
  capturedQueries.length = 0
  const first = await queryBrowsePageIds('track', query)
  expect(first.ids).toHaveLength(25)
  expect(first.hasMore).toBe(true)
  expect(
    [...(first.recordingGroups?.values() ?? [])].map(
      ({ version_count, scrobbles }) => [version_count, scrobbles],
    ),
  ).toEqual(Array.from({ length: 25 }, () => [2, 40]))
  expect(await queryBrowseCount('track', query)).toEqual(baseline)

  const queries = capturedQueries.filter(
    ({ query }) => !query.includes('pg_current_snapshot'),
  )
  expect(queries).toHaveLength(2)
  for (const { query, params } of queries) {
    const result = await pool.query(
      `explain (analyze, format json) ${query}`,
      params,
    )
    const plans = PlanRowsSchema.parse(result.rows).flatMap((row) =>
      row['QUERY PLAN'].flatMap((plan) => flattenPlan(plan.Plan)),
    )
    const relations = plans.filter(
      (plan) => plan['Relation Name'] === 'lastfm_scrobble',
    )
    expect(relations.every((plan) => plan['Actual Loops'] === 0)).toBe(true)
    // The tied scrobble counts must not repeatedly scan the full library.
    expect(
      plans.every(
        (plan) => plan['Actual Rows'] * plan['Actual Loops'] < 100_000,
      ),
    ).toBe(true)
  }
})

it('reads exact title peers through the recording index for filtered grouping', async () => {
  const { queryBrowseCount, queryBrowsePageIds, queryTrackRecordingVersions } =
    await import('@/services/browse')
  await pool.query(`
    insert into media_item (id, slug, title, media_type, metadata) values
      ('paired-edition', 'paired-edition', E'  distinctive\\tneedle  SONG ', 'track', null),
      ('archived-edition', 'archived-edition', 'Distinctive needle song', 'track', '{"legacyHidden": true}');
    insert into library_track (media_item_id, isrc, duration_sec) values
      ('paired-edition', 'AUABC2600001', 181),
      ('archived-edition', 'AUABC2600001', 400);
    update library_track set isrc = 'AUABC2600001', duration_sec = 180 where media_item_id = 'song-20000';
    insert into media_credit (media_item_id, artist_id, role) values
      ('paired-edition', 'artist', 'artist'), ('archived-edition', 'artist', 'artist');
    insert into playlist (id, kind, name) values ('fixture-group', 'playlist', 'Fixture group');
    insert into playlist_item (playlist_id, media_item_id) values
      ('fixture-group', 'song-20000'), ('fixture-group', 'paired-edition'), ('fixture-group', 'archived-edition');
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data) values
      ('fixture-group-tags', 'artist', 'musicbrainz', '{}', '{"tags":["Fixture group tag"]}');
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id) values
      ('artist', 'musicbrainz', 'fixture-group-tags');
    analyze media_item; analyze library_track; analyze media_credit; analyze playlist_item;
  `)
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'dateAdded',
    filters: [
      { field: 'playlist', value: 'Fixture group', mode: 'required' },
      { field: 'artistTag', value: 'Fixture group tag', mode: 'required' },
    ],
  })
  capturedQueries.length = 0
  const page = await queryBrowsePageIds('track', query)
  expect(page.ids).toEqual(['song-20000'])
  expect(page.recordingGroups?.get('song-20000')?.version_count).toBe(2)
  expect(await queryBrowseCount('track', query)).toEqual({ totalCount: 1 })
  const versions = await queryTrackRecordingVersions('song-20000', query)
  expect(versions.ids.sort()).toEqual(['paired-edition', 'song-20000'])

  const statements = capturedQueries.filter(({ query }) =>
    query.includes('recording_contenders'),
  )
  expect(statements).toHaveLength(3)
  for (const { query, params } of statements) {
    const result = await pool.query(
      `explain (analyze, format json) ${query}`,
      params,
    )
    const plans = PlanRowsSchema.parse(result.rows).flatMap((row) =>
      row['QUERY PLAN'].flatMap((plan) => flattenPlan(plan.Plan)),
    )
    expect(
      plans.some(
        (plan) =>
          plan['Index Name'] === 'media_item_recording_title_idx' &&
          plan['Actual Loops'] > 0,
      ),
    ).toBe(true)
  }
})
