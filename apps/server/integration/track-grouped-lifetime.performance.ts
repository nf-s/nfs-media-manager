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

const scanSchema = z.object({
  'Relation Name': z.string().optional(),
  'Actual Rows': z.number(),
  'Actual Loops': z.number(),
  'Rows Removed by Filter': z.number().default(0),
  Plans: z.array(z.unknown()).default([]),
})

function historyRowsVisited(plan: unknown): number {
  const scan = scanSchema.parse(plan)
  const rows =
    scan['Relation Name'] === 'lastfm_scrobble'
      ? (scan['Actual Rows'] + scan['Rows Removed by Filter']) *
        scan['Actual Loops']
      : 0
  return (
    rows +
    scan.Plans.reduce<number>(
      (sum, child) => sum + historyRowsVisited(child),
      0,
    )
  )
}

it('bounds grouped lifetime pages and counts when the published order is dirty', async () => {
  const { listTrackBrowsePage } = await import('@/services/tracks')
  const { queryBrowseCounts, refreshRecordingBrowseOrderForMaintenance } =
    await import('@/services/browse')

  await pool.query(`
    insert into tag (id, media_type, name, kind)
    values ('grouped-genre', 'album', 'Grouped fixture genre', 'genre');
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'grouped-genre' from generate_series(1, 150) n;
    insert into playlist (id, kind, name)
    values ('grouped-playlist', 'playlist', 'Grouped fixture playlist');
    insert into playlist_item (playlist_id, media_item_id)
    select 'grouped-playlist', 'track-' || n
    from generate_series(1, 20000) n where n % 3 <> 0;
    update library_track set scrobble_count = (substring(media_item_id from 7)::int % 4);
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'grouped-fixture', 'fixture artist', 'linked-' || n, 'track-' || n, 'name'
    from generate_series(1, 20000) n where n % 4 <> 0;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'grouped-linked-' || n || '-' || event, 'grouped-fixture',
      case when event % 3 = 0 then statement_timestamp() - interval '2 days'
        else timestamp '2001-01-01' + event * interval '1 day' end,
      'Fixture artist', 'Linked track', 'fixture artist', 'linked-' || n
    from generate_series(1, 20000) n cross join generate_series(1, 6) event
    where n % 4 <> 0;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
    select 'grouped-unlinked-' || n || '-' || event, 'grouped-fixture',
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

  const lifetime = { period: { kind: 'all' }, min: 3, max: 15 }
  const recent = {
    period: { kind: 'rolling', amount: 1, unit: 'years' },
    min: 2,
    max: 6,
  }
  const playlist = [
    { field: 'playlist', value: 'Grouped fixture playlist', mode: 'required' },
  ]
  const genre = [
    { field: 'genre', value: 'Grouped fixture genre', mode: 'required' },
  ]
  const cases = [
    {
      label: 'playlist first',
      filters: playlist,
      page: 1,
      pageBlocks: 30_000,
      countBlocks: 12_000,
    },
    {
      label: 'playlist deep',
      filters: playlist,
      page: 51,
      pageBlocks: 65_000,
      countBlocks: 12_000,
    },
    {
      label: 'genre lifetime numeric',
      filters: genre,
      page: 1,
      pageBlocks: 60_000,
      countBlocks: 45_000,
      listening: { match: 'all', rules: [lifetime] },
    },
    {
      label: 'genre mixed numeric',
      filters: genre,
      page: 3,
      pageBlocks: 60_000,
      countBlocks: 45_000,
      listening: { match: 'all', rules: [lifetime, recent] },
    },
  ]

  async function read(state: string) {
    const out = []
    for (const {
      label,
      filters,
      page,
      pageBlocks,
      countBlocks,
      listening,
    } of cases) {
      const countQuery = TrackQuerySchema.parse({
        filters,
        listening: listening && JSON.stringify(listening),
        groupRecordings: true,
      })
      const query = TrackQuerySchema.parse({
        ...countQuery,
        listening: listening && JSON.stringify(listening),
        sortBy: 'scrobbles',
        page,
        size: 100,
      })
      // A clean generation has a separate membership plan. A cold or
      // dirty generation must keep the scan within the filtered history.
      const historyBudget =
        listening && state !== 'published'
          ? (plan: unknown) =>
              expect(historyRowsVisited(plan), label).toBeLessThanOrEqual(
                80_000,
              )
          : undefined
      const result = await checkBudget(
        `${state} ${label} page`,
        pageBlocks,
        6,
        () => listTrackBrowsePage(query),
        undefined,
        historyBudget,
      )
      const counts = await checkBudget(
        `${state} ${label} count`,
        countBlocks,
        8,
        () => queryBrowseCounts('track', countQuery),
        undefined,
        historyBudget,
      )
      expect(result.items).toHaveLength(100)
      expect(result.hasMore).toBe(true)
      const playbackOrder = result.items.map(({ scrobbles }) => scrobbles)
      expect(playbackOrder).toEqual([...playbackOrder].sort((a, b) => b - a))
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

  await pool.query(`
    update library_track set version_group_id = 'grouped-fresh-write',
      version_shown = media_item_id = 'track-17999'
    where media_item_id in ('track-17998', 'track-17999')
  `)
  const dirty = await read('dirty')
  expect(dirty.map(({ counts }) => counts)).toEqual(
    cold.map(({ counts }) => ({
      totalCount: counts.totalCount - 1,
      unfilteredCount: counts.unfilteredCount - 1,
    })),
  )
  const newGroup = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'scrobbles',
    filters: [
      { field: 'title', value: 'Fixture track 17998', mode: 'any' },
      { field: 'title', value: 'Fixture track 17999', mode: 'any' },
    ],
  })
  const [groupPage, groupCounts] = await Promise.all([
    listTrackBrowsePage(newGroup),
    queryBrowseCounts('track', newGroup),
  ])
  expect(groupPage.items).toMatchObject([
    { id: 'track-17999', recordingGroup: { versionCount: 2 } },
  ])
  expect(groupCounts.totalCount).toBe(1)

  // Two eligible maintenance invocations must share one publication.
  await pool.query(`update recording_browse_order_state
    set retry_after = statement_timestamp() where singleton`)
  const refreshes = await Promise.all([
    refreshRecordingBrowseOrderForMaintenance(),
    refreshRecordingBrowseOrderForMaintenance(),
  ])
  expect(refreshes.filter(Boolean)).toHaveLength(1)
  expect(await listTrackBrowsePage(newGroup)).toEqual(groupPage)
  expect(await queryBrowseCounts('track', newGroup)).toEqual(groupCounts)
})
