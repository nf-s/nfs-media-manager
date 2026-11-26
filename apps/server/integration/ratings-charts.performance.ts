import { expect, it, vi } from 'vitest'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { RatingsSourcesRequestSchema } from '@repo/schemas/ratings-explorer'
import { ratingsPointLimit } from '@repo/schemas/ratings-charts'
import { ratingsAgreement, ratingsCompare } from '@/services/ratings-charts'
import { rankRatings } from '@/services/ratings-explorer'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { database, pool, checkBudget } = createTrackPerformanceFixture()
const custom = 'plugin.fixture.chart'
const votes = 'plugin.fixture.votes'
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film', 'album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
    browseFields: [
      {
        key: custom,
        label: 'Fixture rating',
        type: 'number',
        filterable: true,
        rating: { provider: 'fixture', scale: 100, votesKey: votes },
      },
      { key: votes, label: 'Votes', type: 'number', filterable: true },
    ],
  },
  scrapeMediaItem: vi.fn(async () => {
    throw new Error('Unexpected provider read')
  }),
}
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [plugin],
}))

function reportBytes(label: string, page: unknown, ceiling: number) {
  const bytes = Buffer.byteLength(JSON.stringify(page))
  process.stdout.write(`${label}: ${bytes} response bytes\n`)
  expect(bytes).toBeLessThan(ceiling)
}

it.each(['film', 'album'])(
  'keeps %s chart reads bounded and drill-downs consistent across the full cohort',
  async (library) => {
    const critic =
      library === 'film' ? 'ratingMetascore' : 'ratingMetacriticValue'
    const prefix = 'chart-' + library + '-'
    // A recorded zero, a zero-vote observation, a missing vote count and an
    // unscored library item exercise the same inputs as interactive scoring.
    await pool.query(
      `insert into media_item(id, slug, title, media_type, release_date, metadata)
    select $1::text || i, $1::text || i, 'Chart fixture ' || i, $2, timestamp '2000-01-01' + i * interval '1 day',
      jsonb_build_object('browse', jsonb_build_object($3::text, i % 101, 'ratingMetacriticVotes', 15,
        $4::text, 100 - (i % 101), $5::text, case when i=1 then 0 when i=2 then null else 15 end,
        'ratingImdbPersonal', 1 + i % 10)) from generate_series(1,1200) i`,
      [prefix, library, critic, custom, votes],
    )
    await pool.query('analyze media_item')
    const base = RatingsSourcesRequestSchema.parse({
      library,
      search: 'Chart fixture',
      scoredOnly: false,
      settings: {
        normalization: 'scale',
        sources: [{ key: custom, weight: 1, minVotes: 10 }],
      },
    })
    const agreement = await checkBudget(library + ' agreement', 150, 1, () =>
      ratingsAgreement(base),
    )
    const compare = await checkBudget(library + ' compare', 150, 1, () =>
      ratingsCompare({ ...base, x: critic, y: custom }),
    )
    expect(agreement.total).toBe(1200)
    expect(compare.total).toBe(agreement.total)
    expect(agreement.libraryTotal).toBe(library === 'film' ? 1200 : 2200)
    expect(compare.libraryTotal).toBe(agreement.libraryTotal)
    expect(compare.count).toBe(1198)
    expect(compare.correlation).toBeCloseTo(-1, 10)
    expect(
      agreement.pairs.find(
        (p) => [p.x, p.y].includes(critic) && [p.x, p.y].includes(custom),
      ),
    ).toMatchObject({
      count: compare.count,
      correlation: expect.closeTo(-1, 10),
    })
    expect(agreement.bias.find((b) => b.key === custom)).toMatchObject({
      items: 1198,
    })
    expect(compare.points).toHaveLength(ratingsPointLimit)
    expect(compare).toMatchObject({ xMin: 0, xMax: 100, yMin: 0, yMax: 100 })
    expect(compare.xHigher[0]).toMatchObject({ x: 100, y: 0, yRaw: 0 })
    expect(compare.yHigher[0]).toMatchObject({ x: 0, y: 100, xRaw: 0 })
    reportBytes(library + ' agreement', agreement, 20_000)
    reportBytes(library + ' compare', compare, 100_000)
    const target = compare.yHigher[0]
    if (!target) throw new Error('Expected a ranked comparison outlier')
    const clicked = await rankRatings(
      { ...base, limit: 1, offset: 0, sort: 'score', direction: 'desc' },
      target.id,
    )
    expect(clicked.rows).toHaveLength(1)
    expect(clicked.rows[0]?.id).toBe(target.id)
    expect(clicked.rows[0]?.ratings).toContainEqual(
      expect.objectContaining({ key: critic, raw: 0, adjusted: target.x }),
    )
    const swapped = await ratingsCompare({ ...base, x: custom, y: critic })
    expect(swapped.count).toBe(compare.count)
    expect(swapped.meanGap).toBeCloseTo(-(compare.meanGap ?? 0), 10)
    expect(swapped.points.map((p) => p.id)).toEqual(
      compare.points.map((p) => p.id),
    )
    expect(swapped.yHigher[0]?.id).toBe(compare.xHigher[0]?.id)

    const range = { dimension: 'native.' + custom, first: 0, last: 0 }
    const ranged = { ...base, ranges: [range] }
    const rank = await rankRatings({
      ...ranged,
      limit: 1,
      offset: 0,
      sort: 'score',
      direction: 'desc',
    })
    const rangeCompare = await ratingsCompare({
      ...ranged,
      x: custom,
      y: 'year',
    })
    expect(rangeCompare.total).toBe(rank.total)
    expect(rangeCompare.count).toBeLessThan(compare.count)
    expect(rangeCompare).toMatchObject({
      meanGap: null,
      yHigher: [],
      xHigher: [],
    })
    const empty = await ratingsCompare({
      ...base,
      search: 'no fixture matches',
      x: 'score',
      y: 'spread',
    })
    expect(empty).toMatchObject({
      total: 0,
      count: 0,
      correlation: null,
      points: [],
      xMin: null,
      yMax: null,
    })
    await expect(
      ratingsCompare({ ...base, x: 'unknownField' }),
    ).rejects.toThrow('Unknown comparison axis')
    expect(fetch).not.toHaveBeenCalled()
    expect(plugin.scrapeMediaItem).not.toHaveBeenCalled()
  },
)

it('uses the 20-pair threshold, ignores constant axes and compares against other public sources', async () => {
  await pool.query(
    `insert into media_item(id,slug,title,media_type,release_date,metadata)
    select 'bias-' || i, 'bias-' || i, 'Bias fixture ' || i, 'film',
      case when i < 20 then date '1990-01-01' else date '1991-01-01' end,
      jsonb_build_object('browse',jsonb_build_object('ratingRt',i, 'ratingRtAudience',60,
        'ratingRtAudienceVotes',20, 'ratingImdbPersonal',10, $1::text,20+i, $2::text,20))
    from generate_series(1,20) i`,
    [custom, votes],
  )
  const base = RatingsSourcesRequestSchema.parse({
    library: 'film',
    search: 'Bias fixture',
    settings: { normalization: 'scale' },
  })
  const axes = { x: 'ratingRt', y: custom }
  const small = await ratingsCompare({ ...base, ...axes, yearTo: 1990 })
  expect(small).toMatchObject({ count: 19, correlation: null, meanGap: 20 })
  const full = await ratingsCompare({ ...base, ...axes })
  expect(full).toMatchObject({
    count: 20,
    correlation: expect.closeTo(1, 10),
    meanGap: 20,
  })
  const agreement = await ratingsAgreement(base)
  expect(
    agreement.pairs.find(
      (p) =>
        [p.x, p.y].includes('ratingRtAudience') && [p.x, p.y].includes(custom),
    ),
  ).toMatchObject({
    count: 20,
    correlation: null,
  })
  expect(
    agreement.bias.find((s) => s.key === 'ratingRtAudience'),
  ).toMatchObject({ items: 20, runs: 39.5, strays: 39.5 })
  expect(agreement.bias.find((s) => s.key === custom)?.runs).toBeCloseTo(-4.75)
  expect(
    agreement.bias.find((s) => s.key === 'ratingImdbPersonal')?.furthest,
  ).toBeNull()
  expect(agreement.lists.divided).toHaveLength(8)
  expect(agreement.lists.divided[0]?.id).toBe('bias-1')
  expect(agreement.lists.criticsHigher[0]?.id).toBe('bias-20')
  expect(agreement.lists.audiencesHigher[0]?.id).toBe('bias-1')
  const nineteen = await ratingsAgreement({ ...base, yearTo: 1990 })
  expect(
    nineteen.bias.find((s) => s.key === 'ratingRtAudience')?.furthest,
  ).toBe(1)
})

it('bounds agreement and compare at 12,000 dense film ratings', async () => {
  await pool.query(
    `insert into media_item(id,slug,title,media_type,metadata)
    select 'dense-' || i,'dense-' || i,'Dense fixture ' || i,'film',jsonb_build_object('browse', jsonb_build_object(
      'ratingImdbValue', (i%90+10)/10.0,'ratingImdbVotes',20,'ratingRt',i%101,'ratingMetascore',100-i%101,
      'ratingRtAudience',i%61,'ratingRtAudienceVotes',32,'ratingImdbPersonal',i%10+1,$1::text,i%93,$2::text,15))
    from generate_series(1,12000) i`,
    [custom, votes],
  )
  await pool.query('analyze media_item')
  const base = RatingsSourcesRequestSchema.parse({
    library: 'film',
    search: 'Dense fixture',
  })
  const agreement = await checkBudget('12k Film agreement', 1500, 1, () =>
    ratingsAgreement(base),
  )
  const compare = await checkBudget('12k Film compare', 1500, 1, () =>
    ratingsCompare({ ...base, x: 'ratingRt', y: 'ratingMetascore' }),
  )
  expect(agreement.total).toBe(12000)
  expect(compare.count).toBe(12000)
  expect(compare.points).toHaveLength(ratingsPointLimit)
  // Other visible fixtures also contribute to percentile normalization.
  expect(compare.correlation).toBeCloseTo(-1, 4)
  expect(
    agreement.pairs.find(
      (p) =>
        [p.x, p.y].includes('ratingRt') &&
        [p.x, p.y].includes('ratingMetascore'),
    )?.correlation,
  ).toBeCloseTo(compare.correlation ?? 0, 10)
  reportBytes('12k Film agreement', agreement, 20_000)
  reportBytes('12k Film compare', compare, 100_000)
})
