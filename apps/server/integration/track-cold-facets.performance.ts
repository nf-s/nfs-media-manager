import { expect, it, vi } from 'vitest'
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

it('bounds cold Tracks autocomplete with redundant listening rows and overlapping tags', async () => {
  const { listBrowseFacets, refreshTrackFacetVocabularyForMaintenance } =
    await import('@/services/browse')
  await pool.query(`
    update library_track set spotify_track_id = 'FIXTURE' || lpad(substring(media_item_id from 7), 15, '0');
    insert into media_item (id, slug, media_type, title, source_label)
    select 'facet-placeholder-' || n, 'facet-placeholder-' || n, 'track', 'Hidden fixture ' || n, 'lastfm'
    from generate_series(1, 16000) n;
    insert into library_track (media_item_id)
    select id from media_item where source_label = 'lastfm';
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    select 'fixture-listener', 'fixture-artist', 'hidden-fixture-' || n, 'facet-placeholder-' || n
    from generate_series(1, 16000) n;
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'fixture-listener', 'fixture-artist', 'hidden-fixture-' || n, 'track-' || n, 'exact'
    from generate_series(1, 16000) n;
    insert into tag (id, media_type, name, kind)
    select 'cold-genre-' || n, 'album', 'Fixture Genre ' || lpad(n::text, 2, '0'), 'genre'
    from generate_series(1, 48) n;
    insert into media_item_tag (media_item_id, tag_id)
    select 'album-' || n, 'cold-genre-' || label
    from generate_series(1, 1000) n
    cross join lateral generate_series(1, case when n % 2 = 0 then 20 else 1 end) label;
    insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
    select 'cold-profile-' || n, 'artist-' || n, 'lastfm', '{}',
      jsonb_build_object('tags', (select jsonb_agg('Fixture Genre ' || lpad(label::text, 2, '0')) from generate_series(1, 48) label))
    from generate_series(1, 1000) n;
    insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
    select 'artist-' || n, 'lastfm', 'cold-profile-' || n from generate_series(1, 1000) n;
    insert into track_tag (media_item_id, tag_id, sonovault, verified)
    select 'track-' || n, 'cold-genre-' || label, true, true
    from generate_series(2, 20000, 2) n cross join generate_series(17, 22) label;
    insert into track_facet_state (singleton, builder, maintenance_only)
    values (true, current_user, true)
    on conflict (singleton) do update set maintenance_only = true;
  `)
  for (const table of [
    'media_item',
    'library_track',
    'media_credit',
    'media_item_tag',
    'lastfm_track_source',
    'lastfm_track_link',
    'tag',
    'track_tag',
    'artist_provider_snapshot',
    'artist_provider_current_state',
  ])
    await pool.query(`vacuum analyze ${table}`)

  const cases = [
    { q: '', blocks: 42_000 },
    { q: 'f', blocks: 42_000 },
  ]
  for (const { q, blocks } of cases) {
    const label = q ? `cold facets for ${q}` : 'cold facets on focus'
    const suggestions = await checkBudget(label, blocks, 10, () =>
      listBrowseFacets('track', { q, limitPerField: 50 }),
    )
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'artistTag',
          value: 'fixture genre 17',
          count: 20000,
        }),
        expect.objectContaining({
          field: 'trackTag',
          value: 'fixture genre 17',
          count: 10000,
        }),
      ]),
    )
  }

  expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
  expect(await listBrowseFacets('track', { q: 'hidden fixture' })).toEqual([])
  await pool.query(`update lastfm_track_source set manually_matched = true
    where track_media_item_id = 'facet-placeholder-1'`)
  expect(
    await listBrowseFacets('track', { q: 'hidden fixture' }),
  ).toMatchObject([{ field: 'title', value: 'Hidden fixture 1', count: 1 }])
})
