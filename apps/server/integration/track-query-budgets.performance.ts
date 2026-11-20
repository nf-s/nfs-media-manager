import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { trackBrowseFields } from '@repo/schemas/browse'
import { SpotifyTrackAuditQuerySchema } from '@repo/schemas/spotify-track-search'
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

it('bounds broad, selective, empty and deep Spotify match audit pages', async () => {
  const { listSpotifyTrackMatchAudit } =
    await import('@/services/spotify-track-match-audit-list')
  const ownerId = 'audit-budget-owner'
  await pool.query(`
    insert into "user" (id, name, email) values
      ('audit-budget-owner', 'Fixture owner', 'audit-owner@example.test'),
      ('audit-budget-other', 'Fixture other owner', 'audit-other@example.test');
    insert into spotify_track_match_audit
      (owner_id, track_id, assessment, candidate_count, search_text, report)
    select a.owner_id, mi.id, a.assessment, 1, lower(mi.title) ||
        case when n = 250 then ' quartz-window' else '' end,
      jsonb_build_object('trackId', mi.id, 'title', mi.title, 'artists', jsonb_build_array('Fixture artist'),
        'albums', '[]'::jsonb, 'durations', '[174]'::jsonb, 'assessment', a.assessment, 'summary', 'Fixture audit',
        'candidates', jsonb_build_array(jsonb_build_object(
          'spotifyTrackId', repeat('1', 22), 'title', mi.title, 'artists', jsonb_build_array('Fixture artist'),
          'albumName', 'Fixture album', 'durationSec', 174, 'assessment', a.assessment,
          'spotifyUrl', 'https://open.spotify.com/track/' || repeat('1', 22),
          'summary', 'Fixture candidate', 'reasons', '[]'::jsonb,
          'searchedAt', '2026-01-01T00:00:00.000Z', 'historical', false)))
    from generate_series(1, 3200) n join media_item mi on mi.id = 'track-' || n
    cross join lateral (select
      case when n <= 1200 then 'audit-budget-owner' else 'audit-budget-other' end as owner_id,
      case when n % 20 = 0 then 'likely' when n % 5 = 0 then 'review' else 'unlikely' end as assessment
    ) a
  `)
  await pool.query('vacuum analyze spotify_track_match_audit')
  const queries = [
    { label: 'first', parameters: {}, expected: 'track-20', count: 1200 },
    {
      label: 'selective',
      parameters: { q: 'QUARTZ-WINDOW', assessment: 'review' },
      expected: 'track-250',
      count: 1,
    },
    {
      label: 'miss',
      parameters: { q: 'missing fixture term' },
      expected: undefined,
      count: 0,
    },
    {
      label: 'deep',
      parameters: { page: 47, sort: 'title' },
      expected: 'track-1151',
      count: 1200,
    },
  ]
  for (const { label, parameters, expected, count } of queries) {
    await checkBudget('Spotify match audit ' + label, 12_000, 1, async () => {
      const page = await listSpotifyTrackMatchAudit(
        ownerId,
        SpotifyTrackAuditQuerySchema.parse(parameters),
      )
      expect(page.totalTracks).toBe(1200)
      expect(page.totalCandidates).toBe(1200)
      expect(page.counts).toEqual({ likely: 60, review: 180, unlikely: 960 })
      expect(page.totalCount).toBe(count)
      expect(page.items[0]?.trackId).toBe(expected)
    })
  }
})

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
  const { queryBrowseCounts } = await import('@/services/browse')
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
    values ('fixture-listener', 'fixture-artist', 'fixture-track-1', 'track-1', 'normalized');
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

it('bounds first Added pages with artist tags and unrelated Last.fm placeholders', async () => {
  const { queryBrowsePageIds, queryBrowsePositions } =
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
