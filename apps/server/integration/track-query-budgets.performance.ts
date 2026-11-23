import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { albumBrowseFields, trackBrowseFields } from '@repo/schemas/browse'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { TrackQuerySchema, type TrackQuery } from '@repo/schemas/tracks'
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
async function checkBudget<T>(
  label: string,
  maxSharedBlocks: number,
  maxStatements: number,
  read: () => Promise<T>,
  maxRejectedJoinRows?: number,
) {
  logQuery.mockClear()
  const observed = await read()
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
  return observed
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

it('uses the Track title index for exact title filters', async () => {
  const { queryBrowsePageIds } = await import('@/services/browse')
  const title = 'Fixture  "Exact" (Title)?'
  await pool.query('update media_item set title = $1 where id = $2', [
    title,
    'track-19999',
  ])
  try {
    for (const { label, value, ids } of [
      { label: 'hit', value: title.toLowerCase(), ids: ['track-19999'] },
      { label: 'different spaces', value: 'Fixture "Exact" (Title)?', ids: [] },
      {
        label: 'different punctuation',
        value: 'Fixture  "Exact" (Title)!',
        ids: [],
      },
    ]) {
      const query = TrackQuerySchema.parse({
        filters: [{ field: 'title', value, mode: 'required' }],
        sortBy: 'title',
        direction: 'asc',
        size: 100,
      })
      await checkBudget(`exact Track title ${label}`, 100, 1, async () => {
        const page = await queryBrowsePageIds('track', query)
        expect(page.ids).toEqual(ids)
        expect(page.hasMore).toBe(false)
      })
    }
  } finally {
    await pool.query('update media_item set title = $1 where id = $2', [
      'Quicksilver 19999',
      'track-19999',
    ])
  }
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

it('bounds first Track pages sorted by unindexed fields after filtering', async () => {
  const { queryBrowsePageIds, queryBrowsePositions } =
    await import('@/services/browse')
  const tables = [
    'artist',
    'artist_provider_current_state',
    'artist_provider_snapshot',
    'media_item',
    'library_track',
    'media_credit',
    'track',
    'playlist',
    'playlist_item',
  ]
  try {
    await pool.query(`
    insert into artist (id, name) values
      ('sort-artist-a', 'Fixture sort Alpha'),
      ('sort-artist-z', 'Fixture sort Zulu'),
      ('sort-artist-primary', 'Zulu fixture regular'),
      ('sort-artist-top', 'Zulu fixture top'),
      ('sort-artist-secondary', 'Zulu fixture zz'),
      ('sort-artist-search', 'Alpha fixture');
    insert into media_item (id, slug, media_type, title, release_date) values
      ('sort-album-a', 'sort-album-a', 'album', 'Zulu fixture regular', '2080-01-01'),
      ('sort-album-z', 'sort-album-z', 'album', 'Zulu fixture regular', '2080-01-01'),
      ('sort-album-top', 'sort-album-top', 'album', 'Zulu fixture top', '2080-01-02');
    insert into album (media_item_id) values ('sort-album-a'), ('sort-album-z'), ('sort-album-top');
    insert into media_credit (media_item_id, artist_id, role) values
      ('sort-album-a', 'sort-artist-a', 'artist'),
      ('sort-album-z', 'sort-artist-z', 'artist');
    insert into media_credit (media_item_id, artist_id, role)
    select 'album-' || n, 'sort-artist-a', 'artist' from generate_series(1, 1000) n;
    insert into track (id, track_media_item_id, album_media_item_id, title, position)
    select 'fixture-sort-release-' || n, lt.media_item_id, lt.album_media_item_id,
      mi.title, 10000 + n
    from generate_series(1, 20000) n
    join library_track lt on lt.media_item_id = 'track-' || n
    join media_item mi on mi.id = lt.media_item_id;

    insert into media_item (id, slug, media_type, title, metadata)
    select id, id, 'track', title, metadata
    from (values ('sort-track-1', 'Fixture first title', null::jsonb),
      ('sort-track-2', 'Fixture second title', null),
      ('sort-track-3', 'Fixture third title', null),
      ('sort-track-4', 'Fixture fourth title', null),
      ('sort-track-top', 'Fixture top title', null),
      ('sort-track-search', 'Track matchedneedle', null),
      ('sort-track-without-artist', 'Fixture no artist', null),
      ('sort-track-archived', 'Fixture archived title', '{"legacyHidden":true}')) rows(id, title, metadata);
    insert into library_track (media_item_id, album_media_item_id, duration_sec) values
      ('sort-track-1', 'sort-album-z', 180),
      ('sort-track-2', 'sort-album-a', 180),
      ('sort-track-3', 'sort-album-z', null),
      ('sort-track-4', 'sort-album-z', 180),
      ('sort-track-top', 'sort-album-top', 181),
      ('sort-track-search', null, 149),
      ('sort-track-without-artist', null, 180),
      ('sort-track-archived', 'sort-album-top', 182);
    insert into media_credit (media_item_id, artist_id, role, billing_order)
    select id, 'sort-artist-primary', 'artist', 0 from media_item where id in
      ('sort-track-1', 'sort-track-2', 'sort-track-3', 'sort-track-4')
    union all
    select id, 'sort-artist-top', 'artist', 0 from media_item where id in
      ('sort-track-top', 'sort-track-archived');
    insert into media_credit (media_item_id, artist_id, role, billing_order) values
      ('sort-track-1', 'sort-artist-secondary', 'artist', 0),
      ('sort-track-2', 'sort-artist-secondary', 'artist', 1),
      ('sort-track-search', 'sort-artist-search', 'artist', 0);
    insert into track (id, track_media_item_id, album_media_item_id, title, position, duration_sec) values
      ('sort-release-1', 'sort-track-1', 'sort-album-z', 'Fixture first title', 3, 180),
      ('sort-release-3', 'sort-track-3', 'sort-album-z', 'Fixture third title', 1, 180),
      ('sort-release-4', 'sort-track-4', 'sort-album-z', 'Fixture fourth title', 2, 180);

    insert into playlist (id, name, kind) values
      ('sort-playlist-top', 'Zulu fixture top', 'playlist'),
      ('sort-playlist-regular', 'Zulu fixture regular', 'playlist');
    insert into playlist_item (playlist_id, media_item_id)
    select 'sort-playlist-regular', id from media_item where id in
      ('sort-track-1', 'sort-track-2', 'sort-track-3', 'sort-track-4')
    union all
    select 'sort-playlist-top', id from media_item where id in
      ('sort-track-top', 'sort-track-archived');

    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'fixture-sort-snapshot-' || n, 'artist-' || n, 'musicbrainz', '{}',
      jsonb_build_object('tags', jsonb_build_array('Fixture search tag', 'Fixture style ' || n))
    from generate_series(1, 1000) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select artist_id, provider, id from artist_provider_snapshot where id like 'fixture-sort-snapshot-%';
  `)
    for (const table of tables) await pool.query(`vacuum analyze ${table}`)

    const query = TrackQuerySchema.parse({
      groupRecordings: false,
      sortBy: 'durationSec',
      direction: 'desc',
      ranges: [{ field: 'durationSec', min: 150, max: 182 }],
      size: 3,
    })
    const firstFive = [
      'sort-track-top',
      'sort-track-2',
      'sort-track-3',
      'sort-track-4',
      'sort-track-1',
    ]
    const budgets = {
      durationSec: 12_000,
      artist: 15_000,
      album: 80_000,
      releaseDate: 80_000,
      playlist: 225_000,
    }
    for (const [sortBy, maxBlocks] of Object.entries(budgets)) {
      await checkBudget(
        `broad filtered Track ${sortBy} page`,
        maxBlocks,
        1,
        async () => {
          const page = await queryBrowsePageIds('track', {
            ...query,
            sortBy,
            size: 100,
          })
          expect(page.ids).toHaveLength(100)
          expect(page.ids.slice(0, 5)).toEqual(firstFive)
          expect(page.hasMore).toBe(true)
        },
      )
    }

    // The first page ends inside a primary tie. Artist and track-list order
    // decide which tied tracks appear, including one that inherits its duration.
    expect((await queryBrowsePageIds('track', query)).ids).toEqual(
      firstFive.slice(0, 3),
    )
    expect(
      (await queryBrowsePageIds('track', { ...query, page: 2 })).ids.slice(
        0,
        2,
      ),
    ).toEqual(['sort-track-4', 'sort-track-1'])
    expect(await queryBrowsePositions('track', query, [2, 3, 4])).toEqual([
      { id: 'sort-track-3', position: 2 },
      { id: 'sort-track-4', position: 3 },
      { id: 'sort-track-1', position: 4 },
    ])
    const narrowQuery = TrackQuerySchema.parse({
      ...query,
      ranges: [{ field: 'durationSec', min: 180, max: 182 }],
    })
    const capped = await queryBrowsePageIds('track', {
      ...narrowQuery,
      limitResults: 2,
    })
    expect(capped.ids).toEqual(['sort-track-top', 'sort-track-2'])
    expect(capped.hasMore).toBe(false)
    const last = await queryBrowsePageIds('track', { ...narrowQuery, page: 2 })
    expect(last.ids).toEqual([
      'sort-track-4',
      'sort-track-1',
      'sort-track-without-artist',
    ])
    expect(last.hasMore).toBe(false)
    // Equal billing orders use the artist's name. Tracks with no artist sort last.
    await checkBudget(
      'sparse filtered Track artist page',
      7_000,
      1,
      async () => {
        const page = await queryBrowsePageIds('track', {
          ...narrowQuery,
          sortBy: 'artist',
          direction: 'asc',
          size: 100,
        })
        expect(page.ids).toEqual([
          ...firstFive.slice(1),
          'sort-track-top',
          'sort-track-without-artist',
        ])
        expect(page.hasMore).toBe(false)
      },
    )
    const missing = await queryBrowsePageIds('track', {
      ...query,
      ranges: [{ field: 'durationSec', min: 182 }],
    })
    expect(missing.ids).toEqual([])
    expect(missing.hasMore).toBe(false)

    const textQuery = TrackQuerySchema.parse({
      q: 'fixture track',
      sortBy: 'artist',
      direction: 'asc',
      size: 100,
    })
    await checkBudget(
      'broad multiword Track artist page',
      90_000,
      1,
      async () => {
        const page = await queryBrowsePageIds('track', textQuery)
        expect(page.ids).toHaveLength(100)
        expect(page.ids[0]).toBe('sort-track-search')
        expect(page.hasMore).toBe(true)
      },
    )
    await checkBudget(
      'sparse multiword Track artist page',
      85_000,
      1,
      async () => {
        const page = await queryBrowsePageIds('track', {
          ...textQuery,
          q: 'fixture matchedneedle',
        })
        expect(page.ids).toEqual(['sort-track-search'])
        expect(page.hasMore).toBe(false)
      },
    )
    await checkBudget(
      'empty multiword Track artist page',
      1_000,
      1,
      async () => {
        const page = await queryBrowsePageIds('track', {
          ...textQuery,
          q: 'fixture unmatchedneedle',
        })
        expect(page.ids).toEqual([])
        expect(page.hasMore).toBe(false)
      },
    )
  } finally {
    await pool.query(`
      delete from artist_provider_current_state where latest_snapshot_id like 'fixture-sort-snapshot-%';
      delete from artist_provider_snapshot where id like 'fixture-sort-snapshot-%';
      delete from track where id like 'fixture-sort-release-%' or id like 'sort-release-%';
      delete from playlist where id like 'sort-playlist-%';
      delete from media_item where id like 'sort-track-%';
      delete from media_item where id like 'sort-album-%';
      delete from artist where id like 'sort-artist-%';
    `)
    for (const table of tables) await pool.query(`vacuum analyze ${table}`)
  }
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
  const rollingAbsencePages = []
  for (const page of [1, 3]) {
    const query = { ...lifetime, page, size: 100 }
    const expected = await queryBrowsePageIds('track', query)
    expect(expected.ids).toHaveLength(100)
    expect(expected.hasMore).toBe(true)
    rollingAbsencePages.push({ query, expected })
  }
  await pool.query(`
    update recording_browse_order_state
    set retry_after = statement_timestamp() - interval '1 second'
  `)
  expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(true)
  await pool.query('vacuum analyze recording_browse_order')
  await pool.query('vacuum analyze recording_browse_order_member')
  for (const { query, expected } of rollingAbsencePages)
    await checkBudget(
      `warm browser-sized grouped rolling absence page ${query.page}`,
      query.page === 1 ? 1_800 : 5_500,
      1,
      async () => {
        expect(await queryBrowsePageIds('track', query)).toEqual(expected)
      },
    )
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

it('bounds Track autocomplete and grouped Browse on shared artist and album tags', async () => {
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

  const { listTrackBrowsePage } = await import('@/services/tracks')
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    filters: [
      { field: 'genre', value: 'Absent fixture genre', mode: 'required' },
    ],
    listening: {
      match: 'all',
      rules: [{ period: { kind: 'rolling', amount: 1, unit: 'days' }, max: 0 }],
    },
    sortBy: 'scrobbles',
    direction: 'desc',
    size: 5,
  })
  await checkBudget(
    'tag-rich grouped lifetime page requiring an absent genre',
    5_000,
    4,
    async () => {
      const page = await listTrackBrowsePage(query)
      expect(page.items).toEqual([])
      expect(page.hasMore).toBe(false)
    },
  )

  // Both artists match, but only the track without an album can use fallback.
  await pool.query(`
    update library_track set album_media_item_id = null, scrobble_count = 101
    where media_item_id = 'track-10000';
    update library_track set scrobble_count = 102
    where media_item_id = 'track-10002';
  `)
  const fallbackPage = await listTrackBrowsePage({
    ...query,
    filters: [{ field: 'genre', value: 'Fixture Genre 48', mode: 'required' }],
  }).finally(async () => {
    await pool.query(`
      update library_track set album_media_item_id = 'album-1000', scrobble_count = 1
      where media_item_id = 'track-10000';
      update library_track set scrobble_count = 3
      where media_item_id = 'track-10002';
    `)
  })
  expect(fallbackPage.items).toHaveLength(query.size)
  expect(fallbackPage.items[0]).toMatchObject({
    id: 'track-10000',
    albumTags: [],
  })
  expect(fallbackPage.items.map(({ id }) => id)).not.toContain('track-10002')
  for (const item of fallbackPage.items) {
    expect(item.artistTags).toContain('Fixture Genre 48')
  }
  expect(fallbackPage.items.slice(1).map(({ albumTags }) => albumTags)).toEqual(
    Array(4).fill(['Fixture Genre 01']),
  )
})

it('bounds grouped lifetime Browse with a broad genre and two listening rules', async () => {
  const { queryBrowseCounts, refreshRecordingBrowseOrderForMaintenance } =
    await import('@/services/browse')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  await pool.query(`
    insert into tag (id, media_type, name, kind)
    values ('lifetime-fixture-genre', 'album', 'Lifetime Fixture Genre', 'genre');
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'lifetime-fixture-genre' from generate_series(1, 600) n;
    insert into media_item (id, slug, media_type, title)
    select 'lifetime-edition-' || n, 'lifetime-edition-' || n, 'track', 'Fixture Lifetime Edition ' || n
    from generate_series(1, 3) n;
    insert into library_track (media_item_id, album_media_item_id, date_added, version_group_id, version_shown)
    select 'lifetime-edition-' || n,
      case when n = 3 then 'album-900' else 'album-1' end,
      timestamp '2024-01-01' + n * interval '1 day', 'lifetime-manual-group', n = 2
    from generate_series(1, 3) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'lifetime-edition-' || n, 'artist-1000', 'artist' from generate_series(1, 3) n;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'lifetime-fixture-listener', 'fixture-artist', 'track-' || n, 'track-' || n, 'name'
    from generate_series(1001, 7000) n
    union all
    select 'lifetime-fixture-listener', 'fixture-artist', 'track-' || n, 'track-' || n, 'name'
    from (values (101), (18101)) editions(n)
    union all
    select 'lifetime-fixture-listener', 'fixture-artist', 'lifetime-edition-' || n,
      'lifetime-edition-' || n, 'name' from generate_series(1, 3) n;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'lifetime-fixture-' || track_key || '-' || event, username,
      case when track_media_item_id in ('track-18101', 'lifetime-edition-3')
        or track_media_item_id in (
          select 'track-' || n from generate_series(1004, 7000, 4) n)
        then statement_timestamp() - interval '2 days'
        else timestamp '2001-01-01' + event * interval '1 day' end,
      'Fixture artist', track_key, artist_key, track_key
    from lastfm_track_link
    cross join lateral generate_series(1, case track_media_item_id
      when 'lifetime-edition-1' then 102 when 'lifetime-edition-2' then 103 else 1 end) event
    where username = 'lifetime-fixture-listener';

    -- The preferred version fails the genre. Its recent play must not
    -- exclude the earlier edition that still matches.
    update library_track set album_media_item_id = 'album-900',
      version_shown = true, scrobble_count = 301 where media_item_id = 'track-18101';
    update library_track set scrobble_count = 201 where media_item_id = 'track-101';
    update library_track set scrobble_count = 250 where media_item_id = 'track-1004';
    insert into recording_browse_order_state (singleton, builder, maintenance_only, retry_after)
    values (true, current_user, true, statement_timestamp() - interval '1 second')
    on conflict (singleton) do update set maintenance_only = true,
      retry_after = excluded.retry_after;
  `)
  for (const table of [
    'media_item_tag',
    'lastfm_track_link',
    'lastfm_scrobble',
  ])
    await pool.query(`vacuum analyze ${table}`)

  const params = new URLSearchParams({
    q: '',
    filters: JSON.stringify([
      { field: 'genre', value: 'Lifetime Fixture Genre', mode: 'required' },
    ]),
    ranges: '[]',
    groupRecordings: 'true',
    sortBy: 'scrobbles',
    direction: 'desc',
    listening: JSON.stringify({
      match: 'all',
      rules: [
        { period: { kind: 'rolling', amount: 1, unit: 'years' }, max: 0 },
        { period: { kind: 'all' }, min: 1 },
      ],
    }),
  })
  const countParams = new URLSearchParams(params)
  countParams.delete('sortBy')
  countParams.delete('direction')
  const countQuery = TrackQuerySchema.parse(Object.fromEntries(countParams))
  const pageQuery = (page: number) =>
    TrackQuerySchema.parse({
      ...Object.fromEntries(params),
      page: String(page),
      size: '100',
    })
  const readPage = (page: number) => listTrackBrowsePage(pageQuery(page))
  const textAbsence = TrackQuerySchema.parse({
    ...Object.fromEntries(params),
    q: 'fixture track',
    page: '1',
    size: '100',
    listening: JSON.stringify({
      match: 'all',
      rules: [
        { period: { kind: 'rolling', amount: 1, unit: 'years' }, max: 0 },
      ],
    }),
  })

  try {
    const coldCount = await queryBrowseCounts('track', countQuery)
    expect(coldCount.totalCount).toBeGreaterThan(2_000)
    const cold = []
    for (const page of [1, 3, 20]) {
      const result = await readPage(page)
      expect(result.items).toHaveLength(100)
      expect(result.hasMore).toBe(true)
      cold.push(result)
    }
    expect(cold[0]?.items[0]).toMatchObject({
      id: 'lifetime-edition-2',
      scrobbles: 205,
      recordingGroup: { versionCount: 2 },
    })
    expect(cold[0]?.items[1]).toMatchObject({ id: 'track-101', scrobbles: 201 })
    expect(cold[0]?.items[1]?.recordingGroup).toBeUndefined()
    const coldTextAbsence = await checkBudget(
      'cold two-word genre page with no recent listening',
      220_000,
      4,
      async () => {
        const page = await listTrackBrowsePage(textAbsence)
        expect(
          logQuery.mock.calls.some(([sql]) =>
            sql.includes('in (select distinct listening_member.group_key'),
          ),
        ).toBe(true)
        return page
      },
      500_000,
    )
    expect(coldTextAbsence.items).toHaveLength(100)
    expect(coldTextAbsence.items[0]?.id).toBe('track-101')
    expect(coldTextAbsence.items.map(({ id }) => id)).not.toContain(
      'track-1004',
    )

    expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(true)
    await pool.query('vacuum analyze recording_browse_order')
    await pool.query('vacuum analyze recording_browse_order_member')

    for (const page of cold) {
      await checkBudget(
        `warm broad-genre grouped lifetime page ${page.page}`,
        24_000,
        2,
        async () => {
          expect(await readPage(page.page)).toEqual(page)
          expect(logQuery.mock.calls[0]?.[0]).toContain(
            'recording_browse_order_member',
          )
        },
      )
    }
    await checkBudget(
      'separate exact broad-genre grouped total',
      24_000,
      2,
      async () => {
        expect(await queryBrowseCounts('track', countQuery)).toEqual(coldCount)
        expect(
          logQuery.mock.calls.some(([sql]) =>
            sql.includes('recording_browse_order_member'),
          ),
        ).toBe(true)
      },
    )
    await checkBudget(
      'warm two-word genre page with no recent listening',
      220_000,
      2,
      async () => {
        expect(await listTrackBrowsePage(textAbsence)).toEqual(coldTextAbsence)
      },
      500_000,
    )

    // A committed rank change must be visible before maintenance runs again.
    await pool.query(`
      update library_track set scrobble_count = 0 where media_item_id = 'track-101'
    `)
    logQuery.mockClear()
    expect((await readPage(1)).items.map(({ id }) => id)).not.toContain(
      'track-101',
    )
    expect(
      logQuery.mock.calls.some(([sql]) =>
        sql.includes('recording_duration_spans as ('),
      ),
    ).toBe(true)
    expect(await queryBrowseCounts('track', countQuery)).toEqual(coldCount)
  } finally {
    await pool.query(`
      delete from lastfm_scrobble where username = 'lifetime-fixture-listener';
      delete from lastfm_track_link where username = 'lifetime-fixture-listener';
      delete from media_item where id in ('lifetime-edition-1', 'lifetime-edition-2', 'lifetime-edition-3');
      delete from media_item_tag where tag_id = 'lifetime-fixture-genre';
      delete from tag where id = 'lifetime-fixture-genre';
      update library_track set scrobble_count = 0 where media_item_id = 'track-101';
      update library_track set scrobble_count = 95 where media_item_id = 'track-1004';
      update library_track set album_media_item_id = (select album_media_item_id
        from library_track where media_item_id = 'track-101'),
        version_shown = false, scrobble_count = 22 where media_item_id = 'track-18101';
    `)
  }
})

it('bounds Added and Title queries with artist tags and Last.fm placeholders', async () => {
  const {
    queryBrowseCount,
    queryBrowseCounts,
    queryBrowsePageIds,
    queryBrowsePositions,
  } = await import('@/services/browse')
  const { listTrackBrowsePage, listTracksAtPositions } =
    await import('@/services/tracks')
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
  for (const direction of ['asc', 'desc'] satisfies TrackQuery['direction'][]) {
    const firstTie = direction === 'asc' ? 99 : 3899
    const positions = await listTracksAtPositions({
      ...populousCreator,
      direction,
      positions: [firstTie, firstTie + 1],
    })
    expect(
      positions.items.map(({ item, position }) => [item.id, position]),
    ).toEqual([
      ['track-4101', firstTie],
      ['track-4100', firstTie + 1],
    ])
  }

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

  const deepTitlePage = TrackQuerySchema.parse({
    ...titlePage,
    direction: 'desc',
    page: 125,
  })
  const deepPage = await checkBudget(
    'deep descending Track title page',
    80_000,
    2,
    () => listTrackBrowsePage(deepTitlePage),
  )
  expect(deepPage.items).toHaveLength(100)
  expect(deepPage.hasMore).toBe(true)
  const bookmarked = await checkBudget(
    'deep Track title positions',
    80_000,
    2,
    () =>
      listTracksAtPositions({ ...deepTitlePage, positions: [12400, 12499] }),
  )
  expect(
    bookmarked.items.map(({ item, position }) => [item.id, position]),
  ).toEqual([
    [deepPage.items[0]?.id, 12400],
    [deepPage.items[99]?.id, 12499],
  ])
  const count = await checkBudget(
    'independent Track title count',
    370_000,
    3,
    () => queryBrowseCounts('track', deepTitlePage),
  )
  expect(
    logQuery.mock.calls.some(([statement]) =>
      statement.includes('primary_tracks'),
    ),
  ).toBe(false)
  expect(count.totalCount).toBeGreaterThan(12_500)
  expect(count.totalCount).toBe(count.unfilteredCount)
  expect(await queryBrowseCounts('track', titlePage)).toEqual(count)

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

it('plans the duplicate group trigger for the rows of each track write', async () => {
  // The trigger function once kept the plan of the session's first write, so a
  // bulk update after a one-row update compared every old row with every new
  // row. That took over twenty seconds here; the limit stops it at five.
  const session = new pg.Client({
    ...connection,
    database: name,
    statement_timeout: 5_000,
  })
  await session.connect()
  try {
    await session.query(`update library_track set scrobble_count = scrobble_count
      where media_item_id = 'track-1'`)
    const bulk =
      await session.query(`update library_track set scrobble_count = scrobble_count
      where media_item_id in (select 'track-' || n from generate_series(1, 12000) n)`)
    expect(bulk.rowCount).toBe(12000)
  } finally {
    await session.end()
  }
})

it('bounds the Possible duplicates view of Matches and its layout', async () => {
  const { refreshTrackDuplicatesForMaintenance, readTrackDuplicateLayout } =
    await import('@/services/track-duplicates')
  const { listTrackMatchDiagnostics } =
    await import('@/services/track-match-diagnostics')
  // Each artist's tracks titled Fixture Intro by the detail test above are one
  // group, and so is each title of a second release with its first.
  expect(await refreshTrackDuplicatesForMaintenance()).toBe(true)
  await pool.query('vacuum analyze track_duplicate_group')
  await pool.query('vacuum analyze track_duplicate_member')
  const counts = z.object({ groups: z.number(), members: z.number() }).parse(
    (
      await pool.query(`select
          (select count(*)::int from track_duplicate_group) as groups,
          (select count(*)::int from track_duplicate_member) as members`)
    ).rows[0],
  )
  process.stdout.write(
    `duplicates: ${counts.groups} groups, ${counts.members} tracks\n`,
  )
  const query = TrackMatchDiagnosticsQuerySchema.parse({
    duplicates: 'true',
    size: 50,
  })
  // Most of the page's work is the Spotify versions of its common title, as
  // on any Matches page of these tracks.
  await checkBudget(
    'Matches page of possible duplicates',
    150_000,
    2,
    async () => {
      const page = await listTrackMatchDiagnostics(query)
      expect(page.items).toHaveLength(50)
      expect(page.totalCount).toBe(counts.members)
    },
  )
  // The IDs, their groups, the groups, then what Merge does to each group:
  // one statement for each 2,000 tracks.
  await checkBudget('Possible duplicates layout', 160_000, 10, async () => {
    const layout = await readTrackDuplicateLayout(query)
    expect(layout.totalRows).toBe(counts.members)
    expect(layout.groups).toHaveLength(counts.groups)
    expect(layout.groups.every((group) => group.merge)).toBe(true)
  })
})

/** Shared blocks the select statements of one read touch. */
async function sharedBlocksOf(read: () => Promise<unknown>) {
  logQuery.mockClear()
  await read()
  let blocks = 0
  for (const [query, params] of logQuery.mock.calls.filter(([query]) =>
    /^\s*(select|with)\b/i.test(query),
  )) {
    const result = await pool.query(
      `explain (analyze, buffers, timing off, format json) ${query}`,
      params,
    )
    const plan = ExplainSchema.parse(result.rows)[0]['QUERY PLAN'][0].Plan
    blocks += plan['Shared Hit Blocks'] + plan['Shared Read Blocks']
  }
  return blocks
}

it('bounds Track pages sorted and filtered by tempo and key', async () => {
  const { queryBrowsePageIds } = await import('@/services/browse')
  try {
    // Nine in ten of 18,000 records are verified; the rest stay hidden.
    await pool.query(`
      insert into track_fact (media_item_id, provider, bpm, key_camelot, verified, fetched_at)
      select 'track-' || n, 'sonovault', 80 + (n * 7) % 100 + (n % 100) / 100.0,
        (1 + n % 12) || case when n % 3 = 0 then 'B' else 'A' end,
        n % 10 <> 0, timestamp '2026-11-01'
      from generate_series(1, 18000) n`)
    await pool.query('vacuum analyze track_fact')
    const page = (input: Record<string, unknown>) =>
      queryBrowsePageIds(
        'track',
        TrackQuerySchema.parse({ size: 50, ...input }),
      )
    // A first page sorted by tempo or key resolves the release order of every
    // track, as the Duration sort does. It may cost no more than that sort.
    const durationBlocks = await sharedBlocksOf(() =>
      page({ sortBy: 'durationSec', direction: 'asc' }),
    )
    const sortBudget = Math.ceil(durationBlocks * 1.05)
    await checkBudget('Track tempo page', sortBudget, 1, async () => {
      const result = await page({ sortBy: 'bpm', direction: 'asc' })
      expect(result.ids).toHaveLength(50)
    })
    await checkBudget('Track key page', sortBudget, 1, async () => {
      const result = await page({ sortBy: 'musicalKey', direction: 'desc' })
      expect(result.ids).toHaveLength(50)
    })
    // About one track in thirty in either range. Both walk the Added order
    // until the page is full; tempo adds one index probe of track_fact per
    // track walked, where duration reads a column of the same row.
    const durationRangeBlocks = await sharedBlocksOf(() =>
      page({
        ranges: JSON.stringify([{ field: 'durationSec', min: 150, max: 150 }]),
      }),
    )
    await checkBudget(
      'Track tempo range page',
      durationRangeBlocks * 5,
      1,
      async () => {
        const result = await page({
          ranges: JSON.stringify([{ field: 'bpm', min: 120, max: 122 }]),
        })
        expect(result.ids).toHaveLength(50)
      },
    )
    await checkBudget('Track key filter page', 5_500, 1, async () => {
      const result = await page({
        sortBy: 'title',
        filters: JSON.stringify([{ field: 'musicalKey', value: 'Am' }]),
      })
      expect(result.ids).toHaveLength(50)
    })
    const groupedDurationBlocks = await sharedBlocksOf(() =>
      page({ sortBy: 'durationSec', direction: 'desc', groupRecordings: true }),
    )
    const groupedBudget = Math.ceil(groupedDurationBlocks * 1.05)
    await checkBudget(
      'grouped Track tempo page',
      groupedBudget,
      3,
      async () => {
        const result = await page({
          sortBy: 'bpm',
          direction: 'desc',
          groupRecordings: true,
        })
        expect(result.ids).toHaveLength(50)
      },
    )
  } finally {
    await pool.query('delete from track_fact')
  }
})

const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    'Node Type': z.string(),
    'Relation Name': z.string().optional(),
    'Index Name': z.string().optional(),
    'Parent Relationship': z.string().optional(),
    'Subplan Name': z.string().optional(),
    'Actual Loops': z.number(),
    Plans: z.array(PlanNodeSchema).default([]),
  }),
)
type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Parent Relationship'?: string
  'Subplan Name'?: string
  'Actual Loops': number
  Plans: PlanNode[]
}

/** Every read of track_tag in the plans of a read's select statements. */
async function trackTagScans(read: () => Promise<unknown>) {
  logQuery.mockClear()
  await read()
  const scans: PlanNode[] = []
  const visit = (node: PlanNode) => {
    if (node['Relation Name'] === 'track_tag') scans.push(node)
    node.Plans.forEach(visit)
  }
  for (const [query, params] of logQuery.mock.calls.filter(([query]) =>
    /^\s*(select|with)\b/i.test(query),
  )) {
    const result = await pool.query(
      `explain (analyze, buffers, timing off, format json) ${query}`,
      params,
    )
    const plan = z
      .tuple([
        z.object({
          'QUERY PLAN': z.tuple([z.object({ Plan: PlanNodeSchema })]),
        }),
      ])
      .parse(result.rows)[0]['QUERY PLAN'][0].Plan
    visit(plan)
  }
  return scans
}

it('bounds Track pages filtered, sorted and hydrated by Track tags', async () => {
  const { queryBrowsePageIds, queryBrowseCount, listBrowseFacets } =
    await import('@/services/browse')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  const { rebuildTagAncestors } = await import('@/services/tag-hierarchy')
  // About two tags on each of 18,000 tracks, a tenth unverified and a few
  // removed by the owner. The broad tag has 300 subtags and, with them, half
  // the tracks; the narrow one 720 tracks; the rare one a single track; the
  // absent one none. Sixty filler tags carry the rest.
  await pool.query(`
    insert into tag (id, media_type, name, kind) values
      ('ttag-broad', 'album', 'Fixture Tide', 'genre'),
      ('ttag-narrow', 'album', 'Fixture Narrow', 'genre'),
      ('ttag-rare', 'album', 'Fixture Rare', 'genre'),
      ('ttag-absent', 'album', 'Fixture Absent', 'genre'),
      ('ttag-hidden', 'album', 'Fixture Hidden', 'genre');
    update tag set hidden = true where id = 'ttag-hidden';
    insert into tag (id, media_type, name, kind)
    select 'ttag-sub-' || n, 'album'::media_type, 'Fixture Tide ' || n, 'genre' from generate_series(1, 300) n
    union all
    select 'ttag-filler-' || n, 'album'::media_type, 'Fixture Filler ' || n, 'genre' from generate_series(1, 60) n;
    insert into tag_identity (media_type, normalized_name, kind, tag_id)
    select media_type, lower(name), kind, id from tag where id like 'ttag-%';
    insert into tag_parent (media_type, child_key, parent_key)
    select 'album'::media_type, 'fixture tide ' || n, 'fixture tide' from generate_series(1, 300) n;
    insert into track_tag (media_item_id, tag_id, sonovault, verified)
    select 'track-' || n, 'ttag-sub-' || (1 + n % 300), true, n % 10 <> 0
    from generate_series(2, 18000, 2) n
    union all
    select 'track-' || n, 'ttag-filler-' || (1 + n % 60), true, n % 10 <> 1
    from generate_series(1, 18000) n
    union all
    select 'track-' || n, 'ttag-narrow', true, true from generate_series(25, 18000, 25) n
    union all
    select 'track-' || n, 'ttag-hidden', true, true from generate_series(7, 18000, 70) n
    union all
    select 'track-19995', 'ttag-rare', true, true;
    update track_tag set owner = 'removed', owner_changed_at = timestamp '2026-11-01'
    where media_item_id in (select 'track-' || n from generate_series(997, 18000, 997) n);
  `)
  await rebuildTagAncestors(database, 'album')
  for (const table of [
    'tag',
    'tag_identity',
    'tag_parent',
    'tag_ancestor',
    'track_tag',
    'library_track',
  ])
    await pool.query(`vacuum analyze ${table}`)
  const expected = z.object({ broad: z.number(), narrow: z.number() }).parse(
    (
      await pool.query(`select
          (select count(distinct media_item_id)::int from track_tag
            where in_browse and tag_id like 'ttag-sub-%') as broad,
          (select count(*)::int from track_tag
            where in_browse and tag_id = 'ttag-narrow') as narrow`)
    ).rows[0],
  )
  const page = (input: Record<string, unknown>) =>
    queryBrowsePageIds('track', TrackQuerySchema.parse({ size: 100, ...input }))
  const tagFilter = (value: string, mode?: string) =>
    JSON.stringify([{ field: 'trackTag', value, ...(mode ? { mode } : {}) }])
  // The track_tag reads of a plan are one pass over a partial index, a hashed
  // SubPlan or the primary key of the page's rows: never a probe per track.
  async function expectSetReads(label: string, read: () => Promise<unknown>) {
    const scans = await trackTagScans(read)
    expect(scans.length, label).toBeGreaterThan(0)
    for (const scan of scans) {
      expect(
        scan['Actual Loops'],
        `${label} track_tag loops`,
      ).toBeLessThanOrEqual(1)
      if (scan['Index Name'])
        expect(scan['Index Name'], label).toMatch(
          /^track_tag_(tag_media_browse_idx|media_browse_idx|pkey)$/,
        )
    }
  }

  try {
    const workloads = [
      ['broad', 'Fixture Tide', 100],
      ['narrow', 'Fixture Narrow', 100],
      ['rare', 'Fixture Rare', 1],
      ['absent', 'Fixture Absent', 0],
    ] as const
    // 1.5 times the shared blocks measured when these workloads were added.
    const budgets: Record<string, number> = {
      'broad title': 36_100,
      'narrow title': 10_300,
      'rare title': 7_700,
      'absent title': 7_700,
      'broad added': 20_700,
      'narrow added': 21_500,
      'rare added': 38_600,
      'absent added': 38_600,
    }
    for (const [tag, value, rows] of workloads)
      for (const [sort, sortBy, direction] of [
        ['title', 'title', 'asc'],
        ['added', 'dateAdded', 'desc'],
      ] as const) {
        const read = async () => {
          const result = await page({
            sortBy,
            direction,
            filters: tagFilter(value),
          })
          expect(result.ids).toHaveLength(rows)
        }
        const label = `Track tags ${tag} ${sort} page`
        await checkBudget(
          label,
          budgets[`${tag} ${sort}`] ?? 0,
          1,
          read,
          10_000,
        )
        await expectSetReads(label, read)
      }
    for (const [sort, sortBy, direction] of [
      ['added', 'dateAdded', 'desc'],
      ['title', 'title', 'asc'],
    ] as const) {
      const read = async () => {
        const result = await page({
          sortBy,
          direction,
          filters: tagFilter('Fixture Narrow', 'exclude'),
        })
        expect(result.ids).toHaveLength(100)
      }
      const label = `Track tags narrow exclude ${sort} page`
      // Excluding a narrow tag keeps nearly every track, so the page costs
      // about what its order costs without the filter.
      const unfiltered = await sharedBlocksOf(() => page({ sortBy, direction }))
      process.stdout.write(`${label}: unfiltered ${unfiltered} shared blocks\n`)
      await checkBudget(label, Math.ceil(unfiltered * 1.5), 1, read, 10_000)
      await expectSetReads(label, read)
    }
    // Measured at 3,057 blocks on PostgreSQL 17.9 here and 14,011 in CI on
    // 17 and 18 (another plan, about 30 ms either way); 1.5 times the larger.
    await checkBudget(
      'Track tags broad deep page',
      21_100,
      1,
      async () => {
        const result = await page({
          sortBy: 'title',
          direction: 'asc',
          page: 40,
          filters: tagFilter('Fixture Tide'),
        })
        expect(result.ids).toHaveLength(100)
      },
      10_000,
    )
    // An exact count with a filter on library_track pays for the same
    // visibility reads; the tag set adds one read of the partial index.
    const rangeCountBlocks = await sharedBlocksOf(() =>
      queryBrowseCount(
        'track',
        TrackQuerySchema.parse({
          ranges: JSON.stringify([
            { field: 'durationSec', min: 150, max: 165 },
          ]),
        }),
      ),
    )
    process.stdout.write(
      `Track tags broad count: a Duration range count reads ${rangeCountBlocks} shared blocks\n`,
    )
    let broadCount = 0
    await checkBudget(
      'Track tags broad count',
      Math.ceil(rangeCountBlocks * 1.5),
      3,
      async () => {
        // Less any fixture track an earlier test hid from Browse.
        const { totalCount } = await queryBrowseCount(
          'track',
          TrackQuerySchema.parse({ filters: tagFilter('Fixture Tide') }),
        )
        expect(totalCount).toBeLessThanOrEqual(expected.broad)
        expect(totalCount).toBeGreaterThan(expected.broad - 10)
        broadCount = totalCount
      },
    )
    // A first page sorted by Track tags resolves the release order of every
    // track, as the Duration, Tempo and Key sorts do; it may cost no more.
    const durationBlocks = await sharedBlocksOf(() =>
      page({ sortBy: 'durationSec', direction: 'asc' }),
    )
    for (const [label, input, budget] of [
      ['Track tags sort page', {}, Math.ceil(durationBlocks * 1.05)],
      ['Track tags sort deep page', { page: 40 }, 207_400],
    ] as const) {
      const read = async () => {
        const result = await page({
          sortBy: 'trackTag',
          direction: 'asc',
          ...input,
        })
        expect(result.ids).toHaveLength(100)
      }
      await checkBudget(label, budget, 1, read)
      await expectSetReads(label, read)
    }
    const hydrate = async () => {
      const result = await listTrackBrowsePage(
        TrackQuerySchema.parse({
          size: 100,
          sortBy: 'dateAdded',
          direction: 'desc',
          filters: tagFilter('Fixture Narrow'),
        }),
      )
      expect(result.items).toHaveLength(100)
      expect(
        result.items.every((item) =>
          item.trackTags.some((name) => name === 'Fixture Narrow'),
        ),
      ).toBe(true)
      expect(
        result.items.some((item) => item.trackTags.includes('Fixture Hidden')),
      ).toBe(false)
    }
    await checkBudget('Track tags hydrated page', 27_200, 2, hydrate)
    await expectSetReads('Track tags hydrated page', hydrate)
    const trackTagField = trackBrowseFields.filter(
      (field) => field.key === 'trackTag',
    )
    // Live suggestions run only before the stored vocabulary is built. Both
    // tag fields pay for the same visibility of Last.fm placeholders.
    const albumTagSuggestionBlocks = await sharedBlocksOf(() =>
      listBrowseFacets(
        'track',
        { q: 'fixture tide' },
        {
          fields: trackBrowseFields.filter((field) => field.key === 'albumTag'),
        },
      ),
    )
    process.stdout.write(
      `Track tags live suggestions: Album tags read ${albumTagSuggestionBlocks} shared blocks\n`,
    )
    await checkBudget(
      'Track tags live suggestions',
      Math.ceil(albumTagSuggestionBlocks * 1.5),
      4,
      async () => {
        const facets = await listBrowseFacets(
          'track',
          { q: 'fixture tide' },
          { fields: trackTagField },
        )
        expect(facets[0]).toMatchObject({
          field: 'trackTag',
          value: 'fixture tide',
          count: broadCount,
          subtags: 300,
        })
      },
    )
    // Has track tags tests library_track.has_own_tags, a column of the row
    // the page joins or walks: no set, so no materialised nested loop.
    const hasTagsFilter = (value: string, mode?: string) =>
      JSON.stringify([
        { field: 'hasTrackTags', value, ...(mode ? { mode } : {}) },
      ])
    // A Title page walks the title index as an unfiltered one does: 1.5 times
    // its cost. Added pages take the first-page path of Track tags filters:
    // 1.5 times the shared blocks measured when these workloads were added.
    const unfilteredTitleBlocks = await sharedBlocksOf(() =>
      page({ sortBy: 'title', direction: 'asc' }),
    )
    process.stdout.write(
      `Has track tags: an unfiltered Title page reads ${unfilteredTitleBlocks} shared blocks\n`,
    )
    const hasTagsBudgets: Record<string, number> = {
      'Yes title': Math.ceil(unfilteredTitleBlocks * 1.5),
      'No title': Math.ceil(unfilteredTitleBlocks * 1.5),
      'Yes added': 20_200,
      'No added': 4_300,
    }
    for (const answer of ['Yes', 'No'] as const)
      for (const [sort, sortBy, direction] of [
        ['title', 'title', 'asc'],
        ['added', 'dateAdded', 'desc'],
      ] as const)
        await checkBudget(
          `Has track tags ${answer} ${sort} page`,
          hasTagsBudgets[`${answer} ${sort}`] ?? 0,
          1,
          async () => {
            const result = await page({
              sortBy,
              direction,
              filters: hasTagsFilter(answer),
            })
            expect(result.ids).toHaveLength(100)
          },
          10_000,
        )
    await checkBudget(
      'Has track tags count',
      Math.ceil(rangeCountBlocks * 1.5),
      3,
      async () => {
        const { totalCount } = await queryBrowseCount(
          'track',
          TrackQuerySchema.parse({ filters: hasTagsFilter('No') }),
        )
        expect(totalCount).toBeGreaterThan(0)
      },
    )
    await checkBudget(
      'Has track tags sort page',
      Math.ceil(durationBlocks * 1.05),
      1,
      async () => {
        const result = await page({ sortBy: 'hasTrackTags', direction: 'asc' })
        expect(result.ids).toHaveLength(100)
      },
    )
    // Before the vocabulary is built: one row per track, as Library album.
    const albumLinkSuggestionBlocks = await sharedBlocksOf(() =>
      listBrowseFacets(
        'track',
        { q: 'library' },
        {
          fields: trackBrowseFields.filter(
            (field) => field.key === 'albumLink',
          ),
        },
      ),
    )
    process.stdout.write(
      `Has track tags live suggestions: Library album reads ${albumLinkSuggestionBlocks} shared blocks\n`,
    )
    await checkBudget(
      'Has track tags live suggestions',
      Math.ceil(albumLinkSuggestionBlocks * 1.5),
      4,
      async () => {
        const facets = await listBrowseFacets(
          'track',
          { q: 'has track tags' },
          {
            fields: trackBrowseFields.filter(
              (field) => field.key === 'hasTrackTags',
            ),
          },
        )
        expect(facets.map(({ value }) => value).sort()).toEqual(['No', 'Yes'])
      },
    )
    const { refreshTrackFacetVocabularyForMaintenance } =
      await import('@/services/browse')
    const built = performance.now()
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
    process.stdout.write(
      `Track tags vocabulary build: ${(performance.now() - built).toFixed(0)} ms\n`,
    )
    await pool.query('vacuum analyze track_facet_value')
    await checkBudget('Track tags stored suggestions', 720, 4, async () => {
      const facets = await listBrowseFacets('track', { q: 'fixture tide' })
      expect(
        facets.find(
          ({ field, value }) =>
            field === 'trackTag' && value === 'fixture tide',
        ),
      ).toMatchObject({ count: broadCount, subtags: 300 })
    })
  } finally {
    await pool.query(`
      delete from track_tag;
      delete from tag_parent where child_key like 'fixture tide %';
      delete from tag_identity where tag_id like 'ttag-%';
      delete from tag where id like 'ttag-%';
    `)
    await rebuildTagAncestors(database, 'album')
  }
})

it('bounds Track pages filtered and sorted by provider', async () => {
  const { queryBrowsePageIds } = await import('@/services/browse')
  // An ISRC on every track, a TIDAL track ID on two in three, a Sonovault
  // match on every tenth and TIDAL and Sonovault IDs on every album: the
  // ISRC and album rows are read past, never matched.
  await pool.query(`
    insert into provider_reference (id, media_item_id, provider, reference_type, external_id)
    select 'pref-isrc-' || n, 'track-' || n, 'spotify', 'isrc', 'ZZFIX' || n
    from generate_series(1, 20000) n
    union all
    select 'pref-tidal-' || n, 'track-' || n, 'tidal', 'track', n::text
    from generate_series(1, 20000) n where n % 3 <> 0
    union all
    select 'pref-sonovault-' || n, 'track-' || n, 'sonovault', 'sonovault-track', 'sv-' || n
    from generate_series(10, 20000, 10) n
    union all
    select 'pref-album-' || provider || '-' || n, 'album-' || n, provider, 'album', provider || n
    from generate_series(1, 1000) n cross join (values ('tidal'), ('sonovault')) p(provider);
  `)
  await pool.query('vacuum analyze provider_reference')
  const page = (input: Record<string, unknown>) =>
    queryBrowsePageIds('track', TrackQuerySchema.parse({ size: 100, ...input }))
  const providerFilter = (value: string, mode?: string) =>
    JSON.stringify([{ field: 'provider', value, ...(mode ? { mode } : {}) }])
  try {
    // 1.5 times the shared blocks measured when these workloads were added.
    const budgets: Record<string, number> = {
      'tidal title': 79_600,
      'tidal exclude title': 39_700,
      'sonovault title': 18_400,
      'sonovault exclude title': 100_900,
      'tidal added': 20_800,
      'tidal exclude added': 5_000,
      'sonovault added': 20_800,
      'sonovault exclude added': 5_000,
    }
    for (const provider of ['tidal', 'sonovault'])
      for (const mode of ['required', 'exclude'])
        for (const [sort, sortBy, direction] of [
          ['title', 'title', 'asc'],
          ['added', 'dateAdded', 'desc'],
        ] as const) {
          const workload = `${provider}${mode === 'exclude' ? ' exclude' : ''} ${sort}`
          await checkBudget(
            `Provider ${workload} page`,
            budgets[workload] ?? 0,
            1,
            async () => {
              const result = await page({
                sortBy,
                direction,
                filters: providerFilter(provider, mode),
              })
              expect(result.ids).toHaveLength(100)
            },
            10_000,
          )
        }
    // A first page sorted by provider resolves every track's providers, as
    // the Duration sort resolves every track's release order.
    const durationBlocks = await sharedBlocksOf(() =>
      page({ sortBy: 'durationSec', direction: 'asc' }),
    )
    process.stdout.write(
      `Provider sort page: a Duration sort reads ${durationBlocks} shared blocks\n`,
    )
    for (const direction of ['asc', 'desc'])
      await checkBudget(
        `Provider sort ${direction} page`,
        Math.ceil(durationBlocks * 1.05),
        1,
        async () => {
          const result = await page({ sortBy: 'provider', direction })
          expect(result.ids).toHaveLength(100)
        },
      )
  } finally {
    await pool.query("delete from provider_reference where id like 'pref-%'")
    await pool.query('vacuum analyze provider_reference')
  }
})

/**
 * Stage 3 of track tags: tags read from the track, its album or its artists.
 * About two own tags on each of 18,000 tracks (Sonovault rows, a tenth
 * unverified, a few removed, a few added by the owner); a broad tag with 300
 * subtags on half of them and on 400 albums; a narrow tag on every 25th
 * track, 20 albums and a tenth of the artists; a rare tag on one track; a tag
 * on albums and artists that no track carries itself.
 */
async function seedTagLocationFixture() {
  const { rebuildTagAncestors } = await import('@/services/tag-hierarchy')
  await pool.query(`
    insert into tag (id, media_type, name, kind) values
      ('loc-broad', 'album', 'Location Tide', 'genre'),
      ('loc-narrow', 'album', 'Location Narrow', 'genre'),
      ('loc-rare', 'album', 'Location Rare', 'genre'),
      ('loc-absent', 'album', 'Location Absent', 'genre'),
      ('loc-micro', 'album', 'Location Micro', 'genre'),
      ('loc-owner', 'album', 'Location Owner', 'genre'),
      ('loc-hidden', 'album', 'Location Hidden', 'genre');
    update tag set hidden = true where id = 'loc-hidden';
    insert into tag (id, media_type, name, kind)
    select 'loc-sub-' || n, 'album'::media_type, 'Location Tide ' || n, 'genre' from generate_series(1, 300) n
    union all
    select 'loc-filler-' || n, 'album'::media_type, 'Location Filler ' || n, 'genre' from generate_series(1, 60) n;
    insert into tag_identity (media_type, normalized_name, kind, tag_id)
    select media_type, lower(name), kind, id from tag where id like 'loc-%';
    insert into tag_parent (media_type, child_key, parent_key)
    select 'album'::media_type, 'location tide ' || n, 'location tide' from generate_series(1, 300) n;
    insert into track_tag (media_item_id, tag_id, sonovault, verified)
    select 'track-' || n, 'loc-sub-' || (1 + n % 300), true, n % 10 <> 0
    from generate_series(2, 18000, 2) n
    union all
    select 'track-' || n, 'loc-filler-' || (1 + n % 60), true, n % 10 <> 1
    from generate_series(1, 18000) n
    union all
    select 'track-' || n, 'loc-narrow', true, true from generate_series(25, 18000, 25) n
    union all
    select 'track-' || n, 'loc-hidden', true, true from generate_series(7, 18000, 70) n
    union all
    select 'track-19995', 'loc-rare', true, true;
    insert into track_tag (media_item_id, tag_id, sonovault, verified, owner, owner_changed_at)
    select 'track-' || n, 'loc-owner', false, false, 'added', timestamp '2026-11-01'
    from generate_series(30, 18000, 600) n;
    update track_tag set owner = 'removed', owner_changed_at = timestamp '2026-11-01'
    where tag_id like 'loc-%' and owner is null
      and media_item_id in (select 'track-' || n from generate_series(997, 18000, 997) n);
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'loc-sub-' || (1 + n % 300) from generate_series(1, 400) n
    union all
    select 'album-' || n, 'loc-narrow' from generate_series(50, 1000, 50) n
    union all
    select 'album-' || n, 'loc-micro' from generate_series(1, 300, 3) n
    union all
    select 'album-' || n, 'loc-owner' from generate_series(1, 5) n;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'location-profile-' || n, 'artist-' || n, 'location-fixture', '{}',
      jsonb_build_object('tags', jsonb_build_array('Location Tide 7', 'Location Micro', 'Location Narrow'))
    from generate_series(10, 1000, 10) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select 'artist-' || n, 'location-fixture', 'location-profile-' || n from generate_series(10, 1000, 10) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'album-' || n, 'artist-' || n, 'artist' from generate_series(1, 1000) n
    on conflict do nothing;
  `)
  await rebuildTagAncestors(database, 'album')
  for (const table of [
    'tag',
    'tag_identity',
    'tag_parent',
    'tag_ancestor',
    'track_tag',
    'library_track',
    'media_item_tag',
    'artist_provider_snapshot',
    'artist_provider_current_state',
    'media_credit',
  ])
    await pool.query(`vacuum analyze ${table}`)
}

async function clearTagLocationFixture() {
  const { rebuildTagAncestors } = await import('@/services/tag-hierarchy')
  await pool.query(`
    delete from track_tag where tag_id like 'loc-%';
    delete from media_credit where media_item_id like 'album-%' and role = 'artist';
    delete from media_item_tag where tag_id like 'loc-%';
    delete from artist_provider_current_state where latest_snapshot_id like 'location-profile-%';
    delete from artist_provider_snapshot where id like 'location-profile-%';
    delete from tag_parent where child_key like 'location tide %';
    delete from tag_identity where tag_id like 'loc-%';
    delete from tag where id like 'loc-%';
  `)
  await rebuildTagAncestors(database, 'album')
}

const tagLocations = [
  ['auto', undefined],
  ['track', 'track'],
  ['album', 'album'],
  ['artist', 'artist'],
  ['track+album', 'track,album'],
  ['all', 'track,album,artist'],
] as const
const locationTags = [
  ['broad', 'Location Tide', 'loc-broad'],
  ['narrow', 'Location Narrow', 'loc-narrow'],
  ['rare', 'Location Rare', 'loc-rare'],
  ['absent', 'Location Absent', 'loc-absent'],
] as const

/** Tracks or albums matching a tag at a location, worked out row by row. */
async function expectedAtLocation(
  library: 'track' | 'album',
  levels: string | undefined,
  tagId: string,
) {
  const k = `(select id from tag where id = '${tagId}'
    or ('${tagId}' = 'loc-broad' and id like 'loc-sub-%'))`
  const names = `(select lower(name) from tag where id in ${k})`
  const taggedArtists = `with tagged_artists as materialized (
    select st.artist_id from artist_provider_current_state st
    join artist_provider_snapshot sn on sn.id = st.latest_snapshot_id
    cross join lateral jsonb_array_elements_text(sn.normalized_data->'tags') x(name)
    where lower(x.name) in ${names})`
  const artist = (id: string) => `exists (select 1 from media_credit c
    where c.media_item_id = ${id} and c.role = 'artist'
      and c.artist_id in (select artist_id from tagged_artists))`
  const albumTag = (id: string) =>
    `exists (select 1 from media_item_tag mt where mt.media_item_id = ${id} and mt.tag_id in ${k})`
  const sparse = (
    id: string,
  ) => `(${id} is null or (select count(distinct lower(t.name))
    from media_item_tag mt join tag t on t.id = mt.tag_id
    where mt.media_item_id = ${id} and not t.hidden) < 2)`
  const own = `exists (select 1 from track_tag tt where tt.media_item_id = m.id
    and tt.in_browse and tt.tag_id in ${k})`
  const level = (name: string) => levels?.split(',').includes(name)
  const Count = z.object({ count: z.number() })
  if (library === 'track') {
    const hasOwn = `exists (select 1 from track_tag tt join tag t on t.id = tt.tag_id
      where tt.media_item_id = m.id and tt.in_browse and not t.hidden)`
    const speaks = `exists (select 1 from track_tag tt where tt.in_browse
      and tt.sonovault and tt.tag_id in ${k})`
    const today = `(${albumTag('lt.album_media_item_id')} or (${artist('m.id')}
      and ${sparse('lt.album_media_item_id')}))`
    const match = levels
      ? [
          level('track') ? own : 'false',
          level('album') ? albumTag('lt.album_media_item_id') : 'false',
          level('artist') ? artist('m.id') : 'false',
        ].join(' or ')
      : `${own} or ((not ${hasOwn} or not ${speaks}) and ${today})`
    const result =
      await pool.query(`${taggedArtists} select count(*)::int as count from media_item m
      join library_track lt on lt.media_item_id = m.id
      where m.media_type = 'track' and m.source_label is distinct from 'lastfm'
        and m.metadata->>'legacyHidden' is distinct from 'true' and (${match})`)
    return Count.parse(result.rows[0]).count
  }
  const trackLevel = `exists (select 1 from library_track lt join track_tag tt
    on tt.media_item_id = lt.media_item_id
    where lt.album_media_item_id = m.id and tt.in_browse and tt.tag_id in ${k})`
  const match = levels
    ? [
        level('track') ? trackLevel : 'false',
        level('album') ? albumTag('m.id') : 'false',
        level('artist') ? artist('m.id') : 'false',
      ].join(' or ')
    : `${albumTag('m.id')} or (${artist('m.id')} and ${sparse('m.id')})`
  const result =
    await pool.query(`${taggedArtists} select count(*)::int as count from media_item m
    where m.media_type = 'album' and m.metadata->>'legacyHidden' is distinct from 'true'
      and not exists (select 1 from album e where e.media_item_id = m.id and e.edition_of_id is not null)
      and (${match})`)
  return Count.parse(result.rows[0]).count
}

it('bounds Track and Album pages filtered and sorted by tag location', async () => {
  const {
    queryBrowsePageIds,
    queryBrowseCount,
    listBrowseFacets,
    refreshTrackFacetVocabularyForMaintenance,
  } = await import('@/services/browse')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  const { AlbumQuerySchema } = await import('@repo/schemas/media')
  await seedTagLocationFixture()
  // 1.5 times the shared blocks measured when these workloads were added
  // (at least 200), on PostgreSQL 17.9 here.
  const budgets: Record<string, number> = {
    'track Tags auto broad title page': 84_500,
    'track Tags auto broad added page': 42_900,
    'track Tags auto broad count': 223_100,
    'track Tags auto narrow title page': 17_700,
    'track Tags auto narrow added page': 27_100,
    'track Tags auto rare title page': 8_500,
    'track Tags auto rare added page': 39_400,
    'track Tags auto absent title page': 8_500,
    'track Tags auto absent added page': 39_400,
    'track Tags track broad title page': 57_400,
    'track Tags track broad added page': 21_000,
    'track Tags track broad count': 202_300,
    'track Tags track narrow title page': 12_000,
    'track Tags track narrow added page': 21_700,
    'track Tags track rare title page': 7_300,
    'track Tags track rare added page': 38_200,
    'track Tags track absent title page': 7_300,
    'track Tags track absent added page': 38_200,
    'track Tags album broad title page': 58_900,
    'track Tags album broad added page': 22_400,
    'track Tags album broad count': 203_800,
    'track Tags album narrow title page': 11_000,
    'track Tags album narrow added page': 23_500,
    'track Tags album rare title page': 7_300,
    'track Tags album rare added page': 38_200,
    'track Tags album absent title page': 7_300,
    'track Tags album absent added page': 38_200,
    'track Tags artist broad title page': 38_100,
    'track Tags artist broad added page': 39_300,
    'track Tags artist broad count': 219_500,
    'track Tags artist narrow title page': 20_100,
    'track Tags artist narrow added page': 21_300,
    'track Tags artist rare title page': 7_300,
    'track Tags artist rare added page': 38_300,
    'track Tags artist absent title page': 7_300,
    'track Tags artist absent added page': 38_300,
    'track Tags track+album broad title page': 89_200,
    'track Tags track+album broad added page': 22_500,
    'track Tags track+album broad count': 203_900,
    'track Tags track+album narrow title page': 13_600,
    'track Tags track+album narrow added page': 23_000,
    'track Tags track+album rare title page': 7_300,
    'track Tags track+album rare added page': 38_300,
    'track Tags track+album absent title page': 7_300,
    'track Tags track+album absent added page': 38_200,
    'track Tags all broad title page': 115_400,
    'track Tags all broad added page': 41_100,
    'track Tags all broad count': 221_300,
    'track Tags all narrow title page': 24_300,
    'track Tags all narrow added page': 23_000,
    'track Tags all rare title page': 7_400,
    'track Tags all rare added page': 38_400,
    'track Tags all absent title page': 7_400,
    'track Tags all absent added page': 38_400,
    'album Tags auto broad title page': 19_100,
    'album Tags auto broad added page': 20_000,
    'album Tags auto broad count': 19_100,
    'album Tags auto narrow title page': 1_100,
    'album Tags auto narrow added page': 1_400,
    'album Tags auto rare title page': 400,
    'album Tags auto rare added page': 400,
    'album Tags auto absent title page': 400,
    'album Tags auto absent added page': 400,
    'album Tags track broad title page': 1_800,
    'album Tags track broad added page': 2_500,
    'album Tags track broad count': 1_800,
    'album Tags track narrow title page': 1_800,
    'album Tags track narrow added page': 1_900,
    'album Tags track rare title page': 1_800,
    'album Tags track rare added page': 1_800,
    'album Tags track absent title page': 200,
    'album Tags track absent added page': 200,
    'album Tags album broad title page': 200,
    'album Tags album broad added page': 800,
    'album Tags album broad count': 200,
    'album Tags album narrow title page': 200,
    'album Tags album narrow added page': 200,
    'album Tags album rare title page': 200,
    'album Tags album rare added page': 200,
    'album Tags album absent title page': 200,
    'album Tags album absent added page': 200,
    'album Tags artist broad title page': 18_700,
    'album Tags artist broad added page': 18_900,
    'album Tags artist broad count': 18_700,
    'album Tags artist narrow title page': 700,
    'album Tags artist narrow added page': 900,
    'album Tags artist rare title page': 200,
    'album Tags artist rare added page': 200,
    'album Tags artist absent title page': 200,
    'album Tags artist absent added page': 200,
    'album Tags track+album broad title page': 1_800,
    'album Tags track+album broad added page': 2_800,
    'album Tags track+album broad count': 1_800,
    'album Tags track+album narrow title page': 1_800,
    'album Tags track+album narrow added page': 1_900,
    'album Tags track+album rare title page': 1_800,
    'album Tags track+album rare added page': 1_800,
    'album Tags track+album absent title page': 200,
    'album Tags track+album absent added page': 200,
    'album Tags all broad title page': 20_500,
    'album Tags all broad added page': 21_800,
    'album Tags all broad count': 20_500,
    'album Tags all narrow title page': 2_400,
    'album Tags all narrow added page': 2_900,
    'album Tags all rare title page': 1_900,
    'album Tags all rare added page': 2_200,
    'album Tags all absent title page': 300,
    'album Tags all absent added page': 300,
    'track Tags auto narrow exclude added page': 10_200,
    'track Tags auto narrow exclude title page': 329_300,
    'track Tags auto broad deep page': 114_800,
    'track Tags auto sort page': 428_200,
    'track Tags auto sort deep page': 246_000,
    'track Tags track+album sort page': 424_900,
    'track Tags track+album sort deep page': 654_800,
    'track Tags all sort page': 426_600,
    'track Tags all sort deep page': 656_400,
    'album Tags auto sort page': 1_000,
    'album Tags auto sort deep page': 1_000,
    'album Tags track+album sort page': 2_800,
    'album Tags track+album sort deep page': 2_800,
    'album Tags all sort page': 3_500,
    'album Tags all sort deep page': 3_500,
    'track Tags auto hydrated page': 33_600,
    'track Tags auto live suggestions': 205_100,
    'track Tags track live suggestions': 267_200,
    'track Tags album live suggestions': 203_300,
    'track Tags artist live suggestions': 203_300,
    'track Tags track+album live suggestions': 205_100,
    'track Tags all live suggestions': 205_100,
    'album Tags auto live suggestions': 7_400,
    'album Tags track live suggestions': 132_300,
    'album Tags album live suggestions': 5_500,
    'album Tags artist live suggestions': 20_700,
    'album Tags track+album live suggestions': 137_700,
    'album Tags all live suggestions': 158_300,
    'track Tags auto stored suggestions': 900,
    'track Tags auto stored suggestions, nothing typed': 200,
    'track Tags track stored suggestions': 900,
    'track Tags track stored suggestions, nothing typed': 200,
    'track Tags album stored suggestions': 900,
    'track Tags album stored suggestions, nothing typed': 200,
    'track Tags artist stored suggestions': 900,
    'track Tags artist stored suggestions, nothing typed': 200,
    'track Tags track+album stored suggestions': 900,
    'track Tags track+album stored suggestions, nothing typed': 200,
    'track Tags all stored suggestions': 900,
    'track Tags all stored suggestions, nothing typed': 200,
  }
  const budget = (label: string) => budgets[label] ?? Number.MAX_SAFE_INTEGER
  // track_tag is read in one pass over a partial index, a hashed SubPlan or
  // the primary key of a page's rows: never probed once per track.
  async function expectSetReads(label: string, read: () => Promise<unknown>) {
    for (const scan of await trackTagScans(read)) {
      expect(
        scan['Actual Loops'],
        `${label} track_tag loops`,
      ).toBeLessThanOrEqual(1)
      if (scan['Index Name'])
        expect(scan['Index Name'], label).toMatch(
          /^track_tag_(tag_media_browse_idx|media_browse_idx|pkey)$/,
        )
    }
  }
  const query = (library: 'track' | 'album', input: Record<string, unknown>) =>
    library === 'track'
      ? TrackQuerySchema.parse({ size: 100, ...input })
      : AlbumQuerySchema.parse({ size: 100, ...input })
  const tideFilter = JSON.stringify([
    { field: 'genre', value: 'Location Tide' },
  ])
  try {
    for (const library of ['track', 'album'] as const)
      for (const [location, tagLevels] of tagLocations)
        for (const [tag, value, tagId] of locationTags) {
          const expected = await expectedAtLocation(library, tagLevels, tagId)
          process.stdout.write(
            `${library} Tags ${location} ${tag}: ${expected} expected\n`,
          )
          const filters = JSON.stringify([{ field: 'genre', value }])
          for (const [sort, sortBy, direction] of [
            ['title', 'title', 'asc'],
            ['added', 'dateAdded', 'desc'],
          ] as const) {
            const read = async () => {
              const page = await queryBrowsePageIds(
                library,
                query(library, { sortBy, direction, filters, tagLevels }),
              )
              if (expected >= 110) expect(page.ids).toHaveLength(100)
              else {
                expect(page.ids.length).toBeLessThanOrEqual(expected)
                expect(page.ids.length).toBeGreaterThan(expected - 10)
              }
            }
            const label = `${library} Tags ${location} ${tag} ${sort} page`
            await checkBudget(label, budget(label), 1, read, 10_000)
            await expectSetReads(label, read)
          }
          if (tag !== 'broad') continue
          const label = `${library} Tags ${location} broad count`
          await checkBudget(label, budget(label), 3, async () => {
            const { totalCount } = await queryBrowseCount(
              library,
              query(library, { filters, tagLevels }),
            )
            expect(totalCount).toBeLessThanOrEqual(expected)
            expect(totalCount).toBeGreaterThan(expected - 10)
          })
        }
    for (const [sort, sortBy, direction] of [
      ['added', 'dateAdded', 'desc'],
      ['title', 'title', 'asc'],
    ] as const) {
      const label = `track Tags auto narrow exclude ${sort} page`
      const read = async () => {
        const page = await queryBrowsePageIds(
          'track',
          query('track', {
            sortBy,
            direction,
            filters: JSON.stringify([
              { field: 'genre', value: 'Location Narrow', mode: 'exclude' },
            ]),
          }),
        )
        expect(page.ids).toHaveLength(100)
      }
      await checkBudget(label, budget(label), 1, read, 10_000)
      await expectSetReads(label, read)
    }
    const deep = async () => {
      const page = await queryBrowsePageIds(
        'track',
        query('track', {
          sortBy: 'title',
          direction: 'asc',
          page: 40,
          filters: tideFilter,
        }),
      )
      expect(page.ids).toHaveLength(100)
    }
    const deepLabel = 'track Tags auto broad deep page'
    await checkBudget(deepLabel, budget(deepLabel), 1, deep, 10_000)
    await expectSetReads(deepLabel, deep)
    for (const library of ['track', 'album'] as const)
      for (const [location, tagLevels] of [
        tagLocations[0],
        tagLocations[4],
        tagLocations[5],
      ])
        for (const [name, page] of [
          ['sort', 1],
          ['sort deep', 9],
        ] as const) {
          const label = `${library} Tags ${location} ${name} page`
          const read = async () => {
            const result = await queryBrowsePageIds(
              library,
              query(library, {
                sortBy: 'genre',
                direction: 'asc',
                page,
                tagLevels,
              }),
            )
            expect(result.ids).toHaveLength(100)
          }
          await checkBudget(label, budget(label), 1, read)
          await expectSetReads(label, read)
        }
    const hydrate = async () => {
      const result = await listTrackBrowsePage(
        query('track', {
          sortBy: 'dateAdded',
          direction: 'desc',
          filters: JSON.stringify([
            { field: 'genre', value: 'Location Narrow' },
          ]),
        }),
      )
      expect(result.items).toHaveLength(100)
    }
    const hydrateLabel = 'track Tags auto hydrated page'
    await checkBudget(hydrateLabel, budget(hydrateLabel), 2, hydrate)
    // Suggestions count what the filter matches at each location.
    const countAt = async (
      library: 'track' | 'album',
      tagLevels: string | undefined,
    ) =>
      (
        await queryBrowseCount(
          library,
          query(library, { filters: tideFilter, tagLevels }),
        )
      ).totalCount
    for (const library of ['track', 'album'] as const)
      for (const [location, tagLevels] of tagLocations) {
        const label = `${library} Tags ${location} live suggestions`
        const total = await countAt(library, tagLevels)
        const fields = (
          library === 'track' ? trackBrowseFields : albumBrowseFields
        ).filter((field) => field.key === 'genre')
        await checkBudget(label, budget(label), 4, async () => {
          const facets = await listBrowseFacets(
            library,
            { q: 'location tide', tagLevels },
            { fields },
          )
          expect(
            facets.find(({ value }) => value === 'location tide'),
            label,
          ).toMatchObject({ field: 'genre', count: total })
        })
      }
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
    await pool.query('vacuum analyze track_facet_value')
    for (const [location, tagLevels] of tagLocations) {
      const total = await countAt('track', tagLevels)
      for (const q of ['location tide', '']) {
        const label = `track Tags ${location} stored suggestions${q ? '' : ', nothing typed'}`
        await checkBudget(label, budget(label), 4, async () => {
          const facets = await listBrowseFacets('track', { q, tagLevels })
          const tide = facets.find(
            ({ field, value }) =>
              field === 'genre' && value === 'location tide',
          )
          if (q) expect(tide, label).toMatchObject({ count: total })
          else if (tide) expect(tide.count, label).toBe(total)
        })
      }
    }
  } finally {
    await clearTagLocationFixture()
  }
})
