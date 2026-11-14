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
    insert into library_track (media_item_id, album_media_item_id, date_added)
    select 'song-' || n, 'album-' || ((n - 1) / 20 + 1),
      case when n % 10 = 0 then null else timestamp '2020-01-01' + (n % 31) * interval '1 day' end
    from generate_series(1, 20000) n;
    insert into track (id, album_media_item_id, title, position, external_id)
    select mi.id, lt.album_media_item_id, mi.title,
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

it('searches synthetic track titles without per-row metadata aggregation', async () => {
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
    expect(trackReads.every((plan) => plan['Actual Loops'] === 0)).toBe(true)
  }
})

type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Loops': number
  Plans?: PlanNode[]
}
const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    'Node Type': z.string(),
    'Relation Name': z.string().optional(),
    'Index Name': z.string().optional(),
    'Actual Loops': z.number(),
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
  const sortedIds = (direction: 'asc' | 'desc') =>
    Array.from({ length: 20000 }, (_, index) => index + 1)
      .sort((a, b) => {
        const aDate = a % 10 === 0 ? null : a % 31
        const bDate = b % 10 === 0 ? null : b % 31
        if (aDate === null && bDate !== null) return 1
        if (bDate === null && aDate !== null) return -1
        const dateOrder =
          ((aDate ?? 0) - (bDate ?? 0)) * (direction === 'asc' ? 1 : -1)
        return dateOrder || (`song-${a}` < `song-${b}` ? -1 : 1)
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
    { mediaItemId: 'search-derived', albumMediaItemId: 'album-1' },
    { mediaItemId: 'search-unmatched' },
    { mediaItemId: 'search-hidden' },
  ])
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
  expect(await ids('marker Spotify import')).toEqual(['search-import'])
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
