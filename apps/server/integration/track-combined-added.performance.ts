import { expect, it, vi } from 'vitest'
import { z } from 'zod'
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

it('bounds ungrouped Added pages with combined Track tag and playlist filters', async () => {
  const { queryBrowseCount } = await import('@/services/browse')
  const { listTrackBrowsePage } = await import('@/services/tracks')
  // Broad, overlapping memberships on the same 20,000 tracks. A narrow
  // own-tag match forces a walk through the date index even for page one.
  await pool.query(`
    insert into tag (id, media_type, name, kind) values
      ('combined-album', 'album', 'Combined album tag', 'genre'),
      ('combined-genre', 'album', 'Combined genre', 'genre'),
      ('combined-track', 'album', 'Combined track tag', 'genre'),
      ('combined-narrow', 'album', 'Combined narrow tag', 'genre');
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'combined-album' from generate_series(1, 700) n
    union all
    select 'album-' || n, 'combined-genre' from generate_series(2, 1000, 2) n;
    insert into track_tag (media_item_id, tag_id, sonovault, verified)
    select 'track-' || n, 'combined-track', true, true from generate_series(3, 20000, 3) n
    union all
    select 'track-' || n, 'combined-narrow', true, true from generate_series(311, 20000, 311) n;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'combined-profile-' || n, 'artist-' || n, 'combined-fixture', '{}',
      '{"tags":["Combined artist tag"]}' from generate_series(1, 850) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select 'artist-' || n, 'combined-fixture', 'combined-profile-' || n
    from generate_series(1, 850) n;
    insert into playlist (id, kind, name) values
      ('combined-list', 'playlist', 'Combined playlist');
    insert into playlist_item (playlist_id, media_item_id)
    select 'combined-list', 'track-' || n from generate_series(1, 20000) n where n % 7 < 5;
    update library_track set date_added = timestamp '2024-01-01' +
      (substring(media_item_id from 7)::int / 200) * interval '1 day';
    analyze;
  `)
  const albumTag = {
    field: 'albumTag',
    value: 'Combined album tag',
    mode: 'required',
  }
  const artistTag = {
    field: 'artistTag',
    value: 'Combined artist tag',
    mode: 'required',
  }
  const genre = { field: 'genre', value: 'Combined genre', mode: 'required' }
  const playlist = {
    field: 'playlist',
    value: 'Combined playlist',
    mode: 'required',
  }
  const trackTag = {
    field: 'trackTag',
    value: 'Combined track tag',
    mode: 'required',
  }
  const narrowTag = { ...trackTag, value: 'Combined narrow tag' }
  const idRows = z.array(z.object({ id: z.string() }))
  const cases = [
    {
      label: 'five required',
      pageBudget: 16_000,
      countBudget: 32_000,
      filters: [albumTag, artistTag, genre, playlist, trackTag],
      predicate:
        'album_n <= 700 and artist_n <= 850 and album_n % 2 = 0 and n % 7 < 5 and n % 3 = 0',
    },
    {
      label: 'five selective',
      pageBudget: 26_000,
      countBudget: 8_000,
      filters: [albumTag, artistTag, genre, playlist, narrowTag],
      predicate:
        'album_n <= 700 and artist_n <= 850 and album_n % 2 = 0 and n % 7 < 5 and n % 311 = 0',
    },
    {
      label: 'five mixed',
      pageBudget: 15_000,
      countBudget: 8_000,
      filters: [
        albumTag,
        { ...artistTag, mode: 'any' },
        genre,
        { ...playlist, mode: 'any' },
        { ...trackTag, mode: 'exclude' },
      ],
      predicate:
        'album_n <= 700 and album_n % 2 = 0 and (artist_n <= 850 or n % 7 < 5) and n % 3 <> 0',
    },
    {
      label: 'four selective',
      pageBudget: 25_000,
      countBudget: 7_000,
      filters: [artistTag, genre, playlist, narrowTag],
      predicate:
        'artist_n <= 850 and album_n % 2 = 0 and n % 7 < 5 and n % 311 = 0',
    },
    {
      label: 'five mixed ascending',
      pageBudget: 9_000,
      countBudget: 8_000,
      direction: 'asc',
      filters: [
        albumTag,
        { ...artistTag, mode: 'exclude' },
        genre,
        playlist,
        trackTag,
      ],
      predicate:
        'album_n <= 700 and artist_n > 850 and album_n % 2 = 0 and n % 7 < 5 and n % 3 = 0',
    },
    {
      label: 'five with a miss',
      pageBudget: 25_000,
      countBudget: 8_000,
      filters: [
        albumTag,
        artistTag,
        genre,
        playlist,
        { ...trackTag, value: 'Combined missing tag' },
      ],
      predicate: 'false',
    },
  ]
  for (const {
    label,
    direction,
    filters,
    predicate,
    pageBudget,
    countBudget,
  } of cases) {
    const query = TrackQuerySchema.parse({ filters, direction, size: 100 })
    // Compute membership from the fixture's sequences and order from its
    // known release keys, independently of the Browse query.
    const expectedRows = await pool.query(`
        with matches as (
          select n, 1 + (n + n / 1000) % 1000 as album_n, 1 + (n - 1) % 1000 as artist_n
          from generate_series(1, 20000) n
        )
        select m.id from matches
        join media_item m on m.id = 'track-' || n
        join media_item a on a.id = 'album-' || album_n
        where ${predicate}
        order by n / 200 ${query.direction === 'asc' ? 'asc' : 'desc'},
          extract(year from a.release_date), lower(a.title), a.id, lower(m.title), m.id
      `)
    const expected = idRows.parse(expectedRows.rows).map(({ id }) => id)
    const page = await checkBudget(
      `Combined Added ${label} page`,
      pageBudget,
      2,
      () => listTrackBrowsePage(query),
    )
    expect(page.items.map(({ id }) => id)).toEqual(
      expected.slice(0, query.size),
    )
    expect(page.hasMore).toBe(expected.length > query.size)
    await checkBudget(
      `Combined Added ${label} count`,
      countBudget,
      3,
      async () =>
        expect(await queryBrowseCount('track', query)).toEqual({
          totalCount: expected.length,
        }),
    )
  }
})
