import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { pool, database, checkBudget } = createTrackPerformanceFixture()
const PlanWork = z.object({
  'Relation Name': z.string().optional(),
  'Actual Rows': z.number(),
  'Actual Loops': z.number(),
  'Rows Removed by Filter': z.number().default(0),
  Plans: z.array(z.unknown()).default([]),
})

function scrobbleRows(plan: unknown): number {
  const node = PlanWork.parse(plan)
  const rows =
    node['Relation Name'] === 'lastfm_scrobble'
      ? (node['Actual Rows'] + node['Rows Removed by Filter']) *
        node['Actual Loops']
      : 0
  return node.Plans.reduce<number>(
    (total, child) => total + scrobbleRows(child),
    rows,
  )
}

vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

it('bounds grouped lifetime pages and independent numeric counts with Playlist and mixed tags', async () => {
  const { listTrackBrowsePage } = await import('@/services/tracks')
  const { queryBrowseCounts, refreshRecordingBrowseOrderForMaintenance } =
    await import('@/services/browse')

  await pool.query(`
    insert into tag (id, media_type, name, kind) values
      ('mixed-release', 'album', 'Fixture mixed release', 'genre'),
      ('mixed-genre', 'album', 'Fixture mixed genre', 'genre');
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'mixed-release' from generate_series(1, 150) n
    union all select 'album-' || n, 'mixed-release' from generate_series(351, 400) n
    union all select 'album-' || n, 'mixed-genre' from generate_series(1, 350) n;
    insert into playlist (id, kind, name) values
      ('mixed-broad', 'playlist', 'Fixture broad playlist'),
      ('mixed-selective', 'playlist', 'Fixture selective playlist');
    insert into playlist_item (playlist_id, media_item_id)
    select 'mixed-broad', 'track-' || n from generate_series(1, 20000) n where n % 3 <> 0
    union all select 'mixed-selective', 'track-' || n from generate_series(1, 3250) n;
    update library_track set scrobble_count = (substring(media_item_id from 7)::int % 4);
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'mixed-fixture', 'fixture artist', 'linked-' || n, 'track-' || n, 'name'
    from generate_series(1, 20000) n where n % 4 <> 0;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'mixed-linked-' || n || '-' || event, 'mixed-fixture',
      timestamp '2021-01-01' + event * interval '1 day',
      'Fixture artist', 'Linked track', 'fixture artist', 'linked-' || n
    from generate_series(1, 20000) n cross join generate_series(1, 6) event
    where n % 4 <> 0;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'mixed-unlinked-' || n || '-' || event, 'mixed-fixture',
      timestamp '2020-01-01' + event * interval '1 day',
      'Unlinked artist', 'Unlinked track', 'unlinked artist', 'unlinked-' || n
    from generate_series(1, 2400) n cross join generate_series(1, 150) event;
    insert into recording_browse_order_state (singleton, builder, maintenance_only, retry_after)
    values (true, current_user, true, statement_timestamp() - interval '1 second')
    on conflict (singleton) do update set maintenance_only = true, retry_after = excluded.retry_after;
  `)
  for (const table of [
    'media_item_tag',
    'playlist_item',
    'library_track',
    'lastfm_track_link',
    'lastfm_scrobble',
  ])
    await pool.query(`vacuum analyze ${table}`)

  const listening = {
    match: 'all',
    rules: [{ period: { kind: 'all' }, min: 3, max: 12 }],
  }
  const tags = [
    { field: 'albumTag', value: 'Fixture mixed release', mode: 'required' },
    { field: 'genre', value: 'Fixture mixed genre', mode: 'required' },
  ]
  const broad = [
    { field: 'playlist', value: 'Fixture broad playlist', mode: 'required' },
  ]
  const selective = [
    {
      field: 'playlist',
      value: 'Fixture selective playlist',
      mode: 'required',
    },
  ]
  const cases = [
    {
      label: 'playlist first',
      filters: broad,
      page: 1,
      condition: 'n % 3 <> 0',
      pageBlocks: 38_000,
      countBlocks: 22_000,
    },
    {
      label: 'playlist deep',
      filters: broad,
      page: 51,
      condition: 'n % 3 <> 0',
      pageBlocks: 69_000,
      countBlocks: 22_000,
    },
    {
      label: 'selective playlist',
      filters: selective,
      page: 1,
      condition: 'n <= 3250',
      pageBlocks: 49_000,
      countBlocks: 30_000,
    },
    {
      label: 'mixed tags first',
      filters: tags,
      page: 1,
      condition: '1 + (n + n / 1000) % 1000 <= 150',
      pageBlocks: 44_000,
      countBlocks: 25_000,
    },
    {
      label: 'mixed tags near',
      filters: tags,
      page: 3,
      condition: '1 + (n + n / 1000) % 1000 <= 150',
      pageBlocks: 44_000,
      countBlocks: 25_000,
    },
  ]
  const resultRows = z.array(z.object({ count: z.number() }))

  async function read(state: 'cold' | 'published' | 'dirty') {
    const out = []
    for (const {
      label,
      filters,
      page,
      condition,
      pageBlocks,
      countBlocks,
    } of cases) {
      const countQuery = TrackQuerySchema.parse({
        filters,
        listening,
        groupRecordings: true,
      })
      const query = TrackQuerySchema.parse({
        ...countQuery,
        sortBy: 'scrobbles',
        page,
        size: 100,
      })
      const readBudget = async <T>(
        phase: string,
        blocks: number,
        operation: () => Promise<T>,
      ) => {
        let scannedEvents = 0
        const measured = await checkBudget(
          `${state} ${label} ${phase}`,
          blocks,
          8,
          operation,
          2_000_000,
          (plan) => {
            scannedEvents += scrobbleRows(plan)
          },
        )
        // The selective paths should read linked names from the matched
        // editions, even when a committed write makes the publication stale.
        if (filters !== broad)
          expect(
            scannedEvents,
            `${state} ${label} ${phase} scrobble rows`,
          ).toBeLessThan(25_000)
        return measured
      }
      const result = await readBudget(
        'page',
        state === 'published'
          ? Math.min(pageBlocks, page > 10 ? 69_000 : 32_000)
          : pageBlocks,
        () => listTrackBrowsePage(query),
      )
      const counts = await readBudget(
        'count',
        state === 'published' ? 14_000 : countBlocks,
        () => queryBrowseCounts('track', countQuery),
      )
      const known = await pool.query(`
        select count(distinct case when n between 18001 and 19000 then n - 18000 else n end)::int as count
        from generate_series(1, 20000) n where n % 4 <> 0 and (${condition})
      `)
      expect(counts.totalCount).toBe(resultRows.parse(known.rows)[0]?.count)
      expect(counts.unfilteredCount).toBe(19_000)
      expect(result.items).toHaveLength(100)
      expect(result.hasMore).toBe(true)
      out.push({ result, counts })
    }
    return out
  }

  const cold = await read('cold')
  expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(true)
  for (const table of [
    'recording_browse_order',
    'recording_browse_order_member',
  ])
    await pool.query(`vacuum analyze ${table}`)
  expect(await read('published')).toEqual(cold)
  await pool.query(
    "update library_track set scrobble_count = 1000 where media_item_id = 'track-17999'",
  )
  const dirty = await read('dirty')
  expect(dirty[0]?.result.items[0]?.id).toBe('track-17999')
  expect(dirty[3]?.result.items[0]?.id).toBe('track-17999')
  expect(dirty.map(({ counts }) => counts)).toEqual(
    cold.map(({ counts }) => counts),
  )

  // These independent page and count requests start together after a raw
  // history write. Their new threshold gives them cold request-cache keys.
  await pool.query(
    "delete from lastfm_scrobble where track_key = 'linked-17999'",
  )
  const overlapQuery = TrackQuerySchema.parse({
    filters: tags,
    listening: {
      match: 'all',
      rules: [{ period: { kind: 'all' }, min: 4, max: 12 }],
    },
    groupRecordings: true,
  })
  const overlapPage = TrackQuerySchema.parse({
    ...overlapQuery,
    sortBy: 'scrobbles',
    size: 100,
  })
  const nearPage = { ...overlapPage, page: 3 }
  const [first, near, count] = await Promise.all([
    listTrackBrowsePage(overlapPage),
    listTrackBrowsePage(nearPage),
    queryBrowseCounts('track', overlapQuery),
  ])
  expect(first).toEqual(await listTrackBrowsePage(overlapPage))
  expect(near).toEqual(await listTrackBrowsePage(nearPage))
  expect(first.items).toHaveLength(100)
  expect(near.items).toHaveLength(100)
  expect(first.items.some(({ id }) => id === 'track-17999')).toBe(false)
  expect(count.totalCount + 1).toBe(dirty[3]?.counts.totalCount)
  expect(count.unfilteredCount).toBe(19_000)

  // A Last.fm source with a playable match normally disappears from Browse.
  // Required playlist membership makes it visible in both generations.
  await pool.query(`
    delete from playlist_item where media_item_id = 'track-19999';
    update media_item set source_label = 'lastfm' where id = 'track-19999';
    update library_track set album_media_item_id = null, album_name = null
    where media_item_id = 'track-19999';
    update library_track set spotify_track_id = 'FIXTURE000000000000001'
    where media_item_id = 'track-19998';
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    values ('mixed-fixture', 'fixture artist', 'placeholder', 'track-19999');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    values ('mixed-fixture', 'fixture artist', 'placeholder', 'track-19998', 'exact');
    insert into playlist (id, kind, name)
    values ('mixed-placeholder', 'playlist', 'Fixture playlist visibility');
  `)
  const placeholder = TrackQuerySchema.parse({
    filters: [
      {
        field: 'playlist',
        value: 'Fixture playlist visibility',
        mode: 'required',
      },
    ],
    listening,
    groupRecordings: true,
  })
  expect(await queryBrowseCounts('track', placeholder)).toEqual({
    totalCount: 0,
    unfilteredCount: 18_999,
  })
  await pool.query(`
    insert into playlist_item (playlist_id, media_item_id) values ('mixed-placeholder', 'track-19999');
    update recording_browse_order_state set retry_after = statement_timestamp() - interval '1 second';
  `)
  const placeholderPage = TrackQuerySchema.parse({
    ...placeholder,
    sortBy: 'scrobbles',
  })
  const retained = await listTrackBrowsePage(placeholderPage)
  expect(retained.items.map(({ id }) => id)).toEqual(['track-19999'])
  expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(true)
  expect(await listTrackBrowsePage(placeholderPage)).toEqual(retained)
  expect(await queryBrowseCounts('track', placeholder)).toEqual({
    totalCount: 1,
    unfilteredCount: 19_000,
  })
})
