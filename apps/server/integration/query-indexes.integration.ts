import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { TagListQuerySchema } from '@repo/schemas/tags'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { SubscriptionItemQuerySchema } from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = `query_indexes_${randomUUID().replaceAll('-', '')}`
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
  options: '-c TimeZone=Pacific/Auckland',
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
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
  // Selective matches sit beyond the first page in an entirely synthetic library.
  await pool.query(`
    insert into media_item (id, slug, media_type, title, release_date)
    select 'film-' || n, 'film-' || n, 'film', 'Fixture film ' || n,
      case
        when n = 1 then timestamp '1969-12-31 23:59:59.999'
        when n = 2 then timestamp '1969-12-31 23:59:59.999999'
        when n = 3 then null
        when n > 19980 then timestamp '2026-01-01'
        else timestamp '1940-01-01' + n * interval '1 day'
      end
    from generate_series(1, 20000) n;
    insert into media_item (id, slug, media_type, title)
    select 'album-' || n, 'album-' || n, 'album', 'Fixture album ' || n
    from generate_series(1, 2000) n;
    insert into album (media_item_id) select id from media_item where media_type = 'album';
    insert into media_item (id, slug, media_type, title)
    select 'track-' || n, 'track-' || n, 'track', 'Fixture track ' || n
    from generate_series(1, 5000) n;
    insert into library_track (media_item_id, date_added)
    select 'track-' || n,
      case when n > 4980 then timestamp '2026-01-01'
        else timestamp '2020-01-01' + n * interval '1 hour' end
    from generate_series(1, 5000) n;
    insert into artist (id, name)
    select 'artist-' || n, case when n > 19990 then 'Needle artist ' else 'Fixture artist ' end || n
    from generate_series(1, 20000) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'film-' || n, 'artist-' || n, 'actor' from generate_series(1, 20000) n;
    insert into tag (id, media_type, name, kind)
    select 'tag-' || n, 'film', case when n > 19990 then 'Needle tag ' else 'Fixture tag ' end || n, 'keyword'
    from generate_series(1, 20000) n;
    insert into media_item_tag (media_item_id, tag_id)
    select 'film-' || n, 'tag-' || n from generate_series(1, 20000) n;
    insert into tag_identity (media_type, normalized_name, kind, tag_id)
    select media_type, lower(name), kind, id from tag;
    insert into tag_occurrence (id, media_item_id, tag_id, raw_name, kind)
    select 'occurrence-' || n, 'film-' || n, 'tag-' || n,
      case when n > 19990 then 'Needle raw ' else 'Fixture raw ' end || n, 'keyword'
    from generate_series(1, 20000) n;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, album_name,
      track_name, artist_key, album_key, track_key, album_media_item_id)
    select 'scrobble-' || n, 'fixture-listener',
      case when n > 99980 then timestamp '2026-01-01' else timestamp '2020-01-01' end,
      'Fixture artist', 'Fixture album', 'Fixture track',
      'fixture artist', 'fixture album', 'fixture track', 'album-' || (n % 2000 + 1)
    from generate_series(1, 100000) n;
    insert into subscription_source (id, type, title)
    select 'UC' || lpad(n::text, 22, '0'), 'youtube',
      case when n > 19990 then 'Needle source ' else 'Fixture source ' end || n
    from generate_series(1, 20000) n;
    insert into subscription_item (id, source_id, type, title, published_at, duration_sec, search)
    select 'video' || lpad(n::text, 6, '0'), 'UC' || lpad(n::text, 22, '0'), 'youtube',
      case when n > 19990 then 'Needle video ' else 'Fixture video ' end || n,
      timestamp '2026-01-01', case when n > 19980 then 3 else 1200 end, ''::tsvector
    from generate_series(1, 20000) n;
    insert into scrape_job (id, provider, status, scope, options, created_at)
    select 'job-' || n, 'fixture-provider', 'succeeded', '{"mediaType":"film"}'::jsonb,
      jsonb_build_object('batchId', case when n > 19980 then 'needle-batch' else 'fixture-batch' end),
      timestamp '2026-01-01' + n * interval '1 second'
    from generate_series(1, 20000) n;
  `)
  // Flush GIN pending lists after the bulk fixture load, as autovacuum does for
  // stored libraries, and give the planner current row/selectivity statistics.
  for (const table of [
    'media_item',
    'artist',
    'media_credit',
    'tag',
    'tag_identity',
    'tag_occurrence',
    'media_item_tag',
    'album',
    'library_track',
    'lastfm_scrobble',
    'subscription_source',
    'subscription_item',
    'scrape_job',
  ])
    await pool.query(`vacuum analyze ${table}`)
})

beforeEach(() => logQuery.mockClear())

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const PlanRowsSchema = z.array(z.object({ 'QUERY PLAN': z.string() }))

async function explain(query: string, params: unknown[] = []) {
  const result = await pool.query(
    `explain (analyze, buffers, format text) ${query}`,
    params,
  )
  return PlanRowsSchema.parse(result.rows)
    .map((row) => row['QUERY PLAN'])
    .join('\n')
}

async function explainServiceQuery(contains: string) {
  const query = logQuery.mock.calls.find(([query]) => query.includes(contains))
  if (!query) throw new Error(`Expected service query containing ${contains}`)
  return explain(...query)
}

function expectIndex(plan: string, name: string) {
  const indexes = [
    ...plan.matchAll(
      /(?:Index(?: Only)? Scan using|Bitmap Index Scan on) (\S+)/g,
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []))
  const scans = plan
    .split('\n')
    .filter((line) => /Seq Scan|Execution Time:/.test(line))
    .join('\n')
  expect(indexes, scans).toContain(name)
}

describe('library query index coverage', () => {
  // Let PostgreSQL choose each plan after ANALYZE; do not force index scans or
  // impose wall-clock limits that depend on the developer's machine.
  it('uses the stored timestamp indexes for selective date ranges', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const date = Date.parse('2026-01-01')
    const films = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({
        sortBy: 'title',
        ranges: [{ field: 'releaseDate', min: date, max: date }],
      }),
    )
    expect(films.totalCount).toBe(20)
    expectIndex(
      await explainServiceQuery('select count(*)::int from'),
      'media_item_type_release_id_idx',
    )

    logQuery.mockClear()
    const tracks = await queryBrowseIds(
      'track',
      TrackQuerySchema.parse({
        sortBy: 'title',
        ranges: [{ field: 'dateAdded', min: date, max: date }],
      }),
    )
    expect(tracks.totalCount).toBe(20)
    expectIndex(
      await explainServiceQuery('select count(*)::int from'),
      'library_track_added_id_idx',
    )
  })

  it('preserves inclusive UTC, fractional and out-of-range date bounds', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const ids = async (min?: number, max?: number, includeMissing = false) =>
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({
            sortBy: 'title',
            ranges: [{ field: 'releaseDate', min, max, includeMissing }],
          }),
        )
      ).ids

    expect(await ids(-1, -1)).toEqual(['film-1'])
    expect(await ids(-0.001, -0.001)).toEqual(['film-2'])
    expect(await ids(-1, -1, true)).toEqual(['film-3', 'film-1'])
    expect(await ids(undefined, -Number.MAX_VALUE, true)).toEqual(['film-3'])
  })

  it('finds selective creator suggestions through artist and reverse credit indexes', async () => {
    const { listBrowseFacets } = await import('@/services/browse')
    const facets = await listBrowseFacets('film', { q: 'Needle' })
    expect(facets.filter((facet) => facet.field === 'actor')).toHaveLength(10)
    const plan = await explainServiceQuery('values_for_field')
    expectIndex(plan, 'artist_name_search_idx')
    expectIndex(plan, 'media_credit_artist_role_media_idx')
    expectIndex(plan, 'media_item_title_search_idx')
    expectIndex(plan, 'tag_normalized_name_search_idx')
  })

  it('searches tag display names, recorded names and identities with substring indexes', async () => {
    const { listTags } = await import('@/services/tags')
    const page = await listTags(
      TagListQuerySchema.parse({ mediaType: 'film', q: 'Needle' }),
    )
    expect(page.totalCount).toBe(10)
    const plan = await explainServiceQuery('matching_tags')
    expectIndex(plan, 'tag_name_search_idx')
    expectIndex(plan, 'tag_occurrence_raw_name_search_idx')
    expectIndex(plan, 'tag_identity_name_search_idx')
  })

  it('reads only the selected listening period across albums with a leading date index', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const page = await queryBrowseIds(
      'album',
      AlbumQuerySchema.parse({
        listening: {
          match: 'all',
          rules: [
            {
              period: { kind: 'dates', from: '2026-01-01', to: '2026-01-01' },
              min: 1,
            },
          ],
        },
      }),
    )
    expect(page.totalCount).toBe(20)
    const plan = await explainServiceQuery('from lastfm_scrobble')
    expectIndex(plan, 'lastfm_scrobble_time_album_idx')
  })

  it('uses the duration expression index for subscription ranges that treat zero as unknown', async () => {
    const { listSubscriptionItems } =
      await import('@/services/subscription-library')
    const page = await listSubscriptionItems(
      SubscriptionItemQuerySchema.parse({
        ranges: [{ field: 'durationSec', min: 1, max: 5 }],
      }),
    )
    expect(page.totalCount).toBe(20)
    const plan = await explainServiceQuery('with matched_page as materialized')
    expectIndex(plan, 'subscription_item_duration_value_idx')
  })

  it('uses substring indexes for subscription title and source suggestions', async () => {
    const { listSubscriptionFacets } =
      await import('@/services/subscription-library')
    const facets = await listSubscriptionFacets({ q: 'Needle' })
    expect(facets.filter((facet) => facet.field === 'title')).toHaveLength(10)
    expect(facets.filter((facet) => facet.field === 'source')).toHaveLength(10)
    const plan = await explainServiceQuery('values_for_field')
    expectIndex(plan, 'subscription_item_title_search_idx')
    expectIndex(plan, 'subscription_source_title_search_idx')
  })

  it('uses an index for job chronology', async () => {
    const chronological = await explain(
      `select id from scrape_job order by created_at desc nulls last, id desc limit 50`,
    )
    expectIndex(chronological, 'scrape_job_created_id_idx')
  })

  it('uses an index for selective job batch lookups', async () => {
    const batch = await explain(
      `select id from scrape_job where options->>'batchId' = $1`,
      ['needle-batch'],
    )
    expectIndex(batch, 'scrape_job_batch_idx')
  })
})
