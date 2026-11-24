import { expect, it, vi } from 'vitest'
import {
  PlaylistDetailQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
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
      'spotify', case when n % 100 = 0 then 'catalog-search' else 'playback' end,
      n, now() + n * interval '1 second'
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
      expect(history.totalCount).toBe(90)
      expect(history.items.map(({ position }) => position)).toEqual(
        Array.from({ length: 25 }, (_, index) => 9_000 - 100 * index),
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

it('reads distinct track appearances through canonical addresses in one statement', async () => {
  const { listTrackAppearances } = await import('@/services/track-appearances')
  const { backfillTidalSimilarDiscoveries, findStoredTidalSuggestion } =
    await import('@/services/tidal-similar')
  const { storeSpotifyCodeLookup } =
    await import('@/services/spotify-similar-lookup')
  const { getPlaylistDetail } = await import('@/services/tracks')
  await pool.query(`
    insert into media_item (id, slug, media_type, title, in_library)
    values ('appearance-unlinked', 'appearance-unlinked', 'track', 'Unlinked fixture', false);
    insert into library_track (media_item_id, album_name, album_media_item_id, album_link_strategy)
    values ('appearance-unlinked', 'Unconfirmed listening match', 'album-6', 'lastfm');
    update library_track set spotify_album_id = '00000000000000000000AL',
      spotify_track_id = '00000000000000000000TK',
      album_link_strategy = 'spotify-album' where media_item_id = 'track-1';
    update album set spotify_url = 'https://open.spotify.com/album/00000000000000000000AL'
    where media_item_id = 'album-2';
    insert into catalog_media_alias (alias_id, media_item_id) values
      ('appearance-track-alias', 'track-1'), ('appearance-album-alias', 'album-4'),
      ('appearance-seed-alias', 'track-2');
    insert into track (id, album_media_item_id, track_media_item_id, title, position) values
      ('appearance-album-position-1', 'album-3', 'track-1', 'Fixture Track', 1),
      ('appearance-album-position-2', 'album-3', 'track-1', 'Fixture Track', 2);
    insert into playlist (id, name, kind, added_to_library) values
      ('appearance-legacy-list', 'Legacy Playlist', 'playlist', true),
      ('appearance-current-list', 'Current Playlist', 'playlist', true),
      ('appearance-removed-list', 'Removed From Playlist', 'playlist', true),
      ('appearance-collection', 'Fixture Collection', 'collection', true);
    insert into playlist_item (playlist_id, media_item_id) values
      ('appearance-legacy-list', 'track-1'), ('appearance-removed-list', 'track-1'),
      ('appearance-collection', 'track-1');
    insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values
      ('appearance-tidal-ref', 'track-1', 'tidal', 'track', '1024'),
      ('appearance-isrc-ref', 'track-1', 'spotify', 'isrc', 'ZZFIX2600001'),
      ('appearance-invalid-release', 'album-3', 'spotify', 'album', 'invalid-id');
    insert into catalog_observation (id, target_kind, target_id, media_item_id, provider, operation,
      subject_kind, subject_id, relationship_role, position, details) values
      ('appearance-release', 'album', 'appearance-album-alias', 'album-4', 'tidal', 'similar',
        'track', 'appearance-track-alias', 'release', 1, null),
      ('appearance-edition', 'track', 'appearance-track-alias', 'track-1', 'discogs', 'provider-result',
        'album', 'album-5', 'track_on_edition', 2, null),
      ('appearance-current-list-version', 'playlist', 'appearance-current-list', null, 'spotify',
        'playlist-contents', null, null, null, null, '{"version":"current","complete":true}'),
      ('appearance-current-list-position-1', 'track', 'appearance-track-alias', 'track-1', 'spotify',
        'playlist-contents', 'playlist', 'appearance-current-list', 'playlist_entry', 1, '{"version":"current"}'),
      ('appearance-current-list-position-2', 'track', 'appearance-track-alias', 'track-1', 'spotify',
        'playlist-contents', 'playlist', 'appearance-current-list', 'playlist_entry', 2, '{"version":"current"}'),
      ('appearance-removed-list-version', 'playlist', 'appearance-removed-list', null, 'spotify',
        'playlist-contents', null, null, null, null, '{"version":"latest","complete":true}'),
      ('appearance-old-list-position', 'track', 'track-1', 'track-1', 'spotify',
        'playlist-contents', 'playlist', 'appearance-removed-list', 'playlist_entry', 1, '{"version":"old"}'),
      ('appearance-historical-similar', 'track', 'appearance-track-alias', 'track-1', 'tidal',
        'similar', 'track', 'appearance-seed-alias', null, 1, null),
      ('appearance-repeated-similar', 'track', 'track-1', 'track-1', 'tidal',
        'similar', 'track', 'track-2', null, 5, null),
      ('appearance-outgoing-similar', 'track', 'track-3', 'track-3', 'tidal',
        'similar', 'track', 'track-1', null, 1, null),
      ('appearance-playback', 'track', 'track-1', 'track-1', 'spotify',
        'playback', 'track', 'track-9', null, 1, null),
      ('appearance-listened-album', 'album', 'album-7', 'album-7', 'lastfm',
        'scrobble', 'track', 'track-1', 'album', 1, null);
    insert into catalog_observation (id, target_kind, target_id, media_item_id, provider, operation,
      subject_kind, subject_id, position)
    select 'appearance-observation-' || n || '-' || position, 'track', 'track-' || n,
      'track-' || n, 'tidal', 'similar', 'track', 'track-' || (n + position), position
    from generate_series(100, 2100) n cross join generate_series(1, 20) position;
    insert into tidal_similar (media_item_id, kind, items, read_at) values
      ('track-2', 'track', '[]', now()),
      ('track-5', 'track', '[{"tidalId":"1024","title":"Fixture track 00001",
        "artists":[],"version":null,"code":null,"durationSec":null,
        "releaseDate":null,"url":"https://tidal.com/browse/track/1024"}]', date_trunc('milliseconds', now())),
      ('track-6', 'track', '[{"tidalId":"2048","title":"Fixture recommendation",
        "artists":[],"version":null,"code":"ZZFIX2600001","durationSec":null,
        "releaseDate":null,"url":"https://tidal.com/browse/track/2048"}]', date_trunc('milliseconds', now())),
      ('track-7', 'track', '[{"tidalId":"4096","title":"Fixture recommendation",
        "artists":[],"version":null,"code":"ZZFIX2609999","durationSec":null,
        "releaseDate":null,"url":"https://tidal.com/browse/track/4096"}]', date_trunc('milliseconds', now()));
    insert into tidal_similar (media_item_id, kind, items, read_at)
    select 'track-' || n, 'track', jsonb_agg(jsonb_build_object('tidalId',
      (n * 100 + position)::text, 'code', 'ZZFIX27' || lpad(position::text, 5, '0'))), now()
    from generate_series(10000, 11000) n cross join generate_series(1, 20) position
    group by n;
  `)
  for (const table of [
    'catalog_observation',
    'catalog_media_alias',
    'playlist_item',
    'tidal_similar',
  ])
    await pool.query(`vacuum analyze ${table}`)

  const { items } = await checkBudget('Track appearances', 200, 1, () =>
    listTrackAppearances('appearance-track-alias'),
  )
  expect(items).toEqual([
    {
      kind: 'album',
      relationship: 'album',
      id: 'album-2',
      title: 'Fixture album 2',
      spotifyAlbumId: '00000000000000000000AL',
    },
    {
      kind: 'album',
      relationship: 'album',
      id: 'album-3',
      title: 'Fixture album 3',
    },
    {
      kind: 'album',
      relationship: 'album',
      id: 'album-4',
      title: 'Fixture album 4',
    },
    {
      kind: 'album',
      relationship: 'album',
      id: 'album-5',
      title: 'Fixture album 5',
    },
    {
      kind: 'playlist',
      relationship: 'playlist',
      id: 'appearance-current-list',
      title: 'Current Playlist',
    },
    {
      kind: 'playlist',
      relationship: 'playlist',
      id: 'appearance-legacy-list',
      title: 'Legacy Playlist',
    },
    {
      kind: 'track',
      relationship: 'similar',
      id: 'track-2',
      title: 'Fixture track 00002',
    },
  ])
  await expect(listTrackAppearances('track-1')).resolves.toEqual({ items })
  await expect(
    getPlaylistDetail(
      'appearance-current-list',
      PlaylistDetailQuerySchema.parse({}),
    ),
  ).resolves.toMatchObject({
    items: {
      totalCount: 2,
      items: [
        { position: 1, kind: 'track', track: { id: 'track-1' } },
        { position: 2, kind: 'track', track: { id: 'track-1' } },
      ],
    },
  })
  await checkBudget('Unlinked track appearances', 100, 1, async () => {
    await expect(listTrackAppearances('appearance-unlinked')).resolves.toEqual({
      items: [],
    })
  })
  await expect(listTrackAppearances('album-2')).rejects.toMatchObject({
    statusCode: 404,
  })
  await expect(
    backfillTidalSimilarDiscoveries({
      after: 'track-4',
      limit: 3,
      apply: true,
    }),
  ).resolves.toMatchObject({ next: 'track-7', candidates: 3, skipped: 0 })
  const mapped = await findStoredTidalSuggestion(
    database,
    'track',
    'track-6',
    '2048',
  )
  expect(mapped?.library?.id).toBe('track-1')
  const catalogId = mapped?.catalogMediaItemId
  if (!catalogId) throw new Error('Missing the TIDAL track catalog address')
  expect(catalogId).not.toBe('track-1')
  const seed = {
    kind: 'track',
    relationship: 'similar',
    id: 'track-6',
    title: 'Fixture track 00006',
  }
  await expect(listTrackAppearances(catalogId)).resolves.toEqual({
    items: [seed],
  })
  const projected = [
    ...items,
    {
      kind: 'track',
      relationship: 'similar',
      id: 'track-5',
      title: 'Fixture track 00005',
    },
    seed,
  ]
  await expect(listTrackAppearances('track-1')).resolves.toEqual({
    items: projected,
  })

  await pool.query(
    "insert into scrape_job (id, provider, scope, options) values ('appearance-lookup', 'spotify', '{}', '{}')",
  )
  await storeSpotifyCodeLookup({
    kind: 'track',
    key: 'ZZFIX2609999',
    itemId: 'track-7',
    jobId: 'appearance-lookup',
    match: {
      spotifyId: '00000000000000000000TK',
      url: 'https://open.spotify.com/track/00000000000000000000TK',
      title: 'Fixture track 00001',
      artists: [],
      albumName: null,
      spotifyAlbumId: null,
      artworkUrl: null,
      durationSec: null,
      trackCount: null,
    },
  })
  await expect(listTrackAppearances('track-1')).resolves.toEqual({
    items: [
      ...projected,
      {
        kind: 'track',
        relationship: 'similar',
        id: 'track-7',
        title: 'Fixture track 00007',
      },
    ],
  })
})
