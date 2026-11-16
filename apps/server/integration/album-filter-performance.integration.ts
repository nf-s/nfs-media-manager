import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { AlbumSelectionQuerySchema } from '@repo/schemas/album-selection'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { env } from '@/env'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'

const name = 'album_filter_performance_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({
  ...connection,
  database: name,
  statement_timeout: 20000,
})
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const database = drizzle(pool, { schema, logger: { logQuery } })
const fetchMock = vi.fn(() => {
  throw new Error('Network forbidden')
})
const fixturePlugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-provider',
    displayName: 'Fixture provider',
    description: '',
    mediaTypes: ['album'],
    identifierTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    maxItemsPerJob: 1,
    requireExplicitSelection: true,
  },
  scrapeMediaItem: vi.fn(async () => {
    throw new Error('Unexpected provider execution')
  }),
}
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [fixturePlugin],
  getScrapePlugin: async (id: string) =>
    id === fixturePlugin.manifest.id ? fixturePlugin : null,
  listProviderCatalog: async () => [
    createCatalogEntryFromPlugin(fixturePlugin, null),
  ],
}))
let created = false

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  await admin.connect()
  await admin.query('create database ' + name)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
  await pool.query(`
    insert into artist (id, name)
      select 'artist-' || n, 'Fixture artist ' || n from generate_series(1, 5000) n;
    insert into media_item (id, slug, media_type, title)
      select 'album-' || n, 'album-' || n, 'album', 'Fixture album ' || n from generate_series(1, 5000) n;
    insert into album (media_item_id, date_added)
      select 'album-' || n, now() - n * interval '1 day' from generate_series(1, 5000) n;
    insert into media_credit (media_item_id, artist_id, role)
      select 'album-' || n, 'artist-' || n, 'artist' from generate_series(1, 5000) n;
    insert into media_item (id, slug, media_type, title)
      select 'track-' || n, 'track-' || n, 'track', 'Fixture track ' || n from generate_series(1, 20000) n;
    insert into library_track (media_item_id, album_media_item_id)
      select 'track-' || n, 'album-' || ((n-1) % 5000 + 1) from generate_series(1, 20000) n;
    insert into media_credit (media_item_id, artist_id, role)
      select 'track-' || n, 'artist-' || ((n-1) % 5000 + 1), 'artist' from generate_series(1, 20000) n;
    insert into playlist (id, name, kind, source)
      select 'playlist-' || n, 'Fixture playlist ' || n, 'playlist', 'fixture' from generate_series(1, 100) n;
    insert into playlist_item (playlist_id, media_item_id, position)
      select 'playlist-' || ((n-1) % 100 + 1), 'track-' || n, n from generate_series(1, 20000) n;
    insert into tag (id, media_type, name, hidden)
      select 'tag-' || n, 'album', 'Fixture tag ' || n, n % 10 = 0 from generate_series(1, 1500) n;
    insert into tag_identity (media_type, normalized_name, kind, tag_id)
      select media_type, lower(name), 'general', id from tag;
    insert into media_item_tag (media_item_id, tag_id)
      select 'album-' || n, 'tag-' || ((n-1) % 1500 + 1) from generate_series(1, 5000) n where n % 3 <> 0;
    insert into media_item_tag (media_item_id, tag_id)
      select 'album-' || n, 'tag-' || (n % 1500 + 1) from generate_series(1, 5000) n where n % 3 = 1;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      select 'profile-' || n || '-' || provider, 'artist-' || n, provider, '{}',
        jsonb_build_object('tags', jsonb_build_array('Common tag', 'Fixture tag ' || (n % 1500 + 1),
          'Artist label ' || n, case when n % 500 = 0 then 'Spectralneedle' else 'Ambient' end))
      from generate_series(1, 3000) n cross join unnest(array['spotify','lastfm','discogs']) provider;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      select artist_id, provider, id from artist_provider_snapshot;
    insert into scrape_job (id, provider, status, scope, options, created_at, started_at, finished_at)
      select 'job-' || n, 'fixture-provider',
        case when n % 3 = 0 then 'failed'::job_status else 'succeeded'::job_status end,
        '{"mediaType":"album"}', '{}', now() - n * interval '1 minute', now() - n * interval '1 minute', now()
      from generate_series(1, 80000) n;
    insert into scrape_job_item (id, job_id, provider, status, media_item_id, created_at, started_at, finished_at)
      select 'job-item-' || n, j.id, j.provider, j.status, 'album-' || ((n-1) % 4000 + 1),
        j.created_at, j.started_at, j.finished_at
      from generate_series(1, 80000) n join scrape_job j on j.id = 'job-' || n;
    insert into provider_current_state (id, media_item_id, provider, checksum, payload, status, last_scraped_at)
      select 'state-' || n, 'album-' || n, 'fixture-provider', '', '{}', 'succeeded',
        now() - (n % 130) * interval '1 day' - interval '12 hours' from generate_series(1, 3000) n;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
      select 'scrobble-' || n, 'fixture', now() - n * interval '1 day', 'Fixture artist', 'Fixture track',
        'fixture artist', 'fixture track', 'album-' || ((n-1) % 3000 + 1) from generate_series(1, 30000) n;
  `)
  await pool.query('vacuum analyze')
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.unstubAllGlobals()
  expect(fixturePlugin.scrapeMediaItem).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})

function loggedQuery(matches: (query: string) => boolean) {
  const call = logQuery.mock.calls.find(([query]) => matches(query))
  if (!call) throw new Error('Expected an album browse query')
  return call
}

async function expectOneProfileExpansion([query, params]: [string, unknown[]]) {
  const result = await pool.query<{ 'QUERY PLAN': string }>(
    'explain (analyze, format text) ' + query,
    params,
  )
  expect(
    result.rows.filter((row) =>
      row['QUERY PLAN'].includes(
        'Function Scan on jsonb_array_elements_text provider_tag',
      ),
    ),
  ).toHaveLength(1)
}

const isPageSql = (query: string) =>
  query.includes('select "media_item"."id", null from "media_item"')

it('matches and counts albums through playlist track memberships in a set', async () => {
  const { listAlbumBrowsePage } = await import('@/services/media')
  const { queryBrowseCount } = await import('@/services/browse')
  const initial = AlbumQuerySchema.parse({ size: 50 })
  expect(await queryBrowseCount('album', initial)).toEqual({ totalCount: 5000 })
  expect((await listAlbumBrowsePage(initial)).items[0]?.id).toBe('album-3001')

  const playlist = AlbumQuerySchema.parse({
    size: 50,
    filters: JSON.stringify([
      { field: 'playlist', value: 'Fixture playlist 100', mode: 'required' },
    ]),
  })
  logQuery.mockClear()
  const page = await listAlbumBrowsePage(playlist)
  expect(page.hasMore).toBe(false)
  expect(new Set(page.items.map(({ id }) => id))).toEqual(
    new Set(
      Array.from({ length: 50 }, (_, index) => `album-${(index + 1) * 100}`),
    ),
  )
  const [query] = loggedQuery(isPageSql)
  expect(query).not.toContain('album_media_item_id = "media_item"."id"')
  expect(await queryBrowseCount('album', playlist)).toEqual({ totalCount: 50 })
})

it('expands artist profiles once per album search, tag sort and autocomplete query', async () => {
  const { listAlbumBrowsePage, listAlbumFilterOptions } =
    await import('@/services/media')
  const { queryBrowseCount } = await import('@/services/browse')
  const search = AlbumQuerySchema.parse({ q: 'album 4999', size: 50 })
  logQuery.mockClear()
  const match = await listAlbumBrowsePage(search)
  expect(match.items.map(({ id }) => id)).toEqual(['album-4999'])
  await expectOneProfileExpansion(loggedQuery(isPageSql))
  expect(await queryBrowseCount('album', search)).toEqual({ totalCount: 1 })

  const tag = AlbumQuerySchema.parse({
    filters: JSON.stringify([
      { field: 'genre', value: 'Spectralneedle', mode: 'required' },
    ]),
  })
  expect(await queryBrowseCount('album', tag)).toEqual({ totalCount: 6 })
  logQuery.mockClear()
  const facets = await listAlbumFilterOptions({
    q: 'Spectralneedle',
    limitPerField: 25,
  })
  expect(facets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'genre',
        value: 'spectralneedle',
        count: 6,
      }),
      expect.objectContaining({
        field: 'artistTag',
        value: 'spectralneedle',
        count: 6,
      }),
    ]),
  )
  await expectOneProfileExpansion(
    loggedQuery((query) => query.includes('values_for_field')),
  )

  logQuery.mockClear()
  const sorted = await listAlbumBrowsePage(
    AlbumQuerySchema.parse({ size: 50, sortBy: 'genre' }),
  )
  expect(sorted.items).toHaveLength(50)
  await expectOneProfileExpansion(loggedQuery(isPageSql))
})

it('evaluates album freshness against stored job history', async () => {
  const { listAlbumSelection } = await import('@/services/album-selection')
  for (const { mode, totalCount } of [
    { mode: 'never', totalCount: 1000 },
    { mode: 'failed', totalCount: 1333 },
    { mode: 'older', totalCount: 2920 },
  ]) {
    const query = AlbumSelectionQuerySchema.parse({
      size: 50,
      freshness: [{ provider: 'fixture-provider', mode, olderThanDays: 90 }],
    })
    const page = await listAlbumSelection(query)
    expect(page.totalCount).toBe(totalCount)
    expect(page.items).toHaveLength(50)
  }
})
