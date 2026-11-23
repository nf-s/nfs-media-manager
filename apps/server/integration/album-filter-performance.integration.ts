import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { AlbumSelectionQuerySchema } from '@repo/schemas/album-selection'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { TrackQuerySchema } from '@repo/schemas/tracks'
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
    displayName: 'Sample Catalogue',
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

// The page read is the only one that selects IDs with their rank.
const isPageSql = (query: string) =>
  /select "media_item"\."id", .* as "rank" from "media_item"/.test(query)

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

it('finds unplayed playlist tracks through indexed current artist tags', async () => {
  const { queryBrowsePageIds, queryBrowseCount } =
    await import('@/services/browse')
  await pool.query(`
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    values ('retired-profile', 'artist-100', 'spotify', '{}', '{"tags":["Spectralneedle"]}');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    values ('fixture', 'artist', 'recent', 'track-500', 'exact'),
           ('fixture', 'artist', 'older', 'track-1000', 'exact');
    insert into lastfm_scrobble (id, username, listened_at, artist_name, artist_key, track_name, track_key)
    values ('recent', 'fixture', now() - interval '1 day', 'artist', 'artist', 'recent', 'recent'),
           ('older', 'fixture', now() - interval '2 years', 'artist', 'artist', 'older', 'older');
  `)
  const query = TrackQuerySchema.parse({
    size: 50,
    filters: [
      { field: 'playlist', value: 'Fixture playlist 100', mode: 'required' },
      { field: 'artistTag', value: 'Spectralneedle' },
    ],
    listening: {
      match: 'all',
      rules: [
        { period: { kind: 'rolling', amount: 1, unit: 'years' }, max: 0 },
      ],
    },
  })
  logQuery.mockClear()
  const page = await queryBrowsePageIds('track', query)
  const expected = Array.from({ length: 4 }, (_, cycle) =>
    Array.from({ length: 6 }, (_, n) => cycle * 5000 + (n + 1) * 500),
  )
    .flat()
    .filter((id) => id !== 500)
    .map((id) => `track-${id}`)
  expect(page.hasMore).toBe(false)
  expect(new Set(page.ids)).toEqual(new Set(expected))
  expect(await queryBrowseCount('track', query)).toEqual({
    totalCount: expected.length,
  })
  const queries = logQuery.mock.calls.filter(([query]) =>
    query.includes('artist_profile_tag_keys'),
  )
  expect(queries).toHaveLength(2)
  for (const [sql, params] of queries) {
    const result = await pool.query<{ 'QUERY PLAN': string }>(
      'explain (analyze, format text) ' + sql,
      params,
    )
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n')
    expect(plan).toContain('artist_provider_snapshot_tag_keys_idx')
    expect(plan).not.toContain(
      'Function Scan on jsonb_array_elements_text provider_tag',
    )
  }
})

it('evaluates album freshness against stored job history', async () => {
  const { listAlbumSelection } = await import('@/services/album-selection')
  logQuery.mockClear()
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
  expect(
    logQuery.mock.calls.filter(([query]) =>
      /provider_secret|provider_request_(state|event)/.test(query),
    ),
  ).toEqual([])
})

it('keeps Album suggestions exact and bounded across playlist fan-out, editions and edits', async () => {
  await pool.query(`
    insert into playlist_item (playlist_id, media_item_id, position)
    select 'playlist-' || ((n + shift - 1) % 100 + 1), 'track-' || n, n
    from generate_series(1, 20000) n cross join generate_series(1, 15) shift;
    insert into media_item (id, slug, media_type, title, metadata) values
      ('facet-primary', 'facet-primary', 'album', 'Facet edition fixture', '{"browse":{"country":["Belgium","Belgium","Canada"]}}'),
      ('facet-edition', 'facet-edition', 'album', 'Facet edition fixture', '{"browse":{"country":"Belgium"}}'),
      ('facet-archived', 'facet-archived', 'album', 'Facet edition fixture', '{"legacyHidden":true}');
    insert into album (media_item_id) values ('facet-primary'), ('facet-archived');
    insert into album (media_item_id, edition_of_id) values ('facet-edition', 'facet-primary');
    insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values
      ('facet-provider-primary', 'facet-primary', 'fixture-provider', 'album', 'fixture-primary'),
      ('facet-provider-edition', 'facet-edition', 'fixture-provider', 'album', 'fixture-edition');
    insert into playlist (id, name, kind, source) values ('facet-playlist', 'Facet playlist fixture', 'playlist', 'fixture');
    insert into playlist_item (playlist_id, media_item_id, position) values
      ('facet-playlist', 'facet-primary', 1), ('facet-playlist', 'track-1', 2),
      ('facet-playlist', 'facet-edition', 3), ('facet-playlist', 'facet-archived', 4);
    insert into track (id, track_media_item_id, album_media_item_id, title, position)
    values ('facet-linked-track', 'track-1', 'facet-primary', 'Facet track fixture', 1);
    analyze playlist_item;
    analyze media_item;
    analyze album;
    analyze track;
  `)
  const { listAlbumFilterOptions } = await import('@/services/media')
  const {
    listBrowseFacets,
    listBrowseFields,
    queryBrowseCount,
    refreshAlbumFacetVocabularyForMaintenance,
  } = await import('@/services/browse')
  const fields = await listBrowseFields('album')
  await listAlbumFilterOptions({ q: '', limitPerField: 25 })
  const queries = [
    { q: '' },
    { q: 'a' },
    { q: 'Spectralneedle' },
    { q: 'Facet edition fixture' },
    { q: 'Facet playlist fixture' },
    { q: 'Belgium' },
    { q: 'catalogue' },
  ]
  for (const input of queries) {
    const query = { ...input, limitPerField: 25 }
    const live = await listBrowseFacets('album', query, { fields })
    await pool.query('select pg_current_xact_id()')
    logQuery.mockClear()
    expect(await listAlbumFilterOptions(query)).toEqual(live)
    const [statement, params] = loggedQuery((sql) =>
      sql.includes('ready_album_facet_vocabulary'),
    )
    expect(
      logQuery.mock.calls.some(([sql]) => sql.includes('values_for_field')),
    ).toBe(false)
    const plan = await pool.query(
      'explain (analyze, buffers, timing off, format json) ' + statement,
      params,
    )
    const [row] = z
      .tuple([
        z.object({
          'QUERY PLAN': z.tuple([
            z.object({
              Plan: z.object({
                'Shared Hit Blocks': z.number(),
                'Shared Read Blocks': z.number(),
              }),
            }),
          ]),
        }),
      ])
      .parse(plan.rows)
    const buffers = row['QUERY PLAN'][0].Plan
    expect(
      buffers['Shared Hit Blocks'] + buffers['Shared Read Blocks'],
    ).toBeLessThan(query.q ? 700 : 200)
  }

  const editionSearch = { q: 'Facet edition fixture', limitPerField: 25 }
  expect(await listAlbumFilterOptions(editionSearch)).toContainEqual(
    expect.objectContaining({
      field: 'title',
      value: 'Facet edition fixture',
      count: 2,
    }),
  )
  expect(
    await listAlbumFilterOptions({ ...editionSearch, includeArchived: 'true' }),
  ).toContainEqual(
    expect.objectContaining({
      field: 'title',
      value: 'Facet edition fixture',
      count: 3,
    }),
  )
  expect(
    await queryBrowseCount('album', AlbumQuerySchema.parse(editionSearch)),
  ).toEqual({ totalCount: 1 })
  expect(
    await queryBrowseCount(
      'album',
      AlbumQuerySchema.parse({ ...editionSearch, editions: 'true' }),
    ),
  ).toEqual({ totalCount: 2 })
  expect(
    await listAlbumFilterOptions({
      q: 'Facet playlist fixture',
      limitPerField: 25,
    }),
  ).toContainEqual(
    expect.objectContaining({
      field: 'playlist',
      value: 'Facet playlist fixture',
      count: 3,
    }),
  )
  expect(
    await listAlbumFilterOptions({ q: 'Belgium', limitPerField: 25 }),
  ).toContainEqual(
    expect.objectContaining({ field: 'country', value: 'Belgium', count: 2 }),
  )
  expect(
    await listAlbumFilterOptions({ q: 'catalogue', limitPerField: 25 }),
  ).toContainEqual(
    expect.objectContaining({
      field: 'provider',
      value: 'fixture-provider',
      label: 'Provider: Sample Catalogue',
      count: 2,
    }),
  )
  const editionFacet = { q: 'another album', limitPerField: 25 }
  expect(await listAlbumFilterOptions(editionFacet)).toContainEqual(
    expect.objectContaining({
      field: 'edition',
      value: 'Edition of another album',
      count: 1,
    }),
  )

  const located = {
    q: 'Spectralneedle',
    limitPerField: 25,
    tagLevels: ['artist'],
  } satisfies Parameters<typeof listAlbumFilterOptions>[0]
  expect(await listAlbumFilterOptions(located)).toEqual(
    await listBrowseFacets('album', located, { fields }),
  )
  await pool.query(`
    update media_item set title = 'Facet revised release' where id = 'facet-edition';
    update album set edition_of_id = null where media_item_id = 'facet-edition';
    update playlist set name = 'Facet revised playlist' where id = 'facet-playlist';
    update artist_provider_snapshot set normalized_data = '{"tags":[]}'
    where artist_id = 'artist-500';
  `)
  const renamed = { q: 'Facet revised', limitPerField: 25 }
  const fresh = await listAlbumFilterOptions(renamed)
  expect(fresh).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'title',
        value: 'Facet revised release',
        count: 1,
      }),
      expect.objectContaining({
        field: 'playlist',
        value: 'Facet revised playlist',
        count: 3,
      }),
    ]),
  )
  expect(await listAlbumFilterOptions(editionFacet)).not.toContainEqual(
    expect.objectContaining({
      field: 'edition',
      value: 'Edition of another album',
    }),
  )
  expect(
    await listAlbumFilterOptions({ q: 'Spectralneedle', limitPerField: 25 }),
  ).toContainEqual(
    expect.objectContaining({
      field: 'artistTag',
      value: 'spectralneedle',
      count: 5,
    }),
  )

  await pool.query(
    "update album_facet_state set retry_after = now() - interval '1 second'",
  )
  expect(await refreshAlbumFacetVocabularyForMaintenance()).toBe(true)
  await pool.query(
    "update media_item set title = title where id = 'facet-edition'",
  )
  logQuery.mockClear()
  expect(await listAlbumFilterOptions(renamed)).toEqual(fresh)
  expect(
    logQuery.mock.calls.some(([sql]) =>
      sql.includes('ready_album_facet_vocabulary'),
    ),
  ).toBe(true)
  expect(
    logQuery.mock.calls.some(([sql]) => sql.includes('values_for_field')),
  ).toBe(false)
}, 120000)
