import { beforeAll, expect, it, vi } from 'vitest'
import { DeviceEntitySchema, type DeviceEntity } from '@repo/schemas/device'
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

beforeAll(async () => {
  // Beside the shared library: films, playlists, tags with a hierarchy,
  // artist profiles, track tags, scrobbles and import jobs.
  await pool.query(`
    insert into media_item (id, slug, media_type, title, release_date, metadata)
    select 'film-' || n, 'film-' || n, 'film', 'Fixture film ' || n,
      timestamp '1990-01-01' + n * interval '1 day',
      jsonb_build_object('browse', jsonb_build_object('country', jsonb_build_array('NZ'), 'ratingImdbValue', n % 10))
    from generate_series(1, 1000) n;
    insert into film (media_item_id, runtime_minutes) select id, 90 from media_item where media_type = 'film';
    insert into media_credit (media_item_id, artist_id, role)
    select 'film-' || n, 'artist-' || n, 'director' from generate_series(1, 1000) n;

    insert into tag (id, media_type, name, kind)
    select 'tag-' || n, 'album', 'Fixture tag ' || n, 'genre' from generate_series(1, 200) n;
    insert into tag_ancestor (media_type, descendant_key, ancestor_key)
    select 'album', 'fixture tag ' || n, 'fixture tag ' || (n % 20 + 1) from generate_series(21, 200) n;
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'tag-' || (n % 200 + 1) from generate_series(1, 1000) n
    union all select 'album-' || n, 'tag-' || ((n + 7) % 200 + 1) from generate_series(1, 1000) n;
    insert into track_tag (media_item_id, tag_id, owner)
    select 'track-' || n, 'tag-' || (n % 200 + 1), 'added' from generate_series(1, 20000, 4) n;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'snapshot-' || n, 'artist-' || n, 'musicbrainz', '{}',
      jsonb_build_object('tags', jsonb_build_array('Fixture tag ' || (n % 200 + 1), 'Fixture style ' || n), 'country', 'NZ')
    from generate_series(1, 1000) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select artist_id, provider, id from artist_provider_snapshot;

    insert into playlist (id, name, kind, added_to_library, source, spotify_id)
    select 'playlist-' || n, 'Fixture playlist ' || n, 'playlist', true,
      case when n % 2 = 0 then 'spotify' end, case when n % 2 = 0 then 'fixturePlaylist' || n end
    from generate_series(1, 200) n;
    insert into playlist_item (playlist_id, media_item_id, position)
    select 'playlist-' || (n % 200 + 1), 'track-' || n, n from generate_series(1, 20000, 5) n;
    insert into scrape_job (id, provider, status, scope, options)
    select 'job-' || n, 'spotify', case when n % 3 = 0 then 'running' else 'succeeded' end::job_status, '{}',
      jsonb_build_object('task', 'spotify-playlist-import', 'groupKey', 'spotify:fixturePlaylist' || (n * 2))
    from generate_series(1, 100) n;

    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
    select 'scrobble-' || n || '-' || k, 'fixture-listener', timestamp '2024-01-01' + (n * 3 + k) * interval '1 minute',
      'Fixture artist', 'Fixture track ' || n, 'fixture artist', 'fixture track ' || n,
      'album-' || (1 + (n + n / 1000) % 1000)
    from generate_series(1, 4000) n cross join generate_series(1, 3) k;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'fixture-listener', 'fixture artist', 'fixture track ' || n, 'track-' || n, 'exact'
    from generate_series(1, 4000) n;
  `)
  for (const table of [
    'media_item',
    'film',
    'media_credit',
    'tag',
    'tag_ancestor',
    'media_item_tag',
    'track_tag',
    'artist_provider_snapshot',
    'artist_provider_current_state',
    'playlist',
    'playlist_item',
    'scrape_job',
    'lastfm_scrobble',
    'lastfm_track_link',
  ])
    await pool.query(`vacuum analyze ${table}`)
})

/**
 * Shared blocks and statements for 100 rows of each entity (meta has six).
 * The statement count is fixed per batch: the list loader and one projection
 * statement, never one per row. Item rows include their list loader, which
 * costs what the list endpoint pays for a page: on this fixture about 2,400
 * blocks for Tracks, 7,500 for Artists and 38,000 for Playlists.
 */
const budgets: Record<DeviceEntity, { blocks: number; statements: number }> = {
  track: { blocks: 20_000, statements: 2 },
  album: { blocks: 10_500, statements: 8 },
  film: { blocks: 8_500, statements: 3 },
  artist: { blocks: 26_000, statements: 3 },
  playlist: { blocks: 70_000, statements: 2 },
  playlist_job: { blocks: 50, statements: 1 },
  tag: { blocks: 600, statements: 1 },
  tag_key: { blocks: 50, statements: 1 },
  scrobble_name: { blocks: 1_500, statements: 1 },
  album_plays: { blocks: 2_600, statements: 1 },
  artist_plays: { blocks: 5_500, statements: 1 },
  meta: { blocks: 50, statements: 1 },
}

it('bounds a render batch of each entity', async () => {
  const { deviceRowRenderer } = await import('@/services/device-rows')
  for (const entity of DeviceEntitySchema.options) {
    const budget = budgets[entity]
    // A batch from the middle of the entity, as the sweep reads it.
    const first = await deviceRowRenderer.listIds(entity, null, 300)
    const ids = first.slice(-100)
    expect(ids.length, entity).toBeGreaterThan(0)
    await checkBudget(
      `device ${entity} render of ${ids.length}`,
      budget.blocks,
      budget.statements,
      async () => {
        const rows = await deviceRowRenderer.render(entity, ids)
        expect(rows.size, entity).toBe(ids.length)
      },
    )
  }
})

/**
 * Shared blocks of one sweep batch, as the sweep reads it: 500 IDs listed
 * after a cursor, then rendered (one statement more than the render). The
 * listing reads each source table's key index from the cursor, so it costs
 * the same at any position; the render is most of a batch. Entities with
 * fewer than 750 IDs on this fixture are measured from the start, and
 * Playlists (200 here) cost about 680 blocks a row in the list loader.
 */
const sweepBudgets: Record<
  DeviceEntity,
  { listing: number; batch: number; statements: number }
> = {
  track: { listing: 2_000, batch: 55_000, statements: 3 },
  album: { listing: 100, batch: 40_000, statements: 9 },
  film: { listing: 100, batch: 38_000, statements: 4 },
  artist: { listing: 1_300, batch: 45_000, statements: 4 },
  playlist: { listing: 100, batch: 170_000, statements: 3 },
  playlist_job: { listing: 50, batch: 50, statements: 2 },
  tag: { listing: 50, batch: 1_000, statements: 2 },
  tag_key: { listing: 50, batch: 50, statements: 2 },
  scrobble_name: { listing: 3_600, batch: 7_000, statements: 2 },
  album_plays: { listing: 250, batch: 3_000, statements: 2 },
  artist_plays: { listing: 1_300, batch: 4_000, statements: 2 },
  meta: { listing: 50, batch: 50, statements: 2 },
}

it('bounds a sweep batch of each entity', async () => {
  const { deviceRowRenderer } = await import('@/services/device-rows')
  for (const entity of DeviceEntitySchema.options) {
    const budget = sweepBudgets[entity]
    // The second batch position of an entity with more IDs than that.
    const head = await deviceRowRenderer.listIds(entity, null, 250)
    const after = head.length === 250 ? (head.at(-1) ?? null) : null
    await checkBudget(`device ${entity} sweep listing`, budget.listing, 1, () =>
      deviceRowRenderer.listIds(entity, after, 500),
    )
    await checkBudget(
      `device ${entity} sweep batch`,
      budget.batch,
      budget.statements,
      async () => {
        const ids = await deviceRowRenderer.listIds(entity, after, 500)
        expect(ids.length, entity).toBeGreaterThan(0)
        const rows = await deviceRowRenderer.render(entity, ids)
        expect(rows.size, entity).toBeGreaterThan(0)
      },
    )
  }
})
