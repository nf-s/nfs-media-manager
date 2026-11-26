import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import {
  RatingsRankingRequestSchema,
  RatingsSourcesRequestSchema,
  type RatingsRankingRequest,
  type RatingsSourcesPage,
} from '@repo/schemas/ratings-explorer'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import {
  rankRatings,
  summarizeRatingsSources,
} from '@/services/ratings-explorer'

const name = 'ratings_explorer_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const database = drizzle(pool, { schema })
const pluginKey = 'plugin.fixture.score'
const votesKey = 'plugin.fixture.votes'
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['album', 'film'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    browseFields: [
      {
        key: pluginKey,
        label: 'Fixture score',
        type: 'number',
        filterable: true,
        rating: { provider: 'fixture', scale: 100, votesKey },
      },
      {
        key: votesKey,
        label: 'Fixture votes',
        type: 'number',
        filterable: true,
      },
      {
        key: 'ratingRt',
        label: 'Duplicate',
        type: 'number',
        filterable: true,
        rating: { provider: 'fixture', scale: 3 },
      },
      {
        key: 'plugin.fixture.text',
        label: 'Non-numeric',
        type: 'text',
        filterable: true,
        rating: { provider: 'fixture', scale: 10 },
      },
    ],
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
  listLoadedScrapePlugins: async () => [plugin],
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network access')
    }),
  )
  await admin.connect()
  await admin.query('create database ' + name)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await database.delete(schema.mediaItem)
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.unstubAllGlobals()
})

function page(input: Record<string, unknown> = {}) {
  return rankRatings(
    RatingsRankingRequestSchema.parse({
      library: 'film',
      scoredOnly: false,
      ...input,
    }),
  )
}
function summary(input: Record<string, unknown> = {}) {
  return summarizeRatingsSources(
    RatingsSourcesRequestSchema.parse({
      library: 'film',
      scoredOnly: false,
      ...input,
    }),
  )
}
function bins(summary: RatingsSourcesPage, dimension: string) {
  const histogram = summary.histograms.find(
    (entry) => entry.dimension === dimension,
  )
  if (!histogram) throw new Error('Missing histogram ' + dimension)
  return histogram.bins
}
function weight(key: string, value: number, minVotes = 0) {
  return { key, weight: value, minVotes }
}
async function film(
  id: string,
  browse: Record<string, number | string | boolean | null>,
) {
  await database.insert(schema.mediaItem).values({
    id,
    slug: id,
    mediaType: 'film',
    title: id,
    metadata: { browse },
  })
}

it('normalizes against visible library members before filtering, sorting and exact pagination', async () => {
  for (const [index, rating] of [2, 4, 4, 8].entries())
    await film('film-' + index, {
      ratingImdbValue: rating,
      ratingImdbVotes: 20,
    })
  await pool.query(`
    insert into media_item (id, slug, title, media_type, in_library, metadata) values
      ('hidden','hidden','Hidden','film',true,'{"legacyHidden":true,"browse":{"ratingImdbValue":10,"ratingImdbVotes":20}}'),
      ('outside','outside','Outside','film',false,'{"browse":{"ratingImdbValue":10,"ratingImdbVotes":20}}'),
      ('album','album','Album','album',true,'{"browse":{"ratingImdbValue":10,"ratingImdbVotes":20}}');
    update media_item set release_date = '2017-03-01' where id = 'film-1';
    insert into film (media_item_id, watched) values ('film-1', true);
    insert into artist (id,name) values ('director','Fixture director');
    insert into media_credit (media_item_id,artist_id,role) values ('film-1','director','director');
    insert into tag (id,media_type,name) values ('drama','film','Drama');
    insert into media_item_tag (media_item_id,tag_id) values ('film-1','drama');
  `)
  const full = await page({ sort: 'ratingImdbValue', direction: 'asc' })
  expect(full.total).toBe(4)
  expect(
    full.rows.map(
      (row) =>
        row.ratings.find((rating) => rating.key === 'ratingImdbValue')
          ?.adjusted,
    ),
  ).toEqual([12.5, 50, 50, 87.5])
  expect(full.rows.map((row) => row.id)).toEqual([
    'film-0',
    'film-1',
    'film-2',
    'film-3',
  ])
  const filtered = await page({
    search: 'DIRECTOR',
    tag: 'drama',
    watched: true,
    yearFrom: 2017,
    yearTo: 2017,
  })
  expect(filtered.rows).toEqual([full.rows[1]])
  const visible = await summary({
    search: 'DIRECTOR',
    tag: 'drama',
    watched: true,
    yearFrom: 2017,
    yearTo: 2017,
    settings: { minSources: 1 },
  })
  expect(visible.total).toBe(1)
  expect(bins(visible, 'native.ratingImdbValue')[4]).toEqual({
    lower: 4,
    upper: 5,
    upperInclusive: false,
    count: 1,
  })
  expect(bins(visible, 'score').map((bin) => bin.count)).toEqual([
    0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
  ])
  expect((await summary()).total).toBe(4)
  expect(await page({ search: 'film-%' })).toMatchObject({ total: 0, rows: [] })
  expect(await page({ offset: 4 })).toMatchObject({ total: 4, rows: [] })
  expect(
    await page({
      offset: 2,
      limit: 1,
      sort: 'ratingImdbValue',
      direction: 'asc',
    }),
  ).toMatchObject({ total: 4, rows: [{ id: 'film-2' }] })
  await pool.query(
    "update media_item set metadata = jsonb_set(metadata, '{browse,ratingImdbValue}', '10') where id='film-1'",
  )
  expect((await page({ sort: 'ratingImdbValue' })).rows[0]?.id).toBe('film-1')
  expect(bins(await summary(), 'native.ratingImdbValue').at(-1)?.count).toBe(1)
})

it('shows native scores, independent vote counts, group gaps and both combination weights', async () => {
  await film('target', {
    ratingImdbValue: 8,
    ratingImdbVotes: 20,
    ratingImdbPersonal: 9,
    ratingMetascore: 20,
    [votesKey]: 0,
  })
  await film('baseline', { ratingRt: 50, [pluginKey]: '100' })
  const result = await page({
    search: 'target',
    settings: {
      normalization: 'scale',
      sources: [weight('ratingImdbValue', 2)],
    },
  })
  expect(result.sources).toContainEqual(
    expect.objectContaining({
      key: pluginKey,
      group: 'other',
      hasVotes: true,
      votesKey,
    }),
  )
  expect(result.sources.filter((source) => source.key === 'ratingRt')).toEqual([
    expect.objectContaining({
      label: 'Rotten Tomatoes',
      scale: 100,
      group: 'critics',
    }),
  ])
  expect(
    result.sources.some((source) => source.key === 'plugin.fixture.text'),
  ).toBe(false)
  expect(result.rows[0]).toMatchObject({
    counted: 2,
    core: 60,
    observedWeight: 3,
    missingWeight: 0.5,
    missingSum: 25,
    spread: 30,
    criticGap: -60,
  })
  expect(result.rows[0]?.score).toBeCloseTo(58.57142857)
  expect(result.rows[0]?.personalGap).toBeCloseTo(90 - 58.57142857)
  expect(result.rows[0]?.ratings).toContainEqual({
    key: pluginKey,
    adjusted: null,
    raw: null,
    votes: 0,
    center: null,
    status: 'missing',
  })
  expect(result.rows[0]?.ratings).toContainEqual(
    expect.objectContaining({
      key: 'ratingImdbPersonal',
      raw: 9,
      adjusted: 90,
      status: 'disabled',
    }),
  )
  expect(
    await page({ scoredOnly: true, settings: { minSources: 3 } }),
  ).toMatchObject({ rows: [], total: 0 })
  expect(
    (
      await page({
        search: 'target',
        settings: {
          normalization: 'scale',
          combine: 'median',
          missingWeight: 0,
        },
      })
    ).rows[0]?.score,
  ).toBe(50)
  expect(
    (
      await page({
        search: 'target',
        settings: {
          normalization: 'scale',
          combine: 'median',
          missingWeight: 0,
          sources: [weight('ratingImdbValue', 1.5)],
        },
      })
    ).rows[0]?.score,
  ).toBe(80)
})

it('requires a majority for outliers, and trims endpoints only inside the mean', async () => {
  await film('majority', {
    ratingRt: 10,
    ratingTrakt: 80,
    ratingTraktVotes: 20,
    [pluginKey]: 82,
    [votesKey]: 10,
  })
  await film('split', {
    ratingRt: 10,
    ratingMetascore: 12,
    ratingTrakt: 80,
    ratingTraktVotes: 20,
    [pluginKey]: 82,
    [votesKey]: 10,
  })
  await film('empty', {})
  const request = {
    settings: {
      normalization: 'scale',
      outlierDistance: 25,
      combine: 'trimmed',
      sources: [weight('ratingRt', 3)],
    },
  }
  const { rows } = await page(request)
  const coverage = (await summary(request)).coverage
  expect(coverage).toContainEqual({ key: 'ratingRt', recorded: 2, eligible: 0 })
  expect(coverage).toContainEqual({ key: pluginKey, recorded: 2, eligible: 1 })
  expect(coverage).toContainEqual({
    key: 'ratingTrakt',
    recorded: 2,
    eligible: 2,
  })
  const majority = rows.find((row) => row.id === 'majority')
  const split = rows.find((row) => row.id === 'split')
  expect(majority).toMatchObject({
    counted: 2,
    core: 81,
    spread: 1,
    observedWeight: 2,
    missingWeight: 2,
    missingSum: 21,
  })
  expect(majority?.ratings).toContainEqual(
    expect.objectContaining({ key: 'ratingRt', status: 'outlier' }),
  )
  expect(split).toMatchObject({
    counted: 4,
    core: 46,
    observedWeight: 6,
    missingWeight: 0,
    score: 46,
  })
  expect(
    split?.ratings
      .filter((rating) => rating.status === 'trimmed')
      .map((rating) => rating.key)
      .sort(),
  ).toEqual([pluginKey, 'ratingRt'])
  expect(rows.find((row) => row.id === 'empty')).toMatchObject({
    counted: 0,
    core: null,
    score: null,
    observedWeight: 0,
    missingWeight: 3,
  })
})

it('keeps legal zeros and ties, rejects malformed data and distinguishes missing votes from zero', async () => {
  await film('zero', {
    ratingImdbValue: 0,
    ratingRt: 0,
    [pluginKey]: 4,
    [votesKey]: 0,
  })
  await film('unknown', { ratingImdbValue: 11, ratingRt: '0', [pluginKey]: 4 })
  await film('rated', {
    ratingImdbValue: true,
    ratingRt: -2,
    [pluginKey]: 4,
    [votesKey]: 1,
  })
  await film('bad', { [pluginKey]: 101, [votesKey]: 2.5 })
  for (const normalization of ['standardized', 'percentile']) {
    const result = await page({
      sort: pluginKey,
      direction: 'desc',
      settings: {
        normalization,
        sources: [weight(pluginKey, 1, 1)],
        minSources: 1,
      },
    })
    expect(result.rows.map((row) => row.id)).toEqual([
      'rated',
      'unknown',
      'zero',
      'bad',
    ])
    const fixture = result.rows.map((row) =>
      row.ratings.find((rating) => rating.key === pluginKey),
    )
    expect(fixture.map((r) => [r?.adjusted, r?.status, r?.votes])).toEqual([
      [50, 'counted', 1],
      [50, 'votes', null],
      [50, 'votes', 0],
      [null, 'missing', null],
    ])
    expect(
      result.rows.every(
        (row) =>
          row.ratings.find((r) => r.key === 'ratingImdbValue')?.raw === null,
      ),
    ).toBe(true)
    expect(
      result.rows.find((row) => row.id === 'zero')?.ratings,
    ).toContainEqual(
      expect.objectContaining({ key: 'ratingRt', raw: 0, status: 'counted' }),
    )
    expect(
      (await page({ sort: pluginKey, direction: 'asc' })).rows.at(-1)?.id,
    ).toBe('bad')
  }
  const sources = (await page()).sources.map((s) => weight(s.key, 0))
  const none = await page({ settings: { sources, outlierDistance: 25 } })
  const disabled = await summary({ settings: { sources, outlierDistance: 25 } })
  expect(disabled.total).toBe(4)
  expect(disabled.coverage).toContainEqual({
    key: pluginKey,
    recorded: 3,
    eligible: 0,
  })
  expect(bins(disabled, 'score').every((bin) => bin.count === 0)).toBe(true)
  expect(
    none.rows.every(
      (r) =>
        r.score === null &&
        r.core === null &&
        r.counted === 0 &&
        r.missingWeight === 0,
    ),
  ).toBe(true)
  await expect(page({ sort: 'plugin.fixture.unknown' })).rejects.toThrow(
    'Unknown rating sort',
  )
  await expect(
    page({ settings: { sources: [weight('notRegistered', 1)] } }),
  ).rejects.toThrow('Unknown rating source')
  await expect(
    page({ settings: { sources: [weight('ratingRt', 1, 1)] } }),
  ).rejects.toThrow('no vote count')
})

const libraries: RatingsRankingRequest['library'][] = ['album', 'film']
it.each(libraries)(
  'excludes vote placeholders from the %s population while retaining vote evidence',
  async (library) => {
    const positive = library === 'film' ? 'ratingImdbValue' : 'ratingRymValue'
    const positiveVotes =
      library === 'film' ? 'ratingImdbVotes' : 'ratingRymVotes'
    const allowedZero =
      library === 'film' ? 'ratingRtAudience' : 'ratingMetacriticValue'
    const allowedZeroVotes =
      library === 'film' ? 'ratingRtAudienceVotes' : 'ratingMetacriticVotes'
    const cases = [
      { id: 'zero-votes', positive: 5, percent: 0, votes: 0 },
      { id: 'unknown-votes', positive: 3, percent: 12, votes: null },
      { id: 'fractional-votes', positive: 3, percent: 0, votes: 0.5 },
      { id: 'negative-votes', positive: 3, percent: 0, votes: -1 },
      { id: 'text-votes', positive: 3, percent: 0, votes: '3' },
      { id: 'rated-zero', positive: 4, percent: 0, votes: 3 },
      { id: 'rated-positive', positive: 0, percent: 24, votes: 8 },
    ]
    await database.insert(schema.mediaItem).values(
      cases.map((row) => ({
        id: row.id,
        slug: row.id,
        title: row.id,
        mediaType: library,
        metadata: {
          browse: {
            [positive]: row.positive,
            [allowedZero]: row.percent,
            [pluginKey]: row.percent,
            [positiveVotes]: row.votes,
            [allowedZeroVotes]: row.votes,
            [votesKey]: row.votes,
          },
        },
      })),
    )
    const { rows } = await page({ library, settings: { minSources: 1 } })
    function observation(id: string, key: string) {
      return rows
        .find((item) => item.id === id)
        ?.ratings.find((r) => r.key === key)
    }
    expect(observation('rated-zero', positive)).toMatchObject({
      raw: 4,
      adjusted: 50,
      status: 'counted',
    })
    expect(observation('rated-positive', positive)).toMatchObject({
      raw: null,
      adjusted: null,
      votes: 8,
      status: 'missing',
    })
    for (const key of [positive, allowedZero, pluginKey]) {
      expect(observation('zero-votes', key)).toMatchObject({
        raw: null,
        adjusted: null,
        votes: 0,
        status: 'missing',
      })
      for (const id of ['fractional-votes', 'negative-votes', 'text-votes'])
        expect(observation(id, key)).toMatchObject({
          raw: null,
          adjusted: null,
          votes: null,
          status: 'missing',
        })
    }
    expect(observation('unknown-votes', positive)).toMatchObject({
      raw: null,
      adjusted: null,
      votes: null,
      status: 'missing',
    })
    for (const key of [allowedZero, pluginKey]) {
      expect(observation('rated-zero', key)).toMatchObject({
        raw: 0,
        adjusted: 100 / 6,
        votes: 3,
        status: 'counted',
      })
      expect(observation('unknown-votes', key)).toMatchObject({
        raw: 12,
        adjusted: 50,
        votes: null,
        status: 'counted',
      })
      expect(observation('rated-positive', key)).toMatchObject({
        raw: 24,
        votes: 8,
        status: 'counted',
      })
    }
    const floor = await summary({
      library,
      settings: { minSources: 1, sources: [weight(pluginKey, 1, 4)] },
    })
    expect(floor.total).toBe(7)
    expect(
      floor.histograms.find((h) => h.dimension === 'native.' + pluginKey),
    ).toMatchObject({
      typicalVotes: 3,
      quartiles: [0, 12, 24],
      population: 7,
    })
    expect(floor.coverage).toContainEqual({
      key: pluginKey,
      recorded: 3,
      eligible: 1,
    })
    expect(bins(floor, 'native.' + pluginKey).map((bin) => bin.count)).toEqual([
      1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    ])
  },
)

it('standardizes by population deviation and clips scores beyond the display scale', async () => {
  for (let i = 0; i < 12; i++)
    await film('sample-' + i, {
      ratingRt: i === 0 ? 100 : 0,
      ratingMetascore: i === 0 ? 0 : 100,
    })
  const { rows } = await page({ settings: { normalization: 'standardized' } })
  const extreme = rows.find((row) => row.id === 'sample-0')
  expect(extreme?.ratings.find((r) => r.key === 'ratingRt')?.adjusted).toBe(100)
  expect(
    extreme?.ratings.find((r) => r.key === 'ratingMetascore')?.adjusted,
  ).toBe(0)
  const repeated = rows.find((row) => row.id === 'sample-1')
  expect(
    repeated?.ratings.find((r) => r.key === 'ratingRt')?.adjusted,
  ).toBeCloseTo(50 - 20 / Math.sqrt(11))
})

it('uses first albums, existing listening totals and accepted score fields for album rankings', async () => {
  await pool.query(`
    insert into media_item (id,slug,title,media_type,in_library,metadata) values
      ('first','first','First','album',true,'{"browse":{"ratingRymValue":4,"ratingRymVotes":11,"ratingMetacriticValue":90,"ratingMetacriticVotes":25,"scrobbles":8}}'),
      ('other','other','Other','album',true,'{"browse":{"ratingRymValue":2,"ratingRymVotes":7,"scrobbles":2}}'),
      ('edition','edition','Edition','album',true,'{"browse":{"ratingRymValue":5,"ratingRymVotes":6}}'),
      ('outside','outside','Outside','album',false,'{"browse":{"ratingRymValue":1,"ratingRymVotes":4}}'),
      ('hidden','hidden','Hidden','album',true,'{"legacyHidden":"true","browse":{"ratingRymValue":1,"ratingRymVotes":4}}');
    insert into album (media_item_id,edition_of_id) values ('first',null),('other',null),('edition','first');
    insert into artist (id,name) values ('artist','Fixture artist');
    insert into media_credit (media_item_id,artist_id,role) values ('first','artist','artist');
    insert into media_override (id,media_item_id,field,value) values ('rejection','first','albumMatchRejection',
      '{"provider":"google-custom-search","referenceType":"metacritic-url"}');
  `)
  expect((await page({ library: 'album' })).total).toBe(2)
  const filtered = await page({
    library: 'album',
    minPlays: 3,
    search: 'artist',
  })
  expect(filtered.rows).toHaveLength(1)
  expect(filtered.rows[0]?.id).toBe('first')
  expect(filtered.rows[0]?.ratings).toContainEqual(
    expect.objectContaining({ key: 'ratingRymValue', adjusted: 75 }),
  )
  expect(filtered.rows[0]?.ratings).toContainEqual(
    expect.objectContaining({
      key: 'ratingMetacriticValue',
      raw: null,
      votes: null,
    }),
  )
  expect(filtered.sources.some((source) => source.group === 'personal')).toBe(
    false,
  )
  const albums = await summary({
    library: 'album',
    minPlays: 3,
    search: 'artist',
  })
  expect(albums.total).toBe(1)
  expect(albums.coverage).toContainEqual({
    key: 'ratingRymValue',
    recorded: 1,
    eligible: 0,
  })
  expect(albums.coverage).toContainEqual({
    key: 'ratingMetacriticValue',
    recorded: 0,
    eligible: 0,
  })
  expect((await summary({ library: 'album' })).total).toBe(2)
})

it.each(libraries)(
  'uses the same %s range edges for histograms and Ranking drill-down',
  async (library) => {
    const critic = library === 'film' ? 'ratingRt' : 'ratingMetacriticValue'
    const native = 'native.' + pluginKey
    const input = {
      library,
      search: 'included',
      settings: { normalization: 'scale', missingWeight: 0 },
    }
    const values: [number, number][] = [
      [0, 0],
      [20, 20],
      [40, 40],
      [60, 60],
      [80, 80],
      [100, 0],
      [100, 100],
    ]
    await database.insert(schema.mediaItem).values(
      values.map(([plugin, builtin], i) => ({
        id: 'edge-' + i,
        slug: 'edge-' + i,
        title: 'Included ' + i,
        mediaType: library,
        metadata: {
          browse: {
            [critic]: builtin,
            ratingMetacriticVotes: 10,
            [pluginKey]: plugin,
            [votesKey]: 10,
          },
        },
      })),
    )
    await database.insert(schema.mediaItem).values([
      {
        id: 'missing',
        slug: 'missing',
        title: 'Included missing',
        mediaType: library,
      },
      {
        id: 'excluded',
        slug: 'excluded',
        title: 'Other title',
        mediaType: library,
        metadata: { browse: { [pluginKey]: 35, [votesKey]: 10 } },
      },
    ])
    const full = await summary(input)
    expect(full.total).toBe(8)
    expect(full.coverage).toContainEqual({
      key: pluginKey,
      recorded: 7,
      eligible: 7,
    })
    expect(bins(full, native)).toEqual(
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 2].map((count, i) => ({
        lower: i * 10,
        upper: (i + 1) * 10,
        upperInclusive: i === 9,
        count,
      })),
    )
    expect(bins(full, 'spread').map((bin) => bin.count)).toEqual([
      6, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ])
    expect(bins(full, 'score').map((bin) => bin.count)).toEqual([
      1, 0, 1, 0, 1, 1, 1, 0, 1, 1,
    ])
    const weighted = full.sources.filter((s) => s.group !== 'personal').length
    const countBins = bins(full, 'counted')
    expect(countBins).toHaveLength(weighted + 1)
    expect(countBins).toEqual(
      countBins.map((_, i) => ({
        lower: i,
        upper: i,
        upperInclusive: true,
        count: Number(i === 0) + (i === 2 ? 7 : 0),
      })),
    )
    for (const dimension of [native, 'score', 'spread', 'counted']) {
      for (const [index, bin] of bins(full, dimension).entries()) {
        const drilled = await page({
          ...input,
          ranges: [{ dimension, first: index, last: index }],
        })
        expect(drilled.total).toBe(bin.count)
      }
    }
    const intersect = {
      ...input,
      ranges: [
        { dimension: native, first: 2, last: 7 },
        { dimension: 'score', first: 4, last: 7 },
      ],
    }
    const selected = await summary(intersect)
    expect(selected.total).toBe(2)
    expect(selected.coverage).toContainEqual({
      key: pluginKey,
      recorded: 2,
      eligible: 2,
    })
    expect(bins(selected, native).map((bin) => bin.count)).toEqual([
      0, 0, 0, 0, 1, 0, 1, 0, 0, 1,
    ])
    expect(bins(selected, 'score').map((bin) => bin.count)).toEqual([
      0, 0, 1, 0, 1, 0, 1, 0, 0, 0,
    ])
    expect(bins(selected, 'spread').map((bin) => bin.count)).toEqual([
      2, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    expect((await page(intersect)).rows.map((row) => row.id)).toEqual([
      'edge-3',
      'edge-2',
    ])
    const miss = await summary({ ...intersect, search: 'absent title' })
    expect(miss.total).toBe(0)
    expect(
      miss.histograms
        .flatMap((hist) => hist.bins)
        .every((bin) => bin.count === 0),
    ).toBe(true)
    expect(await database.$count(schema.scrapeJob)).toBe(0)
    expect(plugin.scrapeMediaItem).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  },
)

it('validates histogram dimensions and bin bounds for both read operations', async () => {
  for (const read of [page, summary]) {
    for (const range of [
      { dimension: 'native.plugin.fixture.unknown', first: 0, last: 1 },
      { dimension: 'native.ratingImdbValue', first: 0, last: 1 },
      { dimension: 'counted', first: 65, last: 65 },
      { dimension: 'score', first: -1, last: 0 },
      { dimension: 'spread', first: 0, last: 10 },
      { dimension: 'score', first: 2, last: 1 },
    ]) {
      await expect(async () =>
        read({ library: 'album', ranges: [range] }),
      ).rejects.toThrow()
    }
  }
})

it('reports the exact decimal boundary used for a plugin native rating', async () => {
  // This plugin key is a built-in duplicate for films but is registered for albums.
  await database.insert(schema.mediaItem).values(
    [0, 0.29999, 0.3, 3].map((value, i) => ({
      id: 'decimal-' + i,
      slug: 'decimal-' + i,
      title: 'Decimal ' + i,
      mediaType: 'album',
      metadata: { browse: { ratingRt: value } },
    })),
  )
  const dimension = 'native.ratingRt'
  const histogram = bins(await summary({ library: 'album' }), dimension)
  expect(histogram[0]).toEqual({
    lower: 0,
    upper: 0.3,
    upperInclusive: false,
    count: 2,
  })
  expect(histogram[1]?.lower).toBe(0.3)
  expect(
    (
      await page({
        library: 'album',
        ranges: [{ dimension, first: 1, last: 1 }],
      })
    ).rows.map((row) => row.id),
  ).toEqual(['decimal-2'])
})
