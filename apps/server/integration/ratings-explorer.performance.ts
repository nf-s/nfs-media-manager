import { expect, it, vi } from 'vitest'
import { RatingsRankingRequestSchema } from '@repo/schemas/ratings-explorer'
import {
  createTrackPerformanceFixture,
  ExplainSchema,
} from './fixtures/track-performance'

const { database, pool, checkBudget, logQuery } =
  createTrackPerformanceFixture()
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

// Replay the measured plan with only the exact count removed. Both variants
// still normalize, filter, sort and construct the same page of evidence.
async function measureExactCount(count: number) {
  const statement = logQuery.mock.calls.at(-1)
  if (!statement) throw new Error('Expected a recorded ranking statement')
  const [sql, params] = statement
  const withoutCount = sql.replace('(select count(*)::int from eligible)', '0')
  expect(withoutCount).not.toBe(sql)
  async function executionTime(query: string) {
    const result = await pool.query(
      'explain (analyze, timing off, format json, buffers) ' + query,
      params,
    )
    return ExplainSchema.parse(result.rows)[0]['QUERY PLAN'][0][
      'Execution Time'
    ]
  }
  const pageMs = await executionTime(withoutCount)
  const countedMs = await executionTime(sql)
  process.stdout.write(
    `Exact-count comparison for ${count} films: ${pageMs.toFixed(1)} ms page only, ${countedMs.toFixed(1)} ms page with total on a warm connection\n`,
  )
}

it('bounds the ranking page at two film library sizes and after a rating edit', async () => {
  const { rankRatings } = await import('@/services/ratings-explorer')
  const request = RatingsRankingRequestSchema.parse({
    library: 'film',
    limit: 40,
  })
  const sizes: number[] = []
  let total = 0
  for (const count of [1500, 12000]) {
    await pool.query(
      `
      insert into media_item(id,slug,title,media_type,metadata)
      select 'film-' || i,'film-' || i,'Fixture film ' || i,'film',
        jsonb_build_object('browse', jsonb_build_object(
          'ratingImdbValue', (i % 90 + 10) / 10.0, 'ratingImdbVotes', i % 1000 + 1,
          'ratingMetascore', i % 101, 'ratingTrakt', i % 99 + 1, 'ratingTraktVotes', i % 90 + 1,
          'ratingTmdbValue', (i % 89 + 10) / 10.0, 'ratingTmdbVotes', i % 950 + 1, 'ratingRt', i % 101,
          'ratingRtAudience', i % 101, 'ratingRtAudienceVotes', i % 700 + 1, 'ratingImdbPersonal', i % 10 + 1))
      from generate_series($1::int + 1, $2::int) i
    `,
      [total, count],
    )
    total = count
    // A compact rating read must not repeatedly detoast unrelated stored
    // metadata while extracting different fields from the same item.
    if (count === 1500)
      await pool.query(`update media_item m set metadata = metadata || jsonb_build_object(
        'fixture_notes', (select string_agg(md5(m.id || '-' || s), '') from generate_series(1, 128) s))
        where m.media_type='film' and substring(m.id from '[0-9]+$')::int <= 30`)
    await pool.query('analyze media_item')
    const result = await checkBudget(
      'Dense film ranking ' + count,
      1000,
      1,
      async () => {
        const start = performance.now()
        const page = await rankRatings(request)
        process.stdout.write(
          `Dense film ranking ${count}: ${Buffer.byteLength(JSON.stringify(page))} response bytes, ${(performance.now() - start).toFixed(1)} ms to service rows including exact total\n`,
        )
        return page
      },
    )
    expect(result.total).toBe(count)
    expect(result.rows).toHaveLength(request.limit)
    const size = Buffer.byteLength(JSON.stringify(result))
    expect(size).toBeLessThan(80_000)
    sizes.push(size)
    await measureExactCount(count)
  }
  expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.15)
  await pool.query(`update media_item set metadata = jsonb_set(metadata, '{browse,ratingRt}', '100')
    where id = 'film-1'`)
  const edited = await checkBudget(
    'Edited film ranking and deep offset',
    1000,
    1,
    () =>
      rankRatings({
        ...request,
        offset: total - 10,
        settings: {
          ...request.settings,
          combine: 'median',
          outlierDistance: 25,
        },
      }),
  )
  expect(edited.total).toBe(total)
  expect(edited.rows).toHaveLength(10)
})

it('bounds sparse album rankings with unrated rows and missing source values', async () => {
  const { rankRatings } = await import('@/services/ratings-explorer')
  const req = RatingsRankingRequestSchema.parse({
    library: 'album',
    sort: 'spread',
    limit: 40,
    scoredOnly: false,
  })
  const unrated = await checkBudget(
    'Packed unrated album ranking',
    300,
    1,
    () => rankRatings(req),
  )
  expect(unrated.total).toBe(1000)
  expect(unrated.rows.every((row) => row.counted === 0)).toBe(true)
  await pool.query(`update media_item set metadata =
    case when substring(id from '[0-9]+$')::int % 3 = 0
      then '{"browse":{"ratingDiscogsValue":3.5,"ratingDiscogsVotes":12,"ratingMetacriticValue":60,"ratingMetacriticVotes":15}}'::jsonb
      else '{"browse":{}}'::jsonb end where media_type='album'`)
  await pool.query('analyze media_item')
  // The update can place album versions in free space on film heap pages.
  // One run needed 674 heap and 3 index pages to read the members, with one
  // more index page for editions. Allow scoring 25 blocks above that scan.
  const baseline =
    await pool.query(`explain (analyze, buffers, timing off, format json)
    select count(*) from media_item where media_type = 'album' and in_library
      and metadata->>'legacyHidden' is distinct from 'true'`)
  const plan = ExplainSchema.parse(baseline.rows)[0]['QUERY PLAN'][0].Plan
  const membershipBlocks =
    plan['Shared Hit Blocks'] + plan['Shared Read Blocks']
  process.stdout.write(
    `Updated album membership alone: ${membershipBlocks} shared blocks\n`,
  )
  const result = await checkBudget(
    'Sparse album ranking with unrated rows',
    Math.min(1050, membershipBlocks + 25),
    1,
    () => rankRatings(req),
  )
  expect(result.total).toBe(1000)
  expect(result.rows).toHaveLength(40)
  expect(result.rows[0]?.spread).toBe(0)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40_000)
})
