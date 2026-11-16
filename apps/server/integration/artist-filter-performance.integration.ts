import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { ArtistMetadataQuerySchema } from '@repo/schemas/creators'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = 'artist_filter_performance_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  connectionTimeoutMillis: 5000,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({
  ...connection,
  database: name,
  max: 2,
  statement_timeout: 10000,
})
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const database = drizzle(pool, { schema, logger: { logQuery } })
vi.mock('@/lib/db', () => ({
  get db() {
    return database
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
    insert into artist (id, name) values ('artist-hidden', 'Invisible Artist'), ('artist-stale', 'Invisible Stale Credit');
    insert into media_item (id, slug, media_type, title, metadata) values
      ('album-hidden', 'album-hidden', 'album', 'Hidden album', '{"legacyHidden":true}'),
      ('album-stale', 'album-stale', 'album', 'Missing album', '{}');
    insert into album (media_item_id) values ('album-hidden');
    insert into media_credit (media_item_id, artist_id, role) values
      ('album-hidden', 'artist-hidden', 'artist'), ('album-stale', 'artist-stale', 'artist');
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
  await pool.query(`
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data, created_at)
      select 'history-profile-' || n || '-' || provider, 'artist-' || n, provider, '{}',
        jsonb_build_object('country', case when n % 3 = 0 then 'Australia' else 'Canada' end, 'type','Group','tags',jsonb_build_array('Rock','Ambient','Fixture tag ' || n % 30)),
        now() - interval '100 days'
      from generate_series(1,3000) n cross join unnest(array['spotify','lastfm','discogs']) provider;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      select artist_id, provider, id from artist_provider_snapshot where id like 'history-profile-%';
    insert into scrape_job (id, provider, status, scope, options, created_at, started_at, finished_at)
      select 'history-job-' || n,
        case when n % 2 = 0 then 'spotify' else 'musicbrainz' end,
        case when n % 3 = 0 then 'failed'::job_status else 'succeeded'::job_status end,
        '{}', jsonb_build_object('task','artist-enrichment','artistId','artist-' || ((n-1) % 4000 + 1)),
        timestamp '2025-04-01' - n * interval '1 second', timestamp '2025-04-01' - n * interval '1 second', timestamp '2025-05-01'
      from generate_series(1,80000) n;
    insert into scrape_job (id, provider, status, scope, options)
      select 'other-job-' || n, 'spotify', 'succeeded', '{}', jsonb_build_object('task','spotify-playlist-import')
      from generate_series(1,20000) n;
    insert into scrape_job (id, provider, status, scope, options, created_at, started_at) values
      ('late-attempt', 'spotify', 'succeeded', '{}', '{"task":"artist-enrichment","artistId":"artist-6"}', timestamp '2024-01-01', timestamp '2025-05-01'),
      ('queued-after-attempt', 'spotify', 'queued', '{}', '{"task":"artist-enrichment","artistId":"artist-6"}', timestamp '2026-01-01', timestamp '2026-01-02'),
      ('queued-before-attempt', 'spotify', 'queued', '{}', '{"task":"artist-enrichment","artistId":"artist-3001"}', timestamp '2026-01-01', null),
      ('job-missing-artist', 'spotify', 'failed', '{}', '{"task":"artist-enrichment"}', timestamp '2026-01-01', timestamp '2026-01-01');
  `)
  for (const table of [
    'artist',
    'media_item',
    'album',
    'library_track',
    'media_credit',
    'playlist',
    'playlist_item',
    'scrape_job',
    'artist_provider_current_state',
    'artist_provider_snapshot',
  ])
    await pool.query('vacuum analyze ' + table)
}, 60000)

beforeEach(() => logQuery.mockClear())

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.unstubAllGlobals()
})

async function explainServiceQuery(contains: string) {
  const logged = logQuery.mock.calls.find(([statement]) =>
    statement.includes(contains),
  )
  if (!logged) throw new Error(`Expected service query containing ${contains}`)
  const [statement, values] = logged
  const result = await pool.query<{ 'QUERY PLAN': string }>(
    `explain (analyze, timing off, costs off) ${statement}`,
    values,
  )
  return result.rows.map((row) => row['QUERY PLAN']).join('\n')
}

it('uses indexed default ordering and bounded job history lookups for the returned page', async () => {
  const { listArtistMetadataBrowsePage } =
    await import('@/services/artist-browse')
  const page = await listArtistMetadataBrowsePage(
    ArtistMetadataQuerySchema.parse({ size: 50 }),
  )
  expect(page.items).toHaveLength(50)
  expect(
    page.items
      .find(({ id }) => id === 'artist-6')
      ?.providers.find(({ provider }) => provider === 'spotify'),
  ).toMatchObject({
    lastJobStatus: 'queued',
    lastAttemptAt: '2025-05-01T00:00:00.000Z',
  })
  expect(await explainServiceQuery('select a.id from')).toContain(
    'artist_browse_name_idx',
  )
  const historyPlan = await explainServiceQuery('as "lastJobStatus"')
  expect(historyPlan).toMatch(/scrape_job_artist_created_idx.*loops=200/)
  expect(historyPlan).toMatch(/scrape_job_artist_attempt_idx.*loops=200/)
  expect(historyPlan).not.toMatch(/Seq Scan on scrape_job/)
})

it.each([
  { mode: 'never', first: 'artist-3001', count: 1500 },
  { mode: 'failed', first: 'artist-12', count: 665 },
])(
  'filters $mode before pagination and counting with the attempt index',
  async ({ mode, first, count }) => {
    const { listArtistMetadataBrowsePage, countArtistBrowse } =
      await import('@/services/artist-browse')
    const query = ArtistMetadataQuerySchema.parse({
      size: 50,
      freshness: [{ provider: 'spotify', mode }],
    })
    const page = await listArtistMetadataBrowsePage(query)
    expect(page.items[0]?.id).toBe(first)
    expect(page.hasMore).toBe(true)
    expect(await countArtistBrowse(query)).toEqual({ totalCount: count })
    expect(await explainServiceQuery('select a.id from')).toContain(
      'scrape_job_artist_attempt_idx',
    )
    expect(
      await explainServiceQuery('select count(*)::int as count from'),
    ).toContain('scrape_job_artist_attempt_idx')
  },
)

it('combines provider freshness, playlist and tag filters while preserving their modes', async () => {
  const { countArtistBrowse } = await import('@/services/artist-browse')
  const neverSpotify = { provider: 'spotify', mode: 'never' }
  const failedSpotify = { provider: 'spotify', mode: 'failed' }
  const neverMusicbrainz = { provider: 'musicbrainz', mode: 'never' }
  const cases = [
    { freshness: [neverSpotify, failedSpotify], totalCount: 2165 },
    { freshness: [neverSpotify, neverMusicbrainz], totalCount: 999 },
    {
      freshness: [{ provider: 'spotify', mode: 'older', olderThanDays: 90 }],
      totalCount: 5000,
    },
    {
      freshness: [{ provider: 'spotify', mode: 'older', olderThanDays: 365 }],
      totalCount: 2000,
    },
    {
      freshness: [neverSpotify],
      playlistIds: ['playlist-100'],
      totalCount: 10,
    },
    {
      filters: [{ field: 'genre', value: 'ambient', mode: 'required' }],
      totalCount: 3000,
    },
  ]
  for (const { totalCount, ...input } of cases) {
    expect(
      await countArtistBrowse(ArtistMetadataQuerySchema.parse(input)),
    ).toEqual({ totalCount })
  }
})

it('counts each visible artist once per suggestion across profiles and playlists', async () => {
  const { listArtistBrowseFacets } = await import('@/services/artist-browse')
  const facets = await listArtistBrowseFacets({ q: '', limitPerField: 25 })
  expect(
    facets.find(
      ({ field, value }) =>
        field === 'genre' && value.toLowerCase() === 'ambient',
    )?.count,
  ).toBe(3000)
  expect(facets.find(({ field }) => field === 'playlist')?.count).toBe(50)
  expect(
    await listArtistBrowseFacets({ q: 'invisible', limitPerField: 25 }),
  ).toEqual([])
})
