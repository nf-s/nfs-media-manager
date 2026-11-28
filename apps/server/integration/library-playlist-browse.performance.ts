import { beforeAll, expect, it, vi } from 'vitest'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { SubscriptionItemQuerySchema } from '@repo/schemas/subscriptions'
import {
  PlaylistBrowseQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

// PL-17 and PL-18 on the shared fixture of 20,000 synthetic tracks and 1,000
// albums, with 5,000 films, 20,000 videos in 20 channels and 400 imported
// playlists added below. Each library has 30 playlists of 300 to 330
// entries, a few removed, and a smart playlist, named among the imported
// playlists so that a directory page holds both. Every name is invented.
const { pool, database, checkBudget, logQuery } =
  createTrackPerformanceFixture()

vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

const libraries = [
  ['tracks', 'track-', 20_000],
  ['albums', 'album-', 1_000],
  ['films', 'film-', 5_000],
  ['subscriptions', 'video-', 20_000],
] as const

beforeAll(async () => {
  await pool.query(`
    insert into media_item (id, slug, media_type, title, release_date)
    select 'film-' || n, 'film-' || n, 'film', 'Synthetic film ' || n,
      timestamp '1950-01-01' + n * interval '5 days'
    from generate_series(1, 5000) n;
    insert into film (media_item_id) select id from media_item where media_type = 'film';
    insert into subscription_source (id, type, title)
    select 'UCsynthetic' || lpad(n::text, 13, '0'), 'youtube', 'Synthetic channel ' || n
    from generate_series(1, 20) n;
    insert into subscription_item (id, source_id, type, title, artists, published_at, duration_sec, search)
    select 'video-' || n, 'UCsynthetic' || lpad((1 + n % 20)::text, 13, '0'), 'youtube',
      'Synthetic video ' || n, '[]', timestamp '2020-01-01' + n * interval '1 hour', 600,
      to_tsvector('simple', 'Synthetic video ' || n)
    from generate_series(1, 20000) n;
    insert into playlist (id, name, kind, source, spotify_id, owner_name, imported_at, created_at, added_to_library)
    select 'imported-' || n, 'Mix ' || lpad(n::text, 3, '0'), 'playlist',
      case when n % 2 = 0 then 'spotify' end, case when n % 2 = 0 then 'sp' || n end,
      'Synthetic owner', timestamp '2025-01-01' + n * interval '1 day',
      timestamp '2024-01-01' + n * interval '1 day', true
    from generate_series(1, 400) n;
    insert into playlist_item (playlist_id, media_item_id, position)
    select 'imported-' || p, 'track-' || (1 + (p * 37 + i * 53) % 20000), i
    from generate_series(1, 400) p cross join generate_series(1, 25) i
    on conflict do nothing;
  `)
  // Fixed names and sizes from this file, written into the statement.
  for (const [library, prefix, size] of libraries)
    await pool.query(`
      insert into library_playlist (id, library, type, name, updated_at)
      select '${library}-playlist-' || p, '${library}', 'playlist',
        'Mix ' || lpad((p * 3)::text, 3, '0') || ' ${library}',
        timestamp '2026-01-01' + p * interval '1 hour'
      from generate_series(1, 30) p;
      insert into library_playlist (id, library, type, name, view)
      values ('${library}-smart', '${library}', 'smart', 'Synthetic smart ${library}', '{"q":"synthetic"}');
      insert into library_playlist_entry (id, playlist_id, position, ${
        library === 'subscriptions' ? 'subscription_item_id' : 'media_item_id'
      }, batch_id)
      select '${library}-entry-' || p || '-' || i, '${library}-playlist-' || p, i,
        '${prefix}' || (1 + (p * 7919 + i * ${Math.floor(size / 300)}) % ${size}), 'fixture'
      from generate_series(1, 30) p cross join generate_series(1, 300 + p) i;
      update library_playlist_entry set removed_batch_id = 'removed', removed_at = now()
      where playlist_id like '${library}-playlist-%' and position % 50 = 0;
    `)
  for (const table of [
    'media_item',
    'film',
    'subscription_source',
    'subscription_item',
    'playlist',
    'playlist_item',
    'library_playlist',
    'library_playlist_entry',
  ])
    await pool.query(`vacuum analyze ${table}`)
}, 120_000)

const filters = (library: string, mode: 'any' | 'exclude') =>
  JSON.stringify([
    { field: 'libraryPlaylist', value: `${library}-playlist-15`, mode },
  ])

it('bounds Browse pages filtered by a library playlist', async () => {
  const { queryBrowseCount, queryBrowsePageIds } =
    await import('@/services/browse')
  const { countSubscriptionBrowseItems, listSubscriptionBrowsePage } =
    await import('@/services/subscription-library')
  // Shared blocks, 1.5 times those measured when these workloads were
  // added, and statements. A page is one statement, as without the filter.
  const budgets: Record<string, [number, number]> = {
    'Tracks Title any page': [4_800, 1],
    'Tracks Title exclude page': [1_700, 1],
    'Tracks Added any page': [2_700, 1],
    'Tracks Added exclude page': [2_500, 1],
    'Tracks any count': [1_100, 3],
    'Albums any page': [600, 1],
    'Albums exclude page': [1_100, 1],
    'Films any page': [100, 1],
    'Films exclude page': [100, 1],
    'Subscriptions any page': [700, 1],
    'Subscriptions exclude page': [400, 1],
    'Subscriptions any count': [800, 3],
  }
  const check = (label: string, read: () => Promise<unknown>) => {
    const [blocks, statements] = budgets[label] ?? [0, 0]
    return checkBudget(label, blocks, statements, read, 1_000)
  }
  for (const mode of ['any', 'exclude'] as const) {
    for (const [sort, sortBy, direction] of [
      ['Title', 'title', 'asc'],
      ['Added', 'dateAdded', 'desc'],
    ] as const)
      await check(`Tracks ${sort} ${mode} page`, async () => {
        const page = await queryBrowsePageIds(
          'track',
          TrackQuerySchema.parse({
            size: 100,
            sortBy,
            direction,
            filters: filters('tracks', mode),
          }),
        )
        expect(page.ids).toHaveLength(100)
        expect(page.hasMore).toBe(true)
      })
    await check(`Albums ${mode} page`, async () => {
      const page = await queryBrowsePageIds(
        'album',
        AlbumQuerySchema.parse({ size: 100, filters: filters('albums', mode) }),
      )
      expect(page.ids).toHaveLength(100)
    })
    await check(`Films ${mode} page`, async () => {
      const page = await queryBrowsePageIds(
        'film',
        FilmQuerySchema.parse({ size: 100, filters: filters('films', mode) }),
      )
      expect(page.ids).toHaveLength(100)
    })
    await check(`Subscriptions ${mode} page`, async () => {
      const page = await listSubscriptionBrowsePage(
        SubscriptionItemQuerySchema.parse({
          size: 100,
          filters: filters('subscriptions', mode),
        }),
      )
      expect(page.items).toHaveLength(100)
    })
  }
  // 315 entries, 6 of them removed.
  await check('Tracks any count', async () => {
    expect(
      await queryBrowseCount(
        'track',
        TrackQuerySchema.parse({ filters: filters('tracks', 'any') }),
      ),
    ).toEqual({ totalCount: 309 })
  })
  await check('Subscriptions any count', async () => {
    expect(
      await countSubscriptionBrowseItems(
        SubscriptionItemQuerySchema.parse({
          filters: filters('subscriptions', 'any'),
        }),
      ),
    ).toEqual({ totalCount: 309 })
  })
})

it('bounds Playlists directory pages and counts of a library', async () => {
  const { countPlaylists, listPlaylistBrowsePage } =
    await import('@/services/playlist-directory')
  // The legacy saved-view insert runs once per process, before this.
  await listPlaylistBrowsePage(
    PlaylistBrowseQuerySchema.parse({ library: 'albums' }),
  )
  // Each after the imported-only page of the nearest sort, which hydrates
  // the imported rows the same way. Budgets are 1.5 times the shared blocks
  // measured when these workloads were added; a page of library rows only is
  // one statement, and the counts here do not evaluate smart views.
  const importedBudgets: Record<string, number> = {
    name: 64_300,
    tracks: 110_500,
    imported: 64_300,
  }
  for (const [library, sortBy, direction, importedSort, rows, budget] of [
    ['tracks', 'name', 'asc', 'name', 431, 48_500],
    ['tracks', 'count', 'desc', 'tracks', 431, 92_000],
    ['tracks', 'updated', 'desc', 'imported', 431, 44_700],
    ['albums', 'type', 'asc', 'name', 431, 48_500],
    ['films', 'name', 'asc', undefined, 31, 400],
  ] as const) {
    const workload = `${library} ${sortBy} ${direction}`
    if (importedSort)
      await checkBudget(
        `Playlists imported ${importedSort} ${direction} page`,
        importedBudgets[importedSort] ?? 0,
        3,
        async () => {
          const page = await listPlaylistBrowsePage(
            PlaylistBrowseQuerySchema.parse({
              sortBy: importedSort,
              direction,
            }),
          )
          expect(page.items).toHaveLength(100)
        },
      )
    const query = PlaylistBrowseQuerySchema.parse({
      library,
      sortBy,
      direction,
    })
    await checkBudget(
      `Playlists ${workload} page`,
      budget,
      importedSort ? 3 : 1,
      async () => {
        const page = await listPlaylistBrowsePage(query)
        expect(page.items).toHaveLength(Math.min(rows, 100))
        expect(page.items.some((item) => item.origin === 'library')).toBe(true)
      },
    )
    await checkBudget(`Playlists ${workload} count`, 20, 1, async () => {
      expect(await countPlaylists(query)).toEqual({ totalCount: rows })
    })
  }
})

it('bounds reads of a directory filtered by smart counts', async () => {
  const { countPlaylists, listPlaylistBrowsePage } =
    await import('@/services/playlist-directory')
  await pool.query(`
    insert into library_playlist (id, library, type, name, view)
    select 'measured-smart-' || n, 'films', 'smart',
      'Measured count ' || lpad(n::text, 2, '0'),
      jsonb_build_object('q', 'Synthetic film ' || n, 'limitResults', '1')
    from generate_series(1, 30) n
  `)
  const query = PlaylistBrowseQuerySchema.parse({
    library: 'films',
    types: ['smart'],
    name: 'Measured count',
    columnRanges: { count: { min: 1, max: 1 } },
    size: 6,
  })
  const snapshot = async () =>
    (
      await pool.query<{ version: string }>(
        'select pg_current_snapshot()::text as version',
      )
    ).rows[0]?.version
  const before = await snapshot()
  // Each distinct view uses its Browse full-text count and cache version
  // checks on the first request. Paging the same views reuses their totals.
  await checkBudget(
    'Cold count of 30 distinct smart views',
    2_900_000,
    94,
    async () => {
      expect(await countPlaylists(query)).toEqual({ totalCount: 30 })
    },
  )
  const secondPageStatements = await checkBudget(
    'Second page of a directory filtered by smart count',
    // A commit on the same PostgreSQL server can invalidate the cache.
    2_900_000,
    94,
    async () => {
      const page = await listPlaylistBrowsePage({ ...query, page: 2 })
      expect(page.hasMore).toBe(true)
      expect(
        page.items.map(({ name, itemCount }) => [name, itemCount]),
      ).toEqual(
        ['07', '08', '09', '10', '11', '12'].map((n) => [
          `Measured count ${n}`,
          1,
        ]),
      )
      return logQuery.mock.calls.length
    },
  )
  if (before === (await snapshot()))
    expect(
      secondPageStatements,
      'Statements with an unchanged snapshot',
    ).toBeLessThanOrEqual(3)
})
