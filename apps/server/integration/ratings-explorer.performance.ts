import { expect, it, vi } from 'vitest'
import {
  RatingsRankingRequestSchema,
  RatingsSourcesRequestSchema,
  type RatingsRankingPage,
  type RatingsSourcesRequest,
} from '@repo/schemas/ratings-explorer'
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

async function measureSources(
  label: string,
  maxBlocks: number,
  request: RatingsSourcesRequest,
) {
  const { summarizeRatingsSources } =
    await import('@/services/ratings-explorer')
  const result = await checkBudget(label, maxBlocks, 1, async () => {
    const start = performance.now()
    const page = await summarizeRatingsSources(request)
    process.stdout.write(
      `${label}: ${Buffer.byteLength(JSON.stringify(page))} response bytes, ${(performance.now() - start).toFixed(1)} ms to service result\n`,
    )
    return page
  })
  expect(result.coverage).toHaveLength(result.sources.length)
  expect(result.histograms).toHaveLength(result.sources.length + 3)
  const bytes = Buffer.byteLength(JSON.stringify(result))
  expect(bytes).toBeLessThan(request.library === 'film' ? 12_000 : 5_000)
  expect(fetch).not.toHaveBeenCalled()
  return { result, bytes }
}

// Give the footer aggregate an empty input so PostgreSQL skips its scan.
// The page still reads the original eligible rows with the same parameters.
async function measureExactCount(page: RatingsRankingPage) {
  const statement = logQuery.mock.calls.at(-1)
  if (!statement) throw new Error('Expected a recorded ranking statement')
  const [sql, params] = statement
  const countInput =
    /(\bcounts as\s*\([\s\S]*?\bfrom eligible)(?=\s*\),\s*page as materialized\s*\()/g
  expect(sql.match(countInput)).toHaveLength(1)
  const withoutCount = sql.replace(countInput, '$1 where false')
  const replay = await pool.query<Record<string, unknown>>(withoutCount, params)
  expect(replay.rows).toEqual([
    {
      libraryTotal: page.libraryTotal,
      recorded: page.sources.map((source) => source.recorded),
      matchingTotal: 0,
      unscored: 0,
      total: 0,
      rows: page.rows,
    },
  ])
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
    `Exact-count comparison for ${page.matchingTotal} of ${page.libraryTotal} films: ${pageMs.toFixed(1)} ms without footer counts, ${countedMs.toFixed(1)} ms with footer counts on a warm connection\n`,
  )
}

it('bounds the ranking page at two film library sizes and after a rating edit', async () => {
  const { rankRatings } = await import('@/services/ratings-explorer')
  const request = RatingsRankingRequestSchema.parse({
    library: 'film',
    limit: 40,
  })
  const sizes: number[] = []
  const sourcesSizes: number[] = []
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
      (count === 1500 ? 320 : 1000) + request.limit * 8,
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
    await measureExactCount(result)
    const requestSources = RatingsSourcesRequestSchema.parse({
      library: 'film',
    })
    const sources = await measureSources(
      'Dense film Sources ' + count,
      count === 1500 ? 320 : 1000,
      requestSources,
    )
    expect(sources.result.total).toBe(count)
    expect(sources.result.coverage).toContainEqual({
      key: 'ratingRt',
      recorded: count,
      eligible: count,
    })
    sourcesSizes.push(sources.bytes)
    if (count === 12000) {
      // Searching also scans 165 credit blocks for director names.
      const filters = {
        ...requestSources,
        search: 'fixture film 11',
        ranges: [
          { dimension: 'native.ratingRt', first: 2, last: 3 },
          { dimension: 'score', first: 1, last: 3 },
        ],
      }
      const selected = await measureSources(
        'Film Sources with two ranges and title filter',
        1200,
        filters,
      )
      expect(selected.result.total).toBeGreaterThan(0)
      expect(selected.result.total).toBeLessThan(count)
      const filtered = await rankRatings({ ...request, ...filters, offset: 3 })
      expect(filtered.total).toBe(selected.result.total)
      expect(filtered.rows.length).toBeGreaterThan(0)
      for (const row of filtered.rows) {
        expect(row.title.toLowerCase()).toContain(filters.search)
        const raw = row.ratings.find((source) => source.key === 'ratingRt')?.raw
        expect(raw).toBeGreaterThanOrEqual(20)
        expect(raw).toBeLessThan(40)
        expect(row.score).toBeGreaterThanOrEqual(10)
        expect(row.score).toBeLessThan(40)
      }
      await measureExactCount(filtered)
    }
  }
  expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.15)
  expect(Math.max(...sourcesSizes) / Math.min(...sourcesSizes)).toBeLessThan(
    1.15,
  )
  await pool.query(`update media_item set metadata = jsonb_set(metadata, '{browse,ratingRt}', '100')
    where id = 'film-1'`)
  const edited = await checkBudget(
    'Edited film ranking and deep offset',
    1000 + 10 * 8,
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
    40 + req.limit * 14,
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
    Math.min(1050, membershipBlocks + 25) + req.limit * 14,
    1,
    () => rankRatings(req),
  )
  expect(result.total).toBe(1000)
  expect(result.rows).toHaveLength(40)
  expect(result.rows[0]?.spread).toBe(0)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40_000)
  const sourcesRequest = RatingsSourcesRequestSchema.parse({
    library: 'album',
    scoredOnly: false,
  })
  const small = await measureSources(
    'Sparse album Sources 1000',
    Math.min(1050, membershipBlocks + 25),
    sourcesRequest,
  )
  expect(small.result.total).toBe(1000)
  expect(small.result.coverage).toContainEqual({
    key: 'ratingDiscogsValue',
    recorded: 333,
    eligible: 333,
  })
  await pool.query(`insert into media_item(id, slug, title, media_type, metadata)
    select 'extra-album-' || i, 'extra-album-' || i, 'Extra fixture album ' || i, 'album',
      case when i % 3 = 0 then '{"browse":{"ratingDiscogsValue":4.5,"ratingDiscogsVotes":11,"ratingMetacriticValue":80,"ratingMetacriticVotes":7}}'::jsonb
      else '{"browse":{}}'::jsonb end from generate_series(1001, 8000) i`)
  await pool.query(`insert into album(media_item_id)
    select 'extra-album-' || i from generate_series(1001, 8000) i`)
  await pool.query('analyze media_item')
  await pool.query('analyze album')
  const large = await measureSources(
    'Sparse album Sources 8000',
    1100,
    sourcesRequest,
  )
  expect(large.result.total).toBe(8000)
  expect(large.result.coverage).toContainEqual({
    key: 'ratingDiscogsValue',
    recorded: 2666,
    eligible: 2666,
  })
  expect(large.bytes / small.bytes).toBeLessThan(1.15)

  // Exercise the Album table's actual projection with populated relations.
  // Its tags, credits and playback references must only be hydrated for the
  // requested page, even though normalization still sees 8,000 albums.
  await pool.query(`
    insert into tag(id,media_type,name) values('fixture-style','album','Fixture style');
    insert into media_item_tag(media_item_id,tag_id) select media_item_id,'fixture-style' from album;
    insert into media_credit(media_item_id,artist_id,role) select media_item_id,
      'artist-' || (1 + substring(media_item_id from '[0-9]+$')::int % 1000), 'artist' from album;
    insert into external_link(id,media_item_id,provider,label,url) select 'link-' || media_item_id,
      media_item_id,'fixture','Listen','https://open.spotify.com/album/' || lpad(substring(media_item_id from '[0-9]+$'),22,'0') from album;
    insert into provider_reference(id,media_item_id,provider,reference_type,external_id) select 'ref-' || media_item_id,
      media_item_id,'fixture','spotify',lpad(substring(media_item_id from '[0-9]+$'),22,'0') from album;
    update album set track_count=10;
    analyze album; analyze media_item_tag; analyze media_credit; analyze external_link; analyze provider_reference;
  `)
  const hydrated = await checkBudget(
    'Populated 40-row Album table in 8000 albums',
    2400,
    1,
    () => rankRatings(req),
  )
  expect(hydrated.total).toBe(8000)
  expect(hydrated.rows).toHaveLength(40)
  for (const row of hydrated.rows) {
    expect(row.credits).toHaveLength(1)
    expect(row.tags).toEqual(['Fixture style'])
    expect(row.album?.trackCount).toBe(10)
    expect(row.album?.links).toHaveLength(1)
    expect(row.album?.providerReferences).toHaveLength(1)
  }
  const bytes = Buffer.byteLength(JSON.stringify(hydrated))
  process.stdout.write(`40 populated album rows: ${bytes} response bytes\n`)
  expect(bytes).toBeLessThan(60_000)
  expect(fetch).not.toHaveBeenCalled()
})
