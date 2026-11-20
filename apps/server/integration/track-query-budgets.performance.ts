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

const ExplainJoinWorkSchema = z.object({
  'Actual Loops': z.number(),
  'Rows Removed by Join Filter': z.number().default(0),
  Plans: z.array(z.unknown()).default([]),
})

const ExplainSchema = z.tuple([
  z.object({
    'QUERY PLAN': z.tuple([
      z.object({
        Plan: ExplainJoinWorkSchema.extend({
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

function rejectedJoinRows(plan: unknown): number {
  const parsed = ExplainJoinWorkSchema.parse(plan)
  // PostgreSQL reports the average number of rejected rows per loop.
  return (
    parsed['Rows Removed by Join Filter'] * parsed['Actual Loops'] +
    parsed.Plans.reduce<number>(
      (sum, child) => sum + rejectedJoinRows(child),
      0,
    )
  )
}

// PostgreSQL's root buffer totals include child paths. Hits plus reads
// measure logical work independently of the warmth of the shared cache.
async function checkBudget(
  label: string,
  maxSharedBlocks: number,
  maxStatements: number,
  read: () => Promise<void>,
  maxRejectedJoinRows?: number,
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
  let rejectedRows = 0
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
    if (maxRejectedJoinRows !== undefined)
      rejectedRows += rejectedJoinRows(explain.Plan)
  }
  process.stdout.write(
    `${label}: ${sharedBlocks}/${maxSharedBlocks} shared blocks, ${tempBlocks} temp blocks, ${executionMs.toFixed(1)} ms across ${statementCount}/${maxStatements} statements (${statements.length} explained)\n`,
  )
  expect(sharedBlocks, label + ' shared blocks').toBeLessThanOrEqual(
    maxSharedBlocks,
  )
  expect(tempBlocks, label + ' temp blocks').toBe(0)
  if (maxRejectedJoinRows !== undefined) {
    process.stdout.write(
      `${label}: ${rejectedRows}/${maxRejectedJoinRows} rejected join rows\n`,
    )
    expect(rejectedRows, label + ' rejected join rows').toBeLessThanOrEqual(
      maxRejectedJoinRows,
    )
  }
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

it('bounds hydrated Track pages and exact totals with playlist, current artist tag and rolling listening filters', async () => {
  const {
    queryBrowseCounts,
    queryBrowsePageIds,
    queryBrowsePositions,
    refreshRecordingBrowseOrderForMaintenance,
  } = await import('@/services/browse')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  // Keep these tables empty for the other workloads. Include a stale tag,
  // a tagged non-member and both expired and recent linked listening events.
  // A second playlist isolates two releases of one recording and a tie at
  // the grouped page boundary among a much larger unrelated listening history.
  await pool.query(`
    insert into playlist (id, kind, name) values
      ('fixture-listening-playlist', 'playlist', 'Fixture listening playlist'),
      ('fixture-recording-playlist', 'playlist', 'Fixture recording playlist');
    insert into playlist_item (playlist_id, media_item_id)
    select 'fixture-recording-playlist', id from media_item
    where id in ('track-1', 'track-2', 'track-18001', 'track-19997', 'track-19999', 'track-19996');
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
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    values
      ('fixture-listener', 'fixture-artist', 'fixture-track-1', 'track-1', 'normalized'),
      ('fixture-listener', 'fixture-artist', 'fixture-track-18001', 'track-1', 'normalized');
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    values ('fixture-event-1', 'fixture-listener', statement_timestamp() - interval '2 days',
      'Fixture artist', 'Fixture track 1', 'fixture-artist', 'fixture-track-1');
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
  const period = { kind: 'rolling', amount: 1, unit: 'years' }
  const grouped = TrackQuerySchema.parse({
    groupRecordings: true,
    filters: [
      {
        field: 'playlist',
        value: 'Fixture recording playlist',
        mode: 'required',
      },
    ],
    listening: { match: 'all', rules: [{ period, min: 1 }] },
    listeningSort: period,
    sortBy: 'listeningScrobbles',
    direction: 'desc',
    size: 2,
  })
  await checkBudget(
    'filtered grouped Track page sorted by period plays',
    1_500,
    4,
    async () => {
      const page = await listTrackBrowsePage(grouped)
      expect(
        page.items.map(({ id, listeningScrobbles, recordingGroup }) => [
          id,
          listeningScrobbles,
          recordingGroup?.versionCount,
        ]),
      ).toEqual([
        ['track-1', 21, 2],
        ['track-19997', 20, undefined],
      ])
      expect(page.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'filtered grouped Track page sorted by zero period plays',
    1_500,
    4,
    async () => {
      const page = await listTrackBrowsePage(
        TrackQuerySchema.parse({
          ...grouped,
          direction: 'asc',
          listening: { match: 'all', rules: [{ period, max: 0 }] },
        }),
      )
      expect(
        page.items.map(({ id, listeningScrobbles }) => [
          id,
          listeningScrobbles,
        ]),
      ).toEqual([
        ['track-19996', 0],
        ['track-2', 0],
      ])
      expect(page.hasMore).toBe(false)
    },
  )
  await checkBudget(
    'broad grouped Track page with tied period plays',
    160_000,
    4,
    async () => {
      const page = await listTrackBrowsePage({
        ...grouped,
        filters: [],
        q: 'Fixture track',
      })
      expect(
        page.items.map(({ id, listeningScrobbles }) => [
          id,
          listeningScrobbles,
        ]),
      ).toEqual([
        ['track-1', 21],
        ['track-18982', 20],
      ])
      expect(page.hasMore).toBe(true)
    },
    500_000,
  )
  await pool.query(`
    insert into recording_browse_order_state (singleton, builder, maintenance_only)
    values (true, current_user || ':v1', true)
    on conflict (singleton) do update set maintenance_only = true
  `)
  const lifetime = TrackQuerySchema.parse({
    groupRecordings: true,
    listening: { match: 'all', rules: [{ period, max: 0 }] },
    sortBy: 'scrobbles',
    direction: 'desc',
    size: 6,
  })
  await checkBudget(
    'near lifetime grouped listening page',
    7_800,
    4,
    async () => {
      const page = await listTrackBrowsePage({ ...lifetime, page: 3 })
      expect(page.items.map(({ id }) => id)).toEqual([
        'track-7170',
        'track-8180',
        'track-11008',
        'track-9190',
        'track-10200',
        'track-1211',
      ])
      expect(page.items.map(({ scrobbles }) => scrobbles)).toEqual(
        Array(6).fill(100),
      )
      expect(page.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'deep lifetime grouped listening page',
    18_000,
    4,
    async () => {
      const page = await listTrackBrowsePage({ ...lifetime, page: 1000 })
      expect(page.items.map(({ id }) => id)).toEqual([
        'track-2077',
        'track-12076',
        'track-13995',
        'track-3087',
        'track-10359',
        'track-1370',
      ])
      expect(page.items.map(({ scrobbles }) => scrobbles)).toEqual(
        Array(6).fill(57),
      )
      expect(page.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'filtered first lifetime grouped listening page',
    1_500,
    4,
    async () => {
      const page = await listTrackBrowsePage({
        ...lifetime,
        filters: grouped.filters,
      })
      expect(page.items.map(({ id, scrobbles }) => [id, scrobbles])).toEqual([
        ['track-19996', 99],
        ['track-2', 2],
      ])
      expect(page.hasMore).toBe(false)
    },
  )
  const displayPeriod = TrackQuerySchema.parse({
    listeningSort: { kind: 'rolling', amount: 3, unit: 'years' },
  }).listeningSort
  await checkBudget(
    'near lifetime grouped listening display',
    7_400,
    4,
    async () => {
      const page = await listTrackBrowsePage({
        ...lifetime,
        page: 3,
        listening: undefined,
        listeningSort: grouped.listeningSort,
      })
      expect(
        page.items.map(({ id, scrobbles, listeningScrobbles }) => [
          id,
          scrobbles,
          listeningScrobbles,
        ]),
      ).toEqual([
        ['track-15149', 100, 20],
        ['track-6160', 100, 0],
        ['track-19997', 100, 20],
        ['track-16159', 100, 20],
        ['track-7170', 100, 0],
        ['track-179', 100, 20],
      ])
      expect(page.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'deep lifetime grouped absence and listening display',
    18_000,
    4,
    async () => {
      const page = await listTrackBrowsePage({
        ...lifetime,
        page: 1000,
        listeningSort: grouped.listeningSort,
      })
      expect(
        page.items.map(({ id, listeningScrobbles }) => [
          id,
          listeningScrobbles,
        ]),
      ).toEqual([
        ['track-2077', 0],
        ['track-12076', 0],
        ['track-13995', 0],
        ['track-3087', 0],
        ['track-10359', 0],
        ['track-1370', 0],
      ])
      expect(page.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'filtered first lifetime grouped listening display',
    1_700,
    4,
    async () => {
      const page = await listTrackBrowsePage({
        ...lifetime,
        filters: grouped.filters,
        listening: undefined,
        listeningSort: grouped.listeningSort,
      })
      // Track 1 shares one listening name with its other release and has a second
      // distinct name. The shared name's events contribute only once.
      expect(
        page.items.map(
          ({ id, scrobbles, listeningScrobbles, recordingGroup }) => [
            id,
            scrobbles,
            listeningScrobbles,
            recordingGroup?.versionCount,
          ],
        ),
      ).toEqual([
        ['track-19997', 100, 20, undefined],
        ['track-19996', 99, 0, undefined],
        ['track-1', 21, 21, 2],
        ['track-2', 2, 0, undefined],
        ['track-19999', 1, 20, undefined],
      ])
      expect(page.hasMore).toBe(false)
    },
  )
  await checkBudget(
    'filtered first lifetime grouped absence and listening display',
    1_700,
    4,
    async () => {
      const page = await listTrackBrowsePage({
        ...lifetime,
        filters: grouped.filters,
        listeningSort: displayPeriod,
      })
      expect(
        page.items.map(({ id, scrobbles, listeningScrobbles }) => [
          id,
          scrobbles,
          listeningScrobbles,
        ]),
      ).toEqual([
        ['track-19996', 99, 20],
        ['track-2', 2, 0],
      ])
      expect(page.hasMore).toBe(false)
    },
  )
  expect(await queryBrowseCounts('track', lifetime)).toEqual({
    totalCount: 14_009,
    unfilteredCount: 19_000,
  })
  await checkBudget('filtered exact Track totals', 1_500, 4, async () => {
    expect(await queryBrowseCounts('track', query)).toEqual({
      totalCount: 7,
      unfilteredCount: 20_000,
    })
  })
  // Provide enough expired history to reach a deep page when a second rule
  // requires lifetime plays. Keep some names below the minimum and some
  // within the rolling maximum but above zero.
  await pool.query(`
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'fixture-listener', 'fixture-artist', 'fixture-track-' || n, 'track-' || n, 'normalized'
    from generate_series(1001, 9000) n;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'fixture-expired-' || n || '-' || event, 'fixture-listener',
      case when event > 2 then statement_timestamp() - interval '2 days'
        else statement_timestamp() - interval '2 years' end - event * interval '1 minute',
      'Fixture artist', 'Fixture track ' || n, 'fixture-artist', 'fixture-track-' || n
    from generate_series(1001, 9000) n
    cross join lateral generate_series(1, case when n % 97 = 0 then 5
      when n > 7000 then 1 else 2 end) event;
  `)
  await pool.query('vacuum analyze lastfm_track_link')
  await pool.query('vacuum analyze lastfm_scrobble')
  const twoRules = TrackQuerySchema.parse({
    ...lifetime,
    listening: {
      match: 'all',
      rules: [
        { period, max: 0 },
        { period: { kind: 'all' }, min: 1 },
      ],
    },
  })
  const boundedRules = TrackQuerySchema.parse({
    ...twoRules,
    listening: {
      match: 'all',
      rules: [
        { period, max: 5 },
        { period: { kind: 'all' }, min: 2 },
      ],
    },
  })
  for (const { label, query, maxBlocks, lifetimeCount, ids } of [
    {
      label: 'first lifetime grouped page with two listening rules',
      query: twoRules,
      maxBlocks: 7_800,
      lifetimeCount: 100,
      ids: [
        'track-1009',
        'track-1110',
        'track-2120',
        'track-3130',
        'track-4140',
        'track-5150',
      ],
    },
    {
      label: 'near lifetime grouped page with two listening rules',
      query: { ...twoRules, page: 3 },
      maxBlocks: 7_800,
      lifetimeCount: 100,
      ids: [
        'track-3231',
        'track-4241',
        'track-5251',
        'track-6261',
        'track-7271',
        'track-8281',
      ],
    },
    {
      label: 'deep lifetime grouped page with two listening rules',
      query: { ...twoRules, page: 1100 },
      maxBlocks: 18_000,
      lifetimeCount: 16,
      ids: [
        'track-4258',
        'track-5268',
        'track-1026',
        'track-6278',
        'track-7288',
        'track-7995',
      ],
    },
    {
      label: 'near lifetime grouped page with bounded listening counts',
      query: { ...boundedRules, page: 3 },
      maxBlocks: 7_800,
      lifetimeCount: 100,
      ids: [
        'track-5251',
        'track-6261',
        'track-1312',
        'track-2322',
        'track-3029',
        'track-3332',
      ],
    },
  ]) {
    await checkBudget(label, maxBlocks, 4, async () => {
      const page = await listTrackBrowsePage(query)
      expect(page.items.map(({ id, scrobbles }) => [id, scrobbles])).toEqual(
        ids.map((id) => [id, lifetimeCount]),
      )
      expect(page.hasMore).toBe(true)
    })
  }
  expect(await queryBrowseCounts('track', twoRules)).toEqual({
    totalCount: 7_927,
    unfilteredCount: 19_000,
  })
  expect(await queryBrowseCounts('track', boundedRules)).toEqual({
    totalCount: 6_029,
    unfilteredCount: 19_000,
  })

  // Only one recording has an event in this future date range. Its two
  // editions share the name, so the displayed period count is still one.
  await pool.query(`
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    values ('fixture-future-tie', 'fixture-listener', '2099-05-01 13:00:00',
      'Fixture artist', 'Fixture track 18001', 'fixture-artist', 'fixture-track-18001')
  `)
  await pool.query('vacuum analyze lastfm_scrobble')
  const deep = { ...twoRules, page: 1100 }
  const cold = await listTrackBrowsePage(deep)
  await pool.query(`
    update recording_browse_order_state
    set retry_after = statement_timestamp() - interval '1 second'
  `)
  expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(true)
  await pool.query('vacuum analyze recording_browse_order')
  await pool.query('vacuum analyze recording_browse_order_member')
  await checkBudget(
    'warm deep lifetime grouped page with two listening rules',
    5_400,
    2,
    async () => {
      expect(await listTrackBrowsePage(deep)).toEqual(cold)
    },
  )
  await checkBudget(
    'warm first lifetime grouped page with two listening rules',
    700,
    1,
    async () => {
      const first = await queryBrowsePageIds('track', twoRules)
      expect(first.ids).toEqual([
        'track-1009',
        'track-1110',
        'track-2120',
        'track-3130',
        'track-4140',
        'track-5150',
      ])
      expect(first.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'warm browser-sized first lifetime grouped page with two listening rules',
    5_000,
    1,
    async () => {
      const first = await queryBrowsePageIds('track', {
        ...twoRules,
        size: 100,
      })
      expect(first.ids).toHaveLength(100)
      expect(first.ids.slice(0, 6)).toEqual([
        'track-1009',
        'track-1110',
        'track-2120',
        'track-3130',
        'track-4140',
        'track-5150',
      ])
      expect(first.hasMore).toBe(true)
    },
  )
  await checkBudget(
    'warm near lifetime grouped page with two listening rules',
    900,
    1,
    async () => {
      const near = await queryBrowsePageIds('track', { ...twoRules, page: 3 })
      expect(near.ids).toEqual([
        'track-3231',
        'track-4241',
        'track-5251',
        'track-6261',
        'track-7271',
        'track-8281',
      ])
    },
  )
  await checkBudget(
    'warm browser-sized page ten with two listening rules',
    12_000,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', {
        ...twoRules,
        page: 10,
        size: 100,
      })
      expect(page.ids).toHaveLength(100)
      expect([page.ids[0], page.ids.at(-1)]).toEqual([
        'track-6351',
        'track-6552',
      ])
      expect(page.hasMore).toBe(true)
    },
  )
  for (const { label, date, ids } of [
    { label: 'sparse', date: '2099-05-01', ids: ['track-1'] },
    { label: 'empty', date: '2099-05-02', ids: [] },
  ]) {
    const display = { kind: 'dates', from: date, to: date }
    const query = TrackQuerySchema.parse({
      ...twoRules,
      listening: {
        match: 'all',
        rules: [
          { period: display, min: 1 },
          { period, min: 1 },
        ],
      },
      listeningSort: display,
    })
    await checkBudget(
      `warm ${label} lifetime grouped page with two listening rules`,
      10_000,
      1,
      async () => {
        const page = await queryBrowsePageIds('track', query)
        expect(page.ids).toEqual(ids)
        expect([...(page.listeningScrobbles ?? [])]).toEqual(
          ids.map((id) => [id, 1]),
        )
        expect(page.hasMore).toBe(false)
      },
      500_000,
    )
  }
  await checkBudget(
    'warm lifetime grouped positions with two listening rules',
    5_400,
    1,
    async () => {
      const positions = await queryBrowsePositions(
        'track',
        twoRules,
        [12, 6_594, 6_599],
      )
      expect(positions.map(({ id, position }) => [id, position])).toEqual([
        ['track-3231', 12],
        ['track-4258', 6_594],
        ['track-7995', 6_599],
      ])
    },
  )
  await checkBudget(
    'warm exact lifetime grouped total with two listening rules',
    5_400,
    2,
    async () => {
      expect(await queryBrowseCounts('track', twoRules)).toEqual({
        totalCount: 7_927,
        unfilteredCount: 19_000,
      })
    },
  )
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

it('bounds first Added pages with artist tags and unrelated Last.fm placeholders', async () => {
  const { queryBrowseCount, queryBrowsePageIds, queryBrowsePositions } =
    await import('@/services/browse')
  await pool.query(`
    insert into media_item (id, slug, media_type, title, source_label)
    select 'placeholder-' || n, 'placeholder-' || n, 'track', 'Fixture placeholder ' || n, 'lastfm'
    from generate_series(1, 12000) n;
    insert into library_track (media_item_id, date_added)
    select 'placeholder-' || n, timestamp '2027-01-01' + n * interval '1 second'
    from generate_series(1, 12000) n;
    update library_track set spotify_track_id = 'fixture-peer-' || media_item_id
    where media_item_id in (select 'track-' || n from generate_series(1, 12000) n);
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id, manually_matched)
    select 'fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-visibility-' || n,
      'placeholder-' || n, n = 12000
    from generate_series(1, 12000) n;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-visibility-' || n,
      'track-' || n, 'exact'
    from generate_series(1, 12000) n where n <> 11998;
    update library_track set album_media_item_id = 'album-1' where media_item_id = 'track-20000';
    update library_track set album_media_item_id = 'album-2',
      date_added = (select date_added from library_track where media_item_id = 'track-20000')
      where media_item_id = 'track-19999';
    insert into artist (id, name) values ('visibility-artist', 'Fixture visibility artist');
    insert into media_credit (media_item_id, artist_id, role)
    select id, 'visibility-artist', 'artist'
    from (values ('placeholder-12000'), ('placeholder-11999'), ('placeholder-11998'),
      ('track-20000'), ('track-19999')) targets(id);
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    values ('visibility-profile', 'visibility-artist', 'musicbrainz', '{}',
      '{"tags":["Fixture visibility tag"]}');
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    values ('visibility-artist', 'musicbrainz', 'visibility-profile');
  `)
  for (const table of [
    'media_item',
    'library_track',
    'media_credit',
    'artist_provider_snapshot',
    'artist_provider_current_state',
    'lastfm_track_source',
    'lastfm_track_link',
  ]) {
    await pool.query(`vacuum analyze ${table}`)
  }
  const query = TrackQuerySchema.parse({
    filters: [{ field: 'artistTag', value: 'Fixture visibility tag' }],
    sortBy: 'dateAdded',
    direction: 'desc',
    size: 3,
  })
  await checkBudget('artist-tag first Added page', 1_200, 1, async () => {
    const page = await queryBrowsePageIds('track', query)
    expect(page.ids).toEqual([
      'placeholder-12000',
      'placeholder-11998',
      'track-20000',
    ])
    expect(page.hasMore).toBe(true)
  })
  // The remaining release tied on Added must occupy the next page and
  // retain the same natural order when looked up by position.
  expect(
    (await queryBrowsePageIds('track', { ...query, page: 2 })).ids,
  ).toEqual(['track-19999'])
  expect(await queryBrowsePositions('track', query, [2, 3])).toEqual([
    { id: 'track-20000', position: 2 },
    { id: 'track-19999', position: 3 },
  ])
  // The date index reaches the newer placeholders before any of the
  // 20,000 tracks whose artists carry this tag.
  await pool.query(`
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'broad-visibility-' || id, id, 'discogs', '{}', '{"tags":["Fixture broad visibility tag"]}'
    from artist where id like 'artist-%';
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select artist_id, provider, id from artist_provider_snapshot where id like 'broad-visibility-%';
  `)
  await pool.query('vacuum analyze artist_provider_snapshot')
  await pool.query('vacuum analyze artist_provider_current_state')
  await checkBudget(
    'broad artist-tag first Added page',
    140_000,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', {
        ...query,
        filters: [
          {
            field: 'artistTag',
            value: 'Fixture broad visibility tag',
            mode: 'required',
          },
        ],
      })
      expect(page.ids).toEqual(['track-20000', 'track-19999', 'track-19998'])
      expect(page.hasMore).toBe(true)
    },
    500_000,
  )

  await pool.query(`
    insert into media_credit (media_item_id, artist_id, role)
    values ('track-19997', 'visibility-artist', 'artist');
    update media_item set metadata = '{"legacyHidden":true}' where id = 'track-19997';
  `)
  const sparseCreator = TrackQuerySchema.parse({
    creatorId: 'visibility-artist',
    groupRecordings: false,
    sortBy: 'title',
    direction: 'asc',
    size: 100,
  })
  await checkBudget(
    'sparse creator Track title page',
    800,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', sparseCreator)
      expect(page.ids).toEqual([
        'placeholder-11998',
        'placeholder-12000',
        'track-19999',
        'track-20000',
      ])
      expect(page.hasMore).toBe(false)
    },
    500_000,
  )
  await checkBudget(
    'sparse creator Track exact count',
    800,
    3,
    async () => {
      expect(await queryBrowseCount('track', sparseCreator)).toEqual({
        totalCount: 4,
      })
    },
    500_000,
  )

  await checkBudget(
    'sparse creator Track plays page',
    800,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', {
        ...sparseCreator,
        sortBy: 'scrobbles',
        direction: 'desc',
        size: 5,
      })
      expect(page.ids).toEqual([
        'track-20000',
        'track-19999',
        'placeholder-11998',
        'placeholder-12000',
      ])
      expect(page.hasMore).toBe(false)
    },
    500_000,
  )
  const sourceRows = TrackQuerySchema.parse({
    ...sparseCreator,
    filters: [{ field: 'source', value: 'Last.fm', mode: 'required' }],
  })
  expect((await queryBrowsePageIds('track', sourceRows)).ids).toEqual([
    'placeholder-11998',
    'placeholder-11999',
    'placeholder-12000',
  ])
  expect(await queryBrowseCount('track', sourceRows)).toEqual({ totalCount: 3 })
  // Include two equal titles across the page boundary. Natural release
  // order places the higher ID first, so truncating on ID would skip it.
  await pool.query(`
    insert into artist (id, name) values ('fixture-populous-creator', 'Fixture populous creator');
    insert into media_credit (media_item_id, artist_id, role)
    select 'track-' || n, 'fixture-populous-creator', 'artist' from generate_series(4001, 8000) n;
    update media_item set title = 'Fixture track 04100' where id = 'track-4101';
    update library_track set album_media_item_id = 'album-999' where media_item_id = 'track-4100';
    update library_track set album_media_item_id = 'album-1' where media_item_id = 'track-4101';
  `)
  await pool.query('vacuum analyze media_credit')
  await pool.query('vacuum analyze media_item')
  await pool.query('vacuum analyze library_track')
  const populousCreator = {
    ...sparseCreator,
    creatorId: 'fixture-populous-creator',
  }
  await checkBudget(
    'populous creator Track title page',
    24_000,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', populousCreator)
      expect(page.ids).toEqual([
        ...Array.from({ length: 99 }, (_, index) => `track-${4001 + index}`),
        'track-4101',
      ])
      expect(page.hasMore).toBe(true)
    },
    500_000,
  )
  expect(await queryBrowseCount('track', populousCreator)).toEqual({
    totalCount: 4_000,
  })

  // Exercise global duplicate visibility through a first title page. A
  // placeholder remains visible if any of its source names must be retained.
  await pool.query(`
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id, manually_matched) values
      ('fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-manual-extra', 'placeholder-11997', true),
      ('fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-uncovered-extra', 'placeholder-11996', false),
      ('fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-covered-extra', 'placeholder-11995', false);
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
      ('fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-manual-extra', 'track-11997', 'exact'),
      ('fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-visibility-11995', 'track-13000', 'exact'),
      ('fixture-visibility-listener', 'fixture-visibility-artist', 'fixture-covered-extra', 'track-11995', 'exact');
    update library_track set spotify_track_id = 'fixture-hidden-peer' where media_item_id = 'track-13000';
    update media_item set metadata = '{"legacyHidden":true}' where id in ('track-11994', 'track-13000');
    update lastfm_track_link set strategy = 'normalized' where track_media_item_id = 'track-11993';
  `)
  for (const table of [
    'library_track',
    'lastfm_track_link',
    'lastfm_track_source',
    'media_item',
  ])
    await pool.query(`vacuum analyze ${table}`)
  const titlePage = TrackQuerySchema.parse({
    groupRecordings: false,
    sortBy: 'title',
    direction: 'asc',
    size: 100,
  })
  const retained = [11993, 11994, 11996, 11997, 11998, 12000]
  await checkBudget(
    'global Track title page with dense duplicate matches',
    320_000,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', titlePage)
      expect(page.ids).toHaveLength(100)
      expect(page.ids.filter((id) => id.startsWith('placeholder-'))).toEqual(
        retained.map((index) => `placeholder-${index}`),
      )
      expect(page.hasMore).toBe(true)
    },
    500_000,
  )

  await pool.query(`
    update library_track set album_name = 'Fixture existing album label'
    where media_item_id in (select 'placeholder-' || n from generate_series(129, 12000) n)
  `)
  await pool.query('vacuum analyze library_track')
  const higherPlaceholderIds = Array.from(
    { length: 11_872 },
    (_, index) => 129 + index,
  )
  await checkBudget(
    'global Track title page with sparse eligible source names',
    8_000,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', titlePage)
      expect(page.ids).toEqual(
        higherPlaceholderIds
          .map((index) => `placeholder-${index}`)
          .sort()
          .slice(0, 100),
      )
      expect(page.hasMore).toBe(true)
    },
    500_000,
  )

  await pool.query(`
    update library_track set album_name = null where media_item_id like 'placeholder-%';
    update lastfm_track_link set strategy = 'normalized'
    where track_media_item_id in (select 'track-' || n from generate_series(129, 11989) n)
  `)
  await pool.query('vacuum analyze library_track')
  await pool.query('vacuum analyze lastfm_track_link')
  await checkBudget(
    'global Track title page with sparse exact peers',
    240_000,
    1,
    async () => {
      const page = await queryBrowsePageIds('track', titlePage)
      expect(page.ids).toEqual(
        higherPlaceholderIds
          .filter((index) => index < 11990 || retained.includes(index))
          .map((index) => `placeholder-${index}`)
          .sort()
          .slice(0, 100),
      )
      expect(page.hasMore).toBe(true)
    },
    500_000,
  )
})

it('bounds the Spotify alternate lookup for detail on a common track title', async () => {
  const { getTrackDetail } = await import('@/services/tracks')
  // These tracks share a title across many artists. An earlier playable
  // release also shares the ISRC and one artist with the target.
  await pool.query(`
    update media_item set title = 'Fixture Intro'
    where id in (select 'track-' || n from generate_series(1, 9000) n);
    update media_item set title = ' Fixture   INTRO ' where id = 'track-18001';
    update library_track set spotify_track_id = null where media_item_id = 'track-1';
    update library_track set spotify_track_id = 'ZZZFixture000000000001',
      album_media_item_id = 'album-2' where media_item_id = 'track-18001';
    update library_track set spotify_track_id = 'ZZZFixture000000000002',
      album_media_item_id = 'album-1',
      isrc = (select isrc from library_track where media_item_id = 'track-1')
      where media_item_id = 'track-1001';
    insert into media_credit (media_item_id, artist_id, role, billing_order)
    values ('track-1001', 'artist-2', 'artist', 1);
  `)
  await pool.query('vacuum analyze media_item')
  await checkBudget('Track detail for a common title', 1_500, 4, async () => {
    const detail = await getTrackDetail('track-1')
    expect(detail?.spotifyTrackId).toBeNull()
    expect(detail?.spotifyAlternate?.trackId).toBe('track-18001')
    expect(detail?.spotifyAlternate?.identifier).toBe('ZZZFixture000000000001')
  })
})
