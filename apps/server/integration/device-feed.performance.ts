import pg from 'pg'
import { beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DEVICE_ROW_VERSION } from '@repo/schemas/device'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { name, connection, pool, database, checkBudget } =
  createTrackPerformanceFixture()

vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  listLoadedScrapePlugins: async () => [],
}))

const TriggerExplainSchema = z.tuple([
  z.object({
    'QUERY PLAN': z.tuple([
      z.object({
        Triggers: z
          .array(z.object({ 'Trigger Name': z.string(), Time: z.number() }))
          .default([]),
      }),
    ]),
  }),
])

// Rows the twenty thousand tracks of the fixture reach through every table
// that feeds a device row, so each trigger joins tables of realistic size.
beforeAll(async () => {
  await pool.query(`
    insert into media_credit (media_item_id, artist_id, role)
    select 'album-' || n, 'artist-' || n, 'artist' from generate_series(1, 1000) n;
    insert into media_item (id, slug, media_type, title)
    select 'film-' || n, 'film-' || n, 'film', 'Fixture film ' || n from generate_series(1, 200) n;
    insert into film (media_item_id) select 'film-' || n from generate_series(1, 200) n;
    insert into track (id, album_media_item_id, track_media_item_id, title, position)
    select 'entry-' || n, 'album-' || (1 + (n + n / 1000) % 1000), 'track-' || n, 'Fixture entry', n
    from generate_series(1, 20000) n;
    insert into playlist (id, name, kind)
    select 'list-' || n, 'Fixture playlist ' || n, 'playlist' from generate_series(1, 100) n;
    insert into playlist_item (playlist_id, media_item_id, position)
    select 'list-' || (1 + n % 100), 'track-' || n, n from generate_series(1, 20000) n;
    insert into tag (id, media_type, name, kind)
    select 'tag-' || n, 'album', 'Fixture tag ' || n, 'genre' from generate_series(1, 200) n;
    insert into tag_identity (media_type, normalized_name, kind, tag_id)
    select 'album', 'fixture identity ' || n, 'genre', 'tag-' || n from generate_series(1, 200) n;
    insert into tag_alias (source_tag_id, target_tag_id)
    select 'tag-' || n, 'tag-' || (n - 150) from generate_series(151, 200) n;
    insert into tag_parent (media_type, child_key, parent_key)
    select 'album', 'fixture tag ' || n, 'fixture tag ' || (1 + n % 10) from generate_series(11, 150) n;
    insert into tag_ancestor (media_type, descendant_key, ancestor_key)
    select 'album', 'fixture tag ' || n, 'fixture tag ' || (1 + n % 10) from generate_series(11, 150) n;
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'tag-' || (1 + n % 150) from generate_series(1, 1000) n;
    insert into track_tag (media_item_id, tag_id, owner)
    select 'track-' || n, 'tag-' || (1 + n % 150), 'added' from generate_series(1, 20000) n;
    insert into tag_occurrence (id, media_item_id, tag_id, raw_name, kind)
    select 'occurrence-' || n, 'album-' || n, 'tag-' || (1 + n % 150), 'Fixture tag', 'genre'
    from generate_series(1, 1000) n;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'snapshot-' || n, 'artist-' || n, 'lastfm', '{}',
      jsonb_build_object('tags', jsonb_build_array('Fixture tag ' || (1 + n % 150)))
    from generate_series(1, 1000) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select 'artist-' || n, 'lastfm', 'snapshot-' || n from generate_series(1, 1000) n;
    insert into provider_reference (id, media_item_id, provider, reference_type, external_id)
    select 'reference-' || n, 'track-' || n, 'spotify', 'track', 'fixture-' || n
    from generate_series(1, 20000) n;
    insert into provider_reference_override (id, media_item_id, provider, reference_type, external_id)
    select 'reference-override-' || n, 'album-' || n, 'spotify', 'album', 'fixture-' || n
    from generate_series(1, 1000) n;
    insert into external_link (id, media_item_id, provider, label, url)
    select 'link-' || n, 'album-' || n, 'fixture', 'Fixture', 'https://example.test/' || n
    from generate_series(1, 1000) n;
    insert into media_override (id, media_item_id, field, value)
    select 'override-' || n, 'album-' || n, 'summary', '"Fixture"' from generate_series(1, 1000) n;
    insert into track_fact (media_item_id, provider, bpm, verified, fetched_at)
    select 'track-' || n, 'fixture', 100 + n % 50, true, now() from generate_series(1, 20000) n;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'listener', 'artist ' || n, 'track ' || n, 'track-' || n, 'exact' from generate_series(1, 20000) n;
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    select 'listener', 'artist ' || n, 'track ' || n, 'track-' || n from generate_series(1, 20000) n;
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
    select 'listen-' || n, 'listener', timestamp '2024-01-01' + n * interval '1 minute',
      'Fixture artist', 'Fixture track', 'artist ' || (1 + n % 20000), 'track ' || (1 + n % 20000),
      'album-' || (1 + n % 1000)
    from generate_series(1, 40000) n;
    insert into catalog_observation (id, target_kind, target_id, provider, operation)
    select 'observation-' || n, 'artist', 'artist-' || (1 + n % 1000), 'fixture', 'artist'
    from generate_series(1, 2000) n;
    insert into scrape_job (id, provider, status, scope, options)
    select 'job-' || n, 'spotify', 'queued', '{}',
      jsonb_build_object('task', 'spotify-playlist-import', 'groupKey', 'spotify:fixture-' || n)
    from generate_series(1, 2000) n;
    delete from device_dirty;
    insert into device_row (entity, id, payload, hash, seq, size)
    select 'album_plays', 'album-' || lpad(n::text, 5, '0'),
      jsonb_build_object('plays', (select jsonb_agg(1700000000 + n * 100 + p) from generate_series(1, 20) p)),
      md5(n::text), nextval('device_row_seq'), 260
    from generate_series(1, 20000) n;
    update device_feed_state set epoch = 'fixture-epoch', row_version = ${DEVICE_ROW_VERSION}, ready = true;
  `)
  for (const table of [
    'device_row',
    'device_dirty',
    'track',
    'playlist_item',
    'track_tag',
    // Track tags set `has_own_tags` on every track.
    'library_track',
    'media_item_tag',
    'tag',
    'tag_identity',
    'tag_alias',
    'artist_provider_snapshot',
    'artist_provider_current_state',
    'provider_reference',
    'lastfm_track_link',
    'lastfm_track_source',
    'lastfm_scrobble',
    'catalog_observation',
    'scrape_job',
  ])
    await pool.query(`vacuum analyze ${table}`)
})

it('bounds a device changes page and a snapshot page', async () => {
  const { readDeviceChanges, readDeviceSnapshot } =
    await import('@/services/device-feed')
  await checkBudget('device changes page', 100, 2, async () => {
    const page = await readDeviceChanges({
      epoch: 'fixture-epoch',
      since: 10_000,
      limit: 500,
    })
    if (page.reset) throw new Error('The changes were reset')
    expect(page.rows).toHaveLength(500)
    expect(page.hasMore).toBe(true)
  })
  await checkBudget('device snapshot page', 100, 2, async () => {
    const page = await readDeviceSnapshot({
      epoch: 'fixture-epoch',
      entity: 'album_plays',
      after: 10_000,
      limit: 500,
    })
    if (page.reset) throw new Error('The snapshot was reset')
    expect(page.rows).toHaveLength(500)
  })
})

it('bounds the device state after many marks were rendered, before a vacuum', async () => {
  const { readDeviceFeedState } = await import('@/services/device-feed')
  await pool.query(`insert into device_dirty (entity, id)
    select 'track', 'track-' || n from generate_series(1, 100000) n`)
  await pool.query('delete from device_dirty')
  // Until autovacuum runs, the test for pending marks reads past the pages of
  // rendered ones: about 740 blocks for 100,000 marks.
  await checkBudget('device state after rendered marks', 800, 1, async () => {
    expect(await readDeviceFeedState()).toMatchObject({ ready: true })
  })
})

it('bounds a maintenance run with nothing to do and one rendering 200 marks', async () => {
  const { refreshDeviceFeedForMaintenance } =
    await import('@/services/device-feed')
  // A built feed whose last sweep completed an hour ago.
  await pool.query(`delete from device_dirty;
    update device_feed_state set ready = true, sweep_entity = null,
      sweep_after = null, swept_at = now() - interval '1 hour'`)
  await pool.query('vacuum analyze device_dirty')
  // It runs every five minutes, so it is one statement on a few pages.
  await checkBudget('device maintenance run, idle', 20, 1, async () => {
    expect((await refreshDeviceFeedForMaintenance()).published).toBe(false)
  })

  // Two hundred tracks; each shares its title with another track, which
  // renders with it. The feed holds none of them yet.
  await pool.query(`insert into device_dirty (entity, id)
    select 'track', 'track-' || n from generate_series(1, 200) n`)
  // About 220 blocks a rendered track, as a render batch of tracks costs.
  await checkBudget(
    'device maintenance run, 200 track marks',
    100_000,
    12,
    async () => {
      expect((await refreshDeviceFeedForMaintenance()).published).toBe(true)
    },
  )
  const rendered = z
    .object({ count: z.number() })
    .parse(
      (
        await pool.query(
          "select count(*)::int as count from device_row where entity = 'track'",
        )
      ).rows[0],
    ).count
  expect(rendered).toBe(400)
  await pool.query("delete from device_row where entity = 'track'")
})

const bulk = (count: number) => `select n from generate_series(1, ${count}) n`

// Each write is one statement on a table with device triggers: a one-row
// write, and a bulk write of up to two thousand rows. The time is that of the
// device triggers alone, as EXPLAIN ANALYZE reports it.
const writes: { table: string; one: string; many: string }[] = [
  {
    table: 'media_item',
    one: "update media_item set title = title || ' (edit)' where id = 'album-1'",
    many: `update media_item set title = title || ' (edit)' where id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'media_item',
    one: "update media_item set in_library = false where id = 'album-1'",
    many: `update media_item set in_library = false where id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'library_track',
    one: "update library_track set album_media_item_id = 'album-3' where media_item_id = 'track-1'",
    many: `update library_track set album_media_item_id = 'album-3' where media_item_id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'library_track',
    one: "update library_track set album_media_item_id = null where media_item_id = 'track-1'",
    many: `update library_track set album_media_item_id = null where media_item_id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'album',
    one: "update album set track_count = track_count + 1 where media_item_id = 'album-1'",
    many: 'update album set track_count = track_count + 1',
  },
  {
    table: 'album',
    one: "delete from album where media_item_id = 'album-1'",
    many: `delete from album where media_item_id in (select 'album-' || n from (${bulk(100)}) s)`,
  },
  {
    table: 'film',
    one: "update film set watched = true where media_item_id = 'film-1'",
    many: 'update film set watched = true',
  },
  {
    table: 'track',
    one: "update track set position = position + 100000 where id = 'entry-1'",
    many: `update track set position = position + 100000 where id in (select 'entry-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'track',
    one: "delete from track where id = 'entry-1'",
    many: `delete from track where id in (select 'entry-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'media_credit',
    one: "insert into media_credit (media_item_id, artist_id, role) values ('track-1', 'artist-2', 'artist')",
    many: `update media_credit set billing_order = 1 where media_item_id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'artist',
    one: "update artist set name = 'Fixture renamed artist' where id = 'artist-1'",
    many: 'update artist set scrobble_count = scrobble_count + 1',
  },
  {
    table: 'artist',
    one: "update artist set added_to_library = true where id = 'artist-1'",
    many: 'update artist set added_to_library = true',
  },
  {
    table: 'artist_provider_current_state',
    one: "update artist_provider_current_state set latest_snapshot_id = 'snapshot-2' where artist_id = 'artist-1'",
    many: 'delete from artist_provider_current_state',
  },
  {
    table: 'artist_provider_snapshot',
    one: `update artist_provider_snapshot set normalized_data = '{"tags": ["Fixture tag 9"]}' where id = 'snapshot-1'`,
    many: `insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      select 'snapshot-new-' || n, 'artist-' || n, 'lastfm', '{}', '{"tags": []}' from (${bulk(1000)}) s`,
  },
  {
    table: 'tag',
    one: "update tag set name = 'Fixture renamed tag' where id = 'tag-1'",
    many: "update tag set kind = 'style'",
  },
  {
    table: 'tag_alias',
    one: "insert into tag_alias (source_tag_id, target_tag_id) values ('tag-100', 'tag-1')",
    many: 'delete from tag_alias',
  },
  {
    table: 'tag_identity',
    one: "insert into tag_identity (media_type, normalized_name, kind, tag_id) values ('album', 'fixture other identity', 'genre', 'tag-1')",
    many: 'delete from tag_identity',
  },
  {
    table: 'tag_parent',
    one: "insert into tag_parent (media_type, child_key, parent_key) values ('album', 'fixture tag 200', 'fixture tag 1')",
    many: "delete from tag_parent where media_type = 'album'",
  },
  {
    table: 'tag_ancestor',
    one: "delete from tag_ancestor where descendant_key = 'fixture tag 11'",
    many: "delete from tag_ancestor where media_type = 'album'",
  },
  {
    table: 'media_item_tag',
    one: "insert into media_item_tag (media_item_id, tag_id) values ('album-1', 'tag-150')",
    many: 'delete from media_item_tag',
  },
  {
    table: 'track_tag',
    one: "insert into track_tag (media_item_id, tag_id, owner) values ('track-1', 'tag-150', 'added')",
    many: `update track_tag set owner = 'removed' where media_item_id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'tag_occurrence',
    one: "update tag_occurrence set kind = 'style' where id = 'occurrence-1'",
    many: "update tag_occurrence set kind = 'style'",
  },
  {
    table: 'playlist',
    one: "update playlist set name = 'Fixture renamed playlist' where id = 'list-1'",
    many: 'update playlist set checked_at = now()',
  },
  {
    table: 'playlist_item',
    one: "insert into playlist_item (playlist_id, media_item_id) values ('list-1', 'album-1')",
    many: `delete from playlist_item where playlist_id in (select 'list-' || n from (${bulk(10)}) s)`,
  },
  {
    table: 'provider_reference',
    one: "insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values ('reference-new', 'album-1', 'spotify', 'album', 'fixture-new')",
    many: `update provider_reference set is_primary = true where id in (select 'reference-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'provider_reference_override',
    one: "insert into provider_reference_override (id, media_item_id, provider, reference_type, external_id) values ('reference-override-new', 'album-1', 'tidal', 'album', 'fixture-new')",
    many: "update provider_reference_override set note = 'Fixture'",
  },
  {
    table: 'external_link',
    one: "insert into external_link (id, media_item_id, provider, label, url) values ('link-new', 'album-1', 'fixture', 'Fixture', 'https://example.test/new')",
    many: "update external_link set label = 'Fixture link'",
  },
  {
    table: 'media_override',
    one: `insert into media_override (id, media_item_id, field, value) values ('override-new', 'album-1', 'title', '"Fixture"')`,
    many: "update media_override set note = 'Fixture'",
  },
  {
    table: 'track_fact',
    one: "update track_fact set bpm = 120 where media_item_id = 'track-1'",
    many: `update track_fact set bpm = 120 where media_item_id in (select 'track-' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'lastfm_track_source',
    one: "update lastfm_track_source set manually_matched = true where track_media_item_id = 'track-1'",
    many: `update lastfm_track_source set manually_matched = true where artist_key in (select 'artist ' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'lastfm_track_link',
    one: "insert into lastfm_track_link values ('listener', 'artist 1', 'track 1', 'track-2', 'exact')",
    many: `delete from lastfm_track_link where artist_key in (select 'artist ' || n from (${bulk(2000)}) s)`,
  },
  {
    table: 'lastfm_scrobble',
    one: "insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id) values ('listen-new', 'listener', now(), 'A', 'T', 'artist 1', 'track 1', 'album-1')",
    many: `insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
      select 'listen-new-' || n, 'listener', now(), 'A', 'T', 'artist ' || n, 'track ' || n, 'album-' || (1 + n % 1000)
      from (${bulk(2000)}) s`,
  },
  {
    table: 'catalog_observation',
    one: "insert into catalog_observation (id, target_kind, target_id, provider, operation) values ('observation-new', 'artist', 'artist-1', 'fixture', 'artist')",
    many: `insert into catalog_observation (id, target_kind, target_id, provider, operation)
      select 'observation-new-' || n, 'artist', 'artist-' || (1 + n % 1000), 'fixture', 'artist' from (${bulk(2000)}) s`,
  },
  {
    table: 'scrape_job',
    one: "update scrape_job set status = 'succeeded', finished_at = now() where id = 'job-1'",
    many: `update scrape_job set status = 'running' where id in (select 'job-' || n from (${bulk(2000)}) s)`,
  },
]

it('bounds the device triggers of a one-row and a bulk write on each table', async () => {
  // One connection plans every statement, so a one-row write before a bulk
  // one would expose a reused plan.
  const session = new pg.Client({
    ...connection,
    database: name,
    options: '-c jit=off',
  })
  await session.connect()
  try {
    const tables = new Set<string>()
    for (const write of writes) {
      for (const [size, statement, budgetMs] of [
        ['one-row', write.one, 50],
        ['bulk', write.many, 750],
      ] as const) {
        await session.query('begin')
        try {
          const result = await session.query(
            `explain (analyze, format json) ${statement}`,
          )
          const triggers = TriggerExplainSchema.parse(result.rows)[0][
            'QUERY PLAN'
          ][0].Triggers.filter((trigger) =>
            trigger['Trigger Name'].startsWith('device_dirty_'),
          )
          const marks = z
            .object({ count: z.number() })
            .parse(
              (
                await session.query(
                  'select count(*)::int as count from device_dirty',
                )
              ).rows[0],
            ).count
          const ms = triggers.reduce((sum, trigger) => sum + trigger.Time, 0)
          process.stdout.write(
            `device triggers, ${size} ${write.table} write: ${ms.toFixed(1)}/${budgetMs} ms, ${marks} marks\n`,
          )
          expect(triggers.length, `${size} ${write.table}`).toBeGreaterThan(0)
          expect(ms, `${size} ${write.table}`).toBeLessThanOrEqual(budgetMs)
        } finally {
          await session.query('rollback')
        }
      }
      tables.add(write.table)
    }
    const installed = z
      .array(z.object({ table: z.string() }))
      .parse(
        (
          await session.query(`select distinct event_object_table as table
            from information_schema.triggers where trigger_name like 'device_dirty_%'`)
        ).rows,
      )
      .map((row) => row.table)
    expect([...tables].sort()).toEqual(installed.sort())
  } finally {
    await session.end()
  }
})
