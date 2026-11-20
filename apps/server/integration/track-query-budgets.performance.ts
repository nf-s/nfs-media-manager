import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { trackBrowseFields } from '@repo/schemas/browse'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = 'track_query_budgets_' + randomUUID().replaceAll('-', '')
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
  options: '-c jit=off -c timezone=UTC -c work_mem=16MB',
  statement_timeout: 30_000,
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
      throw new Error('Network requests are forbidden in performance tests')
    }),
  )
  await admin.connect()
  await admin.query('create database ' + name)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
  // One thousand recordings have a second release. Ten selective titles are
  // placed at the end of the library and each has a distinct artist credit.
  await pool.query(`
    insert into artist (id, name)
    select 'artist-' || n, 'Fixture artist ' || n from generate_series(1, 1000) n;
    insert into media_item (id, slug, media_type, title, release_date)
    select 'album-' || n, 'album-' || n, 'album', 'Fixture album ' || n,
      timestamp '2020-01-01' + n * interval '1 day'
    from generate_series(1, 1000) n;
    insert into album (media_item_id) select id from media_item where media_type = 'album';
    insert into media_item (id, slug, media_type, title, release_date)
    select 'track-' || n, 'track-' || n, 'track',
      case when n > 19990 then 'Quicksilver ' else 'Fixture track ' end ||
        lpad((case when n between 18001 and 19000 then n - 18000 else n end)::text, 5, '0'),
      timestamp '2020-01-01' + n * interval '1 day'
    from generate_series(1, 20000) n;
    insert into library_track (media_item_id, album_media_item_id, album_name, date_added, duration_sec, scrobble_count, isrc)
    select 'track-' || n, 'album-' || (1 + (n + n / 1000) % 1000),
      'Fixture album ' || (1 + (n + n / 1000) % 1000),
      timestamp '2024-01-01' + n * interval '1 hour',
      150 + n % 30, n % 101,
      'ZZFIX26' || lpad((case when n between 18001 and 19000 then n - 18000 else n end)::text, 5, '0')
    from generate_series(1, 20000) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'track-' || n, 'artist-' || ((n - 1) % 1000 + 1), 'artist'
    from generate_series(1, 20000) n;
  `)
  for (const table of [
    'artist',
    'media_item',
    'album',
    'library_track',
    'media_credit',
  ]) {
    await pool.query(`vacuum analyze ${table}`)
  }
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.unstubAllGlobals()
})

const ExplainSchema = z.tuple([
  z.object({
    'QUERY PLAN': z.tuple([
      z.object({
        Plan: z.object({
          'Shared Hit Blocks': z.number(),
          'Shared Read Blocks': z.number(),
          'Temp Read Blocks': z.number(),
          'Temp Written Blocks': z.number(),
        }),
        'Execution Time': z.number(),
      }),
    ]),
  }),
])

// PostgreSQL's root buffer totals include child paths. Hits plus reads
// measure logical work independently of the warmth of the shared cache.
async function checkBudget(
  label: string,
  maxSharedBlocks: number,
  maxStatements: number,
  read: () => Promise<void>,
) {
  logQuery.mockClear()
  await read()
  const statements = logQuery.mock.calls.filter(([query]) =>
    /^\s*(select|with)\b/i.test(query),
  )
  expect(statements.length, label).toBeGreaterThan(0)
  const statementCount = logQuery.mock.calls.length
  expect(statementCount, label + ' statements').toBeLessThanOrEqual(
    maxStatements,
  )

  let sharedBlocks = 0
  let tempBlocks = 0
  let executionMs = 0
  for (const [query, params] of statements) {
    const result = await pool.query(
      `explain (analyze, buffers, timing off, format json) ${query}`,
      params,
    )
    const explain = ExplainSchema.parse(result.rows)[0]['QUERY PLAN'][0]
    sharedBlocks +=
      explain.Plan['Shared Hit Blocks'] + explain.Plan['Shared Read Blocks']
    tempBlocks +=
      explain.Plan['Temp Read Blocks'] + explain.Plan['Temp Written Blocks']
    executionMs += explain['Execution Time']
  }
  process.stdout.write(
    `${label}: ${sharedBlocks}/${maxSharedBlocks} shared blocks, ${tempBlocks} temp blocks, ${executionMs.toFixed(1)} ms across ${statementCount}/${maxStatements} statements (${statements.length} explained)\n`,
  )
  expect(sharedBlocks, label + ' shared blocks').toBeLessThanOrEqual(
    maxSharedBlocks,
  )
  expect(tempBlocks, label + ' temp blocks').toBe(0)
}

it('bounds selective Track pages and exact counts', async () => {
  const { queryBrowsePageIds, queryBrowseCount } =
    await import('@/services/browse')
  const query = TrackQuerySchema.parse({ q: 'quicksilver', size: 5 })
  await checkBudget('selective Track page', 1_200, 1, async () => {
    const page = await queryBrowsePageIds('track', query)
    expect(page.ids).toHaveLength(5)
    expect(page.hasMore).toBe(true)
  })
  await checkBudget('selective Track count', 1_500, 3, async () => {
    expect(await queryBrowseCount('track', query)).toEqual({ totalCount: 10 })
  })
})

it('bounds unfiltered Track pages and deep positions', async () => {
  const { queryBrowsePageIds, queryBrowsePositions } =
    await import('@/services/browse')
  await checkBudget('unfiltered Track page', 800, 1, async () => {
    const page = await queryBrowsePageIds(
      'track',
      TrackQuerySchema.parse({ size: 50 }),
    )
    expect(page.ids).toHaveLength(50)
    expect(page.ids[0]).toBe('track-20000')
  })
  const query = TrackQuerySchema.parse({ sortBy: 'title', page: 390, size: 50 })
  await checkBudget('deep Track page', 2_100, 1, async () => {
    const page = await queryBrowsePageIds('track', query)
    expect(page.ids).toHaveLength(50)
    expect(page.hasMore).toBe(true)
    expect([page.ids[0], page.ids[49]]).toEqual(['track-275', 'track-18251'])
  })
  await checkBudget('deep Track positions', 1_900, 1, async () => {
    expect(
      await queryBrowsePositions('track', query, [19_450, 19_499]),
    ).toEqual([
      { id: 'track-275', position: 19_450 },
      { id: 'track-18251', position: 19_499 },
    ])
  })
})

it('bounds grouped Track pages and exact counts', async () => {
  const { queryBrowsePageIds, queryBrowseCount } =
    await import('@/services/browse')
  const query = TrackQuerySchema.parse({ groupRecordings: true, size: 50 })
  await checkBudget('grouped Track page', 5_600, 3, async () => {
    const page = await queryBrowsePageIds('track', query)
    expect(page.ids).toHaveLength(50)
    expect(page.hasMore).toBe(true)
  })
  await checkBudget('grouped Track count', 2_500, 3, async () => {
    expect(await queryBrowseCount('track', query)).toEqual({
      totalCount: 19_000,
    })
  })

  const byScrobbles = TrackQuerySchema.parse({ ...query, sortBy: 'scrobbles' })
  await queryBrowsePageIds('track', byScrobbles)
  await pool.query('vacuum analyze recording_browse_order')
  await checkBudget('stored grouped scrobble page', 20, 1, async () => {
    const page = await queryBrowsePageIds('track', { ...byScrobbles, page: 2 })
    expect(page.ids).toHaveLength(50)
    expect(page.hasMore).toBe(true)
  })
  await checkBudget('stored grouped scrobble count', 10, 1, async () => {
    expect(await queryBrowseCount('track', byScrobbles)).toEqual({
      totalCount: 19_000,
    })
  })
})

it('bounds selective live and broad stored Track autocomplete', async () => {
  const { listBrowseFacets } = await import('@/services/browse')
  await checkBudget('selective live Track autocomplete', 1_100, 4, async () => {
    const facets = await listBrowseFacets('track', { q: 'quicksilver' })
    expect(facets.filter(({ field }) => field === 'title')).toHaveLength(10)
  })
  await pool.query(`
    insert into track_facet_state (singleton, builder, maintenance_only)
    values (true, current_user, true)
    on conflict (singleton) do update set maintenance_only = true
  `)
  await checkBudget('broad live Track autocomplete', 3_800, 8, async () => {
    const facets = await listBrowseFacets('track', { q: 'f' })
    expect(facets.find(({ field }) => field === 'title')?.count).toBe(2)
  })
  await pool.query('delete from track_facet_state')

  // A focus request builds the stored vocabulary. Then a different request
  // exercises the database vocabulary path without the exact-input cache.
  await listBrowseFacets('track')
  await pool.query('vacuum analyze track_facet_value')
  await checkBudget('broad stored Track autocomplete', 350, 3, async () => {
    const facets = await listBrowseFacets('track', { q: 'fixture' })
    expect(facets.find(({ field }) => field === 'title')?.count).toBe(2)
  })
})

it('bounds a hydrated Track page and exact total with playlist, current artist tag and rolling listening filters', async () => {
  const { queryBrowseCounts } = await import('@/services/browse')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  // Keep these tables empty for the other workloads. Include a stale tag,
  // a tagged non-member and both expired and recent linked listening events.
  await pool.query(`
    insert into playlist (id, kind, name) values
      ('fixture-listening-playlist', 'playlist', 'Fixture listening playlist');
    insert into playlist_item (playlist_id, media_item_id)
    select 'fixture-listening-playlist', 'track-' || n
    from generate_series(19900, 20000) n where n <> 19996;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'fixture-listening-tag-' || n, 'artist-' || n, 'musicbrainz', '{}',
      case when n = 995 then '{}'
        else '{"tags":["Fixture listening tag"]}' end::jsonb
    from generate_series(990, 1000) n;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    values ('fixture-stale-tag', 'artist-995', 'musicbrainz', '{}',
      '{"tags":["Fixture listening tag"]}');
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select 'artist-' || n, 'musicbrainz', 'fixture-listening-tag-' || n
    from generate_series(990, 1000) n;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'fixture-listener', 'fixture-artist', 'fixture-track-' || n, 'track-' || n, 'name'
    from generate_series(15001, 20000) n;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'fixture-event-' || n || '-' || event, 'fixture-listener',
      (case when n in (19997, 19999) or n < 19990 then statement_timestamp() - interval '2 days'
        else statement_timestamp() - interval '2 years' end) - event * interval '1 minute',
      'Fixture artist', 'Fixture track ' || n, 'fixture-artist', 'fixture-track-' || n
    from generate_series(15001, 20000) n cross join generate_series(1, 20) event;
  `)
  for (const table of [
    'playlist',
    'playlist_item',
    'artist_provider_snapshot',
    'artist_provider_current_state',
    'lastfm_track_link',
    'lastfm_scrobble',
  ]) {
    await pool.query(`vacuum analyze ${table}`)
  }
  const query = TrackQuerySchema.parse({
    filters: [
      {
        field: 'playlist',
        value: 'Fixture listening playlist',
        mode: 'required',
      },
      { field: 'artistTag', value: 'Fixture listening tag' },
    ],
    listening: {
      match: 'all',
      rules: [
        { period: { kind: 'rolling', amount: 1, unit: 'years' }, max: 0 },
      ],
    },
    sortBy: 'dateAdded',
    direction: 'desc',
    size: 5,
  })
  await checkBudget('filtered hydrated Track page', 1_500, 2, async () => {
    const page = await listTrackBrowsePage(query)
    expect(page.items.map(({ id }) => id)).toEqual([
      'track-20000',
      'track-19998',
      'track-19994',
      'track-19993',
      'track-19992',
    ])
    expect(page.items[0]?.artistTags).toEqual(['Fixture listening tag'])
    expect(page.items[0]?.playlists).toEqual([
      {
        id: 'fixture-listening-playlist',
        name: 'Fixture listening playlist',
      },
    ])
    expect(page.hasMore).toBe(true)
  })
  await checkBudget('filtered exact Track totals', 1_500, 4, async () => {
    expect(await queryBrowseCounts('track', query)).toEqual({
      totalCount: 7,
      unfilteredCount: 20_000,
    })
  })
})

it('bounds live Track autocomplete on shared artist and album tags', async () => {
  const { listBrowseFacets } = await import('@/services/browse')
  await pool.query(`
    update library_track
    set album_media_item_id = 'album-' || ((substring(media_item_id from 7)::int - 1) % 1000 + 1);

    insert into tag (id, media_type, name, kind)
    select 'tag-rich-' || n, 'album', 'Fixture Genre ' || lpad(n::text, 2, '0'), 'genre'
    from generate_series(1, 64) n;
    insert into tag (id, media_type, name, kind, hidden) values
      ('tag-rich-parent', 'album', 'Fixture Parent', 'genre', false),
      ('tag-rich-alias', 'album', 'Original Fixture Label', 'genre', true),
      ('tag-rich-hidden', 'album', 'Hidden Fixture Label', 'genre', true);
    insert into tag_alias (source_tag_id, target_tag_id) values ('tag-rich-alias', 'tag-rich-1');
    insert into tag_identity (media_type, normalized_name, kind, tag_id)
    values ('album', 'original fixture label', 'genre', 'tag-rich-1');
    insert into tag_parent (media_type, child_key, parent_key)
    values ('album', 'fixture genre 01', 'fixture parent');
    insert into tag_ancestor (media_type, descendant_key, ancestor_key)
    values ('album', 'fixture genre 01', 'fixture parent');
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'tag-rich-' || label
    from generate_series(1, 1000) n
    cross join lateral generate_series(1, case when n % 2 = 0 then 32 else 1 end) label;
    insert into media_item_tag (media_item_id, tag_id)
    values ('album-1', 'tag-rich-hidden');

    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'facet-profile-' || n, 'artist-' || n, 'lastfm', '{}',
      jsonb_build_object('tags', (select jsonb_agg('Fixture Genre ' || lpad(label::text, 2, '0'))
        from generate_series(2, 48) label)
        || jsonb_build_array(
          case when n % 2 = 1 then 'Original Fixture Label' else 'Fixture Genre 01' end,
          'Hidden Fixture Label'
        ))
    from generate_series(1, 1000) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select 'artist-' || n, 'lastfm', 'facet-profile-' || n
    from generate_series(1, 1000) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'track-' || n, 'artist-' || (n % 1000 + 1), 'artist'
    from generate_series(1, 20000) n where n % 2 = 0;

    insert into media_item (id, slug, media_type, title, source_label, metadata) values
      ('retained-facet-source', 'retained-facet-source', 'track', 'Fixture Retained', 'lastfm', '{}'),
      ('archived-facet-track', 'archived-facet-track', 'track', 'Fixture Archived', null, '{"legacyHidden":true}');
    insert into library_track (media_item_id) values ('retained-facet-source'), ('archived-facet-track');
    update library_track set spotify_track_id = 'fixture-spotify-track' where media_item_id = 'track-1';
    insert into media_credit (media_item_id, artist_id, role) values
      ('retained-facet-source', 'artist-1', 'artist'), ('archived-facet-track', 'artist-1', 'artist');
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    values ('fixture-listener', 'retained-artist', 'retained-recording', 'retained-facet-source');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    values ('fixture-listener', 'retained-artist', 'retained-recording', 'track-1', 'exact');

    insert into track_facet_state (singleton, builder, maintenance_only)
    values (true, current_user, true)
    on conflict (singleton) do update set maintenance_only = true;
  `)
  for (const table of [
    'library_track',
    'media_credit',
    'tag',
    'media_item_tag',
    'artist_provider_snapshot',
    'artist_provider_current_state',
  ]) {
    await pool.query(`vacuum analyze ${table}`)
  }

  await checkBudget(
    'tag-rich broad live Track autocomplete',
    8_000,
    9,
    async () => {
      const facets = await listBrowseFacets('track', {
        q: 'e',
        limitPerField: 50,
      })
      const count = (field: string, value: string) =>
        facets.find((row) => row.field === field && row.value === value)?.count
      expect(count('albumTag', 'fixture genre 01')).toBe(20_000)
      expect(count('albumTag', 'fixture genre 02')).toBe(10_000)
      expect(count('artistTag', 'fixture genre 01')).toBe(20_000)
      expect(count('artistTag', 'fixture genre 48')).toBe(20_000)
      expect(count('genre', 'fixture genre 02')).toBe(20_000)
      expect(count('genre', 'fixture genre 48')).toBe(10_000)
      expect(count('genre', 'fixture parent')).toBe(20_000)
      expect(count('artistTag', 'original fixture label')).toBeUndefined()
      expect(count('artistTag', 'hidden fixture label')).toBeUndefined()
    },
  )
  await checkBudget(
    'tag-rich selective live Track autocomplete',
    4_500,
    5,
    async () => {
      const facets = await listBrowseFacets('track', { q: 'Genre 48' })
      expect(
        facets.map(({ field, value, count }) => ({ field, value, count })),
      ).toEqual([
        { field: 'artistTag', value: 'fixture genre 48', count: 20_000 },
        { field: 'genre', value: 'fixture genre 48', count: 10_000 },
      ])
    },
  )
  const retainedFacets = await listBrowseFacets(
    'track',
    { q: 'Genre 48' },
    {
      includeLastfmSourceRows: true,
      fields: trackBrowseFields.filter(
        ({ key }) => key === 'artistTag' || key === 'genre',
      ),
    },
  )
  expect(
    retainedFacets.map(({ field, value, count }) => ({ field, value, count })),
  ).toEqual([
    { field: 'artistTag', value: 'fixture genre 48', count: 20_001 },
    { field: 'genre', value: 'fixture genre 48', count: 10_001 },
  ])
})
