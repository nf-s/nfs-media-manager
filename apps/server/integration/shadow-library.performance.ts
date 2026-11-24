import { expect, it, vi } from 'vitest'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { pool, database, checkBudget } = createTrackPerformanceFixture()

vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

it('bounds Track pages, counts and history when most recordings are outside the library', async () => {
  const { queryBrowseCounts } = await import('@/services/browse')
  const { listCatalogObservations } =
    await import('@/services/catalog-discoveries')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  const { similarTrackDetails } =
    await import('@/services/similar-library-matches')
  const page = TrackQuerySchema.parse({
    sortBy: 'title',
    direction: 'asc',
    size: 25,
  })
  const deepPage = { ...page, page: 480 }
  const baseline = await checkBudget(
    'member Track page before discoveries',
    1_500,
    2,
    () => listTrackBrowsePage(page),
  )
  expect(baseline.items).toHaveLength(25)
  expect(baseline.hasMore).toBe(true)
  const deepBaseline = await checkBudget(
    'deep member Track page before discoveries',
    4_000,
    2,
    () => listTrackBrowsePage(deepPage),
  )
  expect(deepBaseline.items).toHaveLength(25)
  expect(deepBaseline.hasMore).toBe(true)
  await checkBudget(
    'member Track count before discoveries',
    1_200,
    3,
    async () => {
      expect(await queryBrowseCounts('track', page)).toEqual({
        totalCount: 20_000,
        unfilteredCount: 20_000,
      })
    },
  )

  // Outside titles sort ahead of the entire library on an ascending Title page.
  await pool.query(`
    insert into media_item (id, slug, media_type, title, in_library)
    select 'origin-track-' || n, 'origin-track-' || n, 'track',
      'A fixture discovery ' || lpad(n::text, 5, '0'), false
    from generate_series(1, 40000) n;
    insert into library_track (media_item_id)
    select 'origin-track-' || n from generate_series(1, 40000) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'origin-track-' || n, 'artist-' || ((n - 1) % 1000 + 1), 'artist'
    from generate_series(1, 40000) n;
    insert into catalog_observation (id, media_item_id, target_kind, target_id, provider, operation)
    select 'observation-' || n || '-' || source.operation, 'origin-track-' || n,
      'track', 'origin-track-' || n, 'spotify', source.operation
    from generate_series(1, 40000) n
    cross join lateral (
      select 'spotify-match' as operation where n % 2 = 0
      union all select 'spotify-playlist' where n % 3 = 0
      union all select 'playback' where n % 2 <> 0 and n % 3 <> 0
    ) source;
    insert into catalog_observation (id, media_item_id, target_kind, target_id, provider, operation)
    values
      ('member-origin-1', 'track-1', 'track', 'track-1', 'spotify', 'spotify-match'),
      ('member-origin-2', 'track-1', 'track', 'track-1', 'spotify', 'spotify-playlist'),
      ('member-origin-3', 'track-2', 'track', 'track-2', 'spotify', 'spotify-match'),
      ('member-origin-4', 'track-3', 'track', 'track-3', 'spotify', 'spotify-playlist'),
      ('member-origin-5', 'track-2', 'track', 'track-2', 'spotify', 'spotify-match'),
      ('native-origin-1', null, 'artist', 'track-4', 'spotify', 'spotify-match'),
      ('native-origin-2', null, 'artist', 'track-4', 'spotify', 'spotify-playlist');
    insert into catalog_observation (id, media_item_id, target_kind, target_id,
      provider, operation, position, observed_at)
    select 'repeat-observation-' || n, 'origin-track-1', 'track', 'origin-track-1',
      'spotify', 'playback', n, now() + n * interval '1 second'
    from generate_series(1, 9000) n;
    insert into catalog_media_alias (alias_id, media_item_id)
    values ('origin-track-alias', 'origin-track-1');
  `)
  for (const table of [
    'media_item',
    'library_track',
    'media_credit',
    'catalog_observation',
  ]) {
    await pool.query(`vacuum analyze ${table}`)
  }

  await checkBudget(
    'member Track page after discoveries',
    1_500,
    2,
    async () => {
      expect(await listTrackBrowsePage(page)).toEqual(baseline)
    },
  )
  await checkBudget(
    'deep member Track page after discoveries',
    4_000,
    2,
    async () => {
      expect(await listTrackBrowsePage(deepPage)).toEqual(deepBaseline)
    },
  )
  await checkBudget(
    'member Track count after discoveries',
    2_000,
    3,
    async () => {
      expect(await queryBrowseCounts('track', page)).toEqual({
        totalCount: 20_000,
        unfilteredCount: 20_000,
      })
    },
  )
  const sources = 'spotify-match,spotify-playlist'
  const outsideIds = (step: number) =>
    Array.from(
      { length: 25 },
      (_, index) => `origin-track-${(index + 1) * step}`,
    )
  const outsideAllOrigins = {
    libraryScope: 'outside',
    discoverySources: sources,
    discoverySourceMode: 'all',
  }
  for (const { label, scope, totalCount, ids, pageBlocks, countBlocks } of [
    {
      label: 'all',
      scope: { libraryScope: 'all' },
      totalCount: 60_000,
      ids: outsideIds(1),
      pageBlocks: 1_750,
      countBlocks: 3_000,
    },
    {
      label: 'outside',
      scope: { libraryScope: 'outside' },
      totalCount: 40_000,
      ids: outsideIds(1),
      pageBlocks: 1_750,
      countBlocks: 3_000,
    },
    {
      label: 'member any origin',
      scope: {
        discoverySourceScope: 'selection',
        discoverySources: sources,
        discoverySourceMode: 'any',
      },
      totalCount: 3,
      ids: ['track-1', 'track-2', 'track-3'],
      pageBlocks: 95_000,
      countBlocks: 5_000,
    },
    {
      label: 'member all origins',
      scope: {
        discoverySourceScope: 'selection',
        discoverySources: sources,
        discoverySourceMode: 'all',
      },
      totalCount: 1,
      ids: ['track-1'],
      pageBlocks: 95_000,
      countBlocks: 5_000,
    },
    {
      label: 'member excluded origins',
      scope: {
        discoverySourceScope: 'selection',
        discoverySources: sources,
        discoverySourceMode: 'exclude',
      },
      totalCount: 19_997,
      ids: undefined,
      pageBlocks: 2_000,
      countBlocks: 5_000,
    },
    {
      label: 'all additive origins',
      scope: {
        libraryScope: 'all',
        discoverySources: sources,
        discoverySourceMode: 'all',
      },
      totalCount: 26_666,
      ids: outsideIds(6),
      pageBlocks: 5_000,
      countBlocks: 8_000,
    },
    {
      label: 'outside all origins',
      scope: outsideAllOrigins,
      totalCount: 6_666,
      ids: outsideIds(6),
      pageBlocks: 3_000,
      countBlocks: 40_000,
    },
  ]) {
    const query = TrackQuerySchema.parse({ ...page, ...scope })
    await checkBudget(
      `shadow-heavy Track page, ${label}`,
      pageBlocks,
      2,
      async () => {
        const result = await listTrackBrowsePage(query)
        if (ids) expect(result.items.map((item) => item.id)).toEqual(ids)
        else {
          expect(result.items).toHaveLength(page.size)
          expect(
            result.items.every(
              (item) => !['track-1', 'track-2', 'track-3'].includes(item.id),
            ),
          ).toBe(true)
        }
        expect(result.hasMore).toBe(totalCount > page.size)
      },
    )
    await checkBudget(
      `shadow-heavy Track count, ${label}`,
      countBlocks,
      3,
      async () => {
        expect(await queryBrowseCounts('track', query)).toEqual({
          totalCount,
          unfilteredCount: totalCount,
        })
      },
    )
  }
  await checkBudget('warm shadow-heavy Track count', 20, 1, async () => {
    expect(
      await queryBrowseCounts(
        'track',
        TrackQuerySchema.parse({ ...page, ...outsideAllOrigins }),
      ),
    ).toEqual({
      totalCount: 6_666,
      unfilteredCount: 6_666,
    })
  })
  await checkBudget(
    'shadow-heavy source history through an alias',
    1_200,
    3,
    async () => {
      const history = await listCatalogObservations('origin-track-alias', {
        page: 1,
        size: 25,
      })
      expect(history.totalCount).toBe(9_001)
      expect(history.items.map(({ position }) => position)).toEqual(
        Array.from({ length: 25 }, (_, index) => 9_000 - index),
      )
    },
  )

  await pool.query(
    "update media_item set in_library = true where id = 'origin-track-1'",
  )
  await checkBudget(
    'member Track count after a membership change',
    2_000,
    3,
    async () => {
      expect(await queryBrowseCounts('track', page)).toEqual({
        totalCount: 20_001,
        unfilteredCount: 20_001,
      })
    },
  )
  const changedPage = await listTrackBrowsePage(page)
  expect(changedPage.items[0]).toMatchObject({
    id: 'origin-track-1',
    inLibrary: true,
  })

  await pool.query(`
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    select 'fixture-account', 'fixture ensemble', 'recording-' || n, 'track-' || n
    from generate_series(1, 20000) n;
    insert into lastfm_scrobble (id, username, artist_key, track_key, artist_name, track_name, listened_at)
    select 'fixture-play-' || n || '-' || play, 'fixture-account', 'fixture ensemble',
      'recording-' || n, 'Fixture Ensemble', 'Recording ' || n, now() - play * interval '1 hour'
    from generate_series(1, 20000) n cross join generate_series(1, 8) play;
  `)
  for (const table of ['lastfm_track_source', 'lastfm_scrobble'])
    await pool.query(`vacuum analyze ${table}`)

  const memberIds = Array.from({ length: 10 }, (_, i) => `track-${i + 1}`)
  const outsideTrackIds = outsideIds(1).slice(1, 10)
  const headers = await checkBudget('Similar track headers', 900, 1, () =>
    similarTrackDetails(database, [
      'origin-track-alias',
      ...memberIds,
      ...outsideTrackIds,
    ]),
  )
  expect(headers.size).toBe(20)
  expect(headers.get('origin-track-alias')).toMatchObject({
    id: 'origin-track-1',
  })
  expect(headers.get('track-1')?.lastfmSource).toEqual({
    artistName: 'Fixture Ensemble',
    trackName: 'Recording 1',
  })
  expect(headers.get('origin-track-2')?.lastfmSource).toBeNull()
})
