import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CreateLibraryPlaylistSchema,
  LibraryPlaylistSelectionSchema,
  type LibraryPlaylistLibrary,
} from '@repo/schemas/library-playlists'
import {
  PlaylistBrowseQuerySchema,
  PlaylistBrowseSortSchema,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

// PL-17 on the shared fixture of 20,000 synthetic tracks and 1,000 albums,
// with two films, four imported playlists, a legacy saved view and library
// playlists added below. Every name is invented.
const { database, pool, logQuery } = createTrackPerformanceFixture()
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

beforeAll(async () => {
  await pool.query(`
    insert into "user" (id, name, email) values ('owner', 'Owner', 'owner@example.test');
    insert into media_item (id, slug, media_type, title) values
      ('film-1', 'film-1', 'film', 'Synthetic film 1'),
      ('film-2', 'film-2', 'film', 'Synthetic film 2');
    insert into film (media_item_id) values ('film-1'), ('film-2');
    insert into playlist (id, name, kind, source, spotify_id, owner_name, imported_at, added_to_library) values
      ('imported-alpha', 'Alpha imported', 'playlist', 'spotify', 'alpha', 'Synthetic owner', '2025-03-01', false),
      ('imported-delta', 'Delta liked', 'playlist', 'spotify-liked', null, null, '2025-01-01', false),
      ('imported-legacy', 'Legacy echo', 'playlist', null, null, null, null, true),
      ('imported-hidden', 'Hidden echo', 'playlist', null, null, null, null, false);
    insert into playlist_item (playlist_id, media_item_id, position) values
      ('imported-alpha', 'track-1', 1), ('imported-alpha', 'track-2', 2),
      ('imported-alpha', 'track-3', 3), ('imported-delta', 'track-4', 1),
      ('imported-legacy', 'track-5', 1), ('imported-legacy', 'track-6', 2);
    update playlist set description = 'Mix 100% Synthetic', created_at = '2025-02-01 00:00:00',
      checked_at = '2025-03-01 23:59:59.999999', sync_schedule = 'daily'
      where id = 'imported-alpha';
    update playlist set sync_schedule = 'weekly' where id = 'imported-delta';
    insert into playlist (id, name, kind, catalog_provider, spotify_url, created_at)
      values ('outside-spotify', 'Outside Spotify', 'playlist', 'spotify',
        'https://open.spotify.com/playlist/synthetic', '2025-02-01');
    insert into scrape_job (id, provider, status, scope, options, created_at)
    values ('delta-old', 'spotify', 'succeeded', '{}',
      '{"task":"spotify-playlist-import","groupKey":"spotify-liked"}', '2025-01-01'),
      ('delta-new', 'spotify', 'failed', '{}',
      '{"task":"spotify-playlist-import","groupKey":"spotify-liked"}', '2025-01-02');
  `)
  await pool.query(
    `insert into provider_snapshot (id, provider, checksum, payload, source)
    values ('views', 'legacy-smart-playlists', 'views', $1, 'legacy-import:smart-playlists.json')`,
    [
      JSON.stringify([
        { name: 'Quiet echo', filters: [], sort: ['title', 'ASC'], limit: 2 },
      ]),
    ],
  )
  const {
    addLibraryPlaylistEntries,
    createLibraryPlaylist,
    deleteLibraryPlaylist,
  } = await import('@/services/library-playlists')
  const create = async (
    library: LibraryPlaylistLibrary,
    name: string,
    ids: string[] = [],
  ) => {
    const { playlist } = await createLibraryPlaylist(
      CreateLibraryPlaylistSchema.parse({ type: 'playlist', library, name }),
      'owner',
    )
    if (ids.length)
      await addLibraryPlaylistEntries(
        playlist.id,
        LibraryPlaylistSelectionSchema.parse({ ids }),
        'again',
      )
    return playlist.id
  }
  const smart = (library: LibraryPlaylistLibrary, name: string) =>
    createLibraryPlaylist(
      CreateLibraryPlaylistSchema.parse({
        type: 'smart',
        library,
        name,
        view: { q: 'synthetic' },
      }),
      'owner',
    )
  await create('tracks', 'Beta', ['track-7', 'track-8', 'track-9', 'track-10'])
  await create('tracks', 'echo night')
  await smart('tracks', 'Charlie smart')
  await deleteLibraryPlaylist(await create('tracks', 'Gone'))
  await create('albums', 'Album list', ['album-1'])
  await create('films', 'Film night', ['film-1', 'film-2'])
  await smart('films', 'Film smart')
  await create('subscriptions', 'Videos')
  await smart('subscriptions', 'Videos smart')
  await smart('mixes', 'Mixes smart')
}, 120_000)

async function directory(input: Record<string, unknown> = {}) {
  const { countPlaylists, listPlaylistBrowsePage } =
    await import('@/services/playlist-directory')
  const query = PlaylistBrowseQuerySchema.parse(input)
  const [page, count] = await Promise.all([
    listPlaylistBrowsePage(query),
    countPlaylists(query),
  ])
  return { items: page.items, hasMore: page.hasMore, count: count.totalCount }
}

const names = (items: PlaylistSummary[]) => items.map((item) => item.name)
const importedNames = ['Alpha imported', 'Delta liked', 'Legacy echo']
const listed: Record<LibraryPlaylistLibrary, string[]> = {
  tracks: [...importedNames, 'Beta', 'Charlie smart', 'echo night'],
  albums: [...importedNames, 'Album list', 'Quiet echo'],
  films: ['Film night', 'Film smart'],
  subscriptions: ['Videos', 'Videos smart'],
  mixes: ['Mixes smart'],
}
const libraries = Object.keys(listed).filter(
  (library): library is LibraryPlaylistLibrary => library in listed,
)
const byName = (left: string, right: string) =>
  left.toLowerCase() < right.toLowerCase() ? -1 : 1

describe('Playlists directory of a library', () => {
  it('lists each library with its own rows, imported ones in Albums and Tracks', async () => {
    for (const library of libraries) {
      const result = await directory({ library })
      expect(names(result.items), library).toEqual(
        [...listed[library]].sort(byName),
      )
      expect(result.count, library).toBe(listed[library].length)
    }
    const tracks = (await directory({ library: 'tracks' })).items
    expect(tracks.find((item) => item.name === 'Alpha imported')).toMatchObject(
      {
        origin: 'imported',
        type: 'playlist',
        library: null,
        view: null,
        source: 'spotify',
        updatedAt: '2025-03-01T00:00:00.000Z',
        itemCount: 3,
      },
    )
    expect(tracks.find((item) => item.name === 'Beta')).toMatchObject({
      origin: 'library',
      type: 'playlist',
      library: 'tracks',
      view: null,
      source: null,
      inLibrary: true,
      trackCount: 0,
      itemCount: 4,
      acceptsAdditions: false,
    })
    expect(tracks.find((item) => item.name === 'Charlie smart')).toMatchObject({
      origin: 'library',
      type: 'smart',
      view: { q: 'synthetic' },
      itemCount: null,
    })
    const albums = (await directory({ library: 'albums' })).items
    // An imported playlist's count in Albums is its albums.
    expect(albums.find((item) => item.name === 'Alpha imported')).toMatchObject(
      { itemCount: 3, albumCount: 3 },
    )
    // PL-05: the legacy saved view is an Albums smart playlist.
    expect(albums.find((item) => item.name === 'Quiet echo')).toMatchObject({
      type: 'smart',
      library: 'albums',
    })
  })

  it('leaves the response without a library as it was', async () => {
    const result = await directory()
    expect(names(result.items)).toEqual(importedNames)
    expect(result.count).toBe(3)
    for (const item of result.items)
      for (const key of [
        'origin',
        'type',
        'library',
        'view',
        'updatedAt',
        'itemCount',
      ])
        expect(item).not.toHaveProperty(key)
    for (const sortBy of PlaylistBrowseSortSchema.options)
      expect(
        (await directory({ sortBy })).items.length,
        `${sortBy} without a library`,
      ).toBe(3)
  })

  it('searches both kinds and filters by source', async () => {
    expect(
      names((await directory({ library: 'tracks', q: 'echo' })).items),
    ).toEqual(['echo night', 'Legacy echo'])
    expect(await directory({ library: 'tracks', q: 'echo' })).toMatchObject({
      count: 2,
    })
    // An imported playlist also matches its owner; a library row its name.
    expect(
      names((await directory({ library: 'tracks', q: 'synthetic' })).items),
    ).toEqual(['Alpha imported'])
    expect(
      names((await directory({ library: 'tracks', name: 'smart' })).items),
    ).toEqual(['Charlie smart'])
    const spotify = await directory({
      library: 'tracks',
      sources: JSON.stringify(['spotify']),
    })
    expect(names(spotify.items)).toEqual(['Alpha imported'])
    expect(spotify.count).toBe(1)
    const library = await directory({
      library: 'tracks',
      sources: JSON.stringify(['library']),
    })
    expect(names(library.items)).toEqual([
      'Beta',
      'Charlie smart',
      'echo night',
      'Legacy echo',
    ])
    expect(library.count).toBe(4)
    const additions = await directory({
      library: 'tracks',
      acceptsAdditions: 'true',
    })
    expect(names(additions.items)).toEqual(['Alpha imported'])
    expect(additions.count).toBe(1)
    expect(
      await directory({
        library: 'films',
        sources: JSON.stringify(['spotify']),
      }),
    ).toEqual({ items: [], hasMore: false, count: 0 })
  })

  it('matches text, source, type, schedule and saved-view filters', async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ owner: '  SYNTHETIC  ' }, ['Alpha imported']],
      [{ description: '100%' }, ['Alpha imported']],
      [{ description: '100_' }, []],
      [{ types: '["smart"]' }, ['Quiet echo']],
      [{ savedView: 'present' }, ['Quiet echo']],
      [{ savedView: 'absent', name: 'echo' }, ['Legacy echo']],
      [{ savedViewText: 'TITLE' }, ['Quiet echo']],
      [{ savedView: 'absent', savedViewText: 'title' }, []],
      [{ schedules: '["weekly","daily"]' }, ['Alpha imported', 'Delta liked']],
      [{ schedules: '["off"]' }, []],
      [
        { libraryScope: 'outside', sources: '["spotify"]' },
        ['Outside Spotify'],
      ],
      [{ libraryScope: 'outside', sources: '["library"]' }, []],
    ]
    for (const [filters, matches] of cases) {
      const result = await directory({ library: 'albums', ...filters })
      expect(names(result.items), JSON.stringify(filters)).toEqual(matches)
      expect(result.count, JSON.stringify(filters)).toBe(matches.length)
    }
  })

  it('uses the numbers and calendar days shown in imported and library rows', async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ tracks: { min: 3, max: 3 } }, ['Alpha imported']],
      [{ linkedTracks: { min: 3 } }, ['Alpha imported']],
      [{ linkedTracks: { max: 0 } }, []],
      [{ albums: { min: 3 } }, ['Alpha imported']],
      [{ duration: { min: 7.5, max: 8 } }, ['Alpha imported']],
      [
        { imported: { min: '2025-03-01', max: '2025-03-01' } },
        ['Alpha imported'],
      ],
      [{ updated: { max: '2025-01-01' } }, ['Delta liked']],
      [{ added: { min: '2025-02-01', max: '2025-02-01' } }, ['Alpha imported']],
      [
        { checked: { min: '2025-03-01', max: '2025-03-01' } },
        ['Alpha imported'],
      ],
      [{ checked: { max: '2025-01-01' } }, ['Delta liked']],
      [
        { nextSync: { min: '2025-03-02', max: '2025-03-02' } },
        ['Alpha imported'],
      ],
      [{ nextSync: { max: '2025-01-31' } }, []],
    ]
    for (const [ranges, matches] of cases) {
      const result = await directory({
        library: 'albums',
        columnRanges: JSON.stringify(ranges),
      })
      expect(names(result.items), JSON.stringify(ranges)).toEqual(matches)
      expect(result.count, JSON.stringify(ranges)).toBe(matches.length)
    }
    const local = await directory({
      library: 'albums',
      timeZone: 'Australia/Hobart',
      columnRanges: JSON.stringify({
        checked: { min: '2025-03-02', max: '2025-03-02' },
        nextSync: { min: '2025-03-03', max: '2025-03-03' },
      }),
    })
    expect(names(local.items)).toEqual(['Alpha imported'])
    expect(local.count).toBe(1)
    const outside = await directory({
      library: 'albums',
      libraryScope: 'outside',
      columnRanges: { added: { min: '2025-01-01' } },
    })
    expect(outside).toEqual({ items: [], hasMore: false, count: 0 })
  })

  it('filters by live smart counts and stored counts before paging', async () => {
    const query = {
      library: 'albums',
      sortBy: 'count',
      direction: 'asc',
      columnRanges: { count: { min: 2, max: 3 } },
      size: 1,
    }
    for (const [page, name, itemCount] of [
      [1, 'Legacy echo', 2],
      [2, 'Quiet echo', 2],
      [3, 'Alpha imported', 3],
    ] as const) {
      const result = await directory({ ...query, page })
      expect(result.items).toMatchObject([{ name, itemCount }])
      expect(result.count).toBe(3)
      expect(result.hasMore).toBe(page < 3)
    }
    for (const [library, name, itemCount] of [
      ['tracks', 'Charlie smart', 0],
      ['films', 'Film smart', 2],
      ['subscriptions', 'Videos smart', 0],
      ['mixes', 'Mixes smart', 0],
    ] as const) {
      const result = await directory({
        library,
        types: '["smart"]',
        columnRanges: { count: { min: itemCount, max: itemCount } },
      })
      expect(result.items).toMatchObject([{ name, itemCount }])
      expect(result.count).toBe(1)
    }
    expect(
      (
        await directory({
          library: 'albums',
          columnRanges: { tracks: { max: 0 } },
        })
      ).items,
    ).toMatchObject([
      { name: 'Album list' },
      { name: 'Quiet echo', itemCount: null },
    ])
  })

  it('does not evaluate smart views for a Playlist-only count filter', async () => {
    const { countPlaylists } = await import('@/services/playlist-directory')
    logQuery.mockClear()
    const count = await countPlaylists(
      PlaylistBrowseQuerySchema.parse({
        library: 'films',
        types: ['playlist'],
        columnRanges: { count: { min: 2 } },
      }),
    )
    expect(count.totalCount).toBe(1)
    expect(logQuery).toHaveBeenCalledTimes(1)
  })

  it('reflects library changes in a previously read smart count range', async () => {
    const filters = {
      library: 'films',
      types: ['smart'],
      columnRanges: { count: { min: 2 } },
    }
    expect((await directory(filters)).count).toBe(1)
    try {
      await pool.query(
        "update media_item set title = 'Changed title' where id = 'film-1'",
      )
      expect(await directory(filters)).toEqual({
        items: [],
        hasMore: false,
        count: 0,
      })
      const selected = await directory({
        ...filters,
        columnRanges: { count: { min: 1, max: 1 } },
      })
      expect(selected.items).toMatchObject([
        { name: 'Film smart', itemCount: 1 },
      ])
    } finally {
      await pool.query(
        "update media_item set title = 'Synthetic film 1' where id = 'film-1'",
      )
    }
  })

  it('sorts the combined list on the server, library rows last for imported fields', async () => {
    const library = ['Beta', 'Charlie smart', 'echo night']
    for (const sortBy of PlaylistBrowseSortSchema.options)
      for (const direction of ['asc', 'desc'] as const) {
        const label = `${sortBy} ${direction}`
        const result = await directory({ library: 'tracks', sortBy, direction })
        expect(result.count, label).toBe(6)
        expect([...names(result.items)].sort(byName), label).toEqual(
          [...listed.tracks].sort(byName),
        )
        // Every imported row has these values; library rows have none.
        if (['tracks', 'linkedTracks', 'albums', 'duration'].includes(sortBy))
          expect(names(result.items).slice(3).sort(byName), label).toEqual(
            library,
          )
      }
    const sorted = async (sortBy: string, direction: string) =>
      names((await directory({ library: 'tracks', sortBy, direction })).items)
    expect(await sorted('type', 'asc')).toEqual([
      'Alpha imported',
      'Beta',
      'Delta liked',
      'echo night',
      'Legacy echo',
      'Charlie smart',
    ])
    expect((await sorted('type', 'desc'))[0]).toBe('Charlie smart')
    // Entries and imported tracks; a smart playlist's count is last.
    expect(await sorted('count', 'desc')).toEqual([
      'Beta',
      'Alpha imported',
      'Legacy echo',
      'Delta liked',
      'echo night',
      'Charlie smart',
    ])
    expect(await sorted('source', 'desc')).toEqual([
      'Alpha imported',
      'Delta liked',
      'Beta',
      'Charlie smart',
      'echo night',
      'Legacy echo',
    ])
    // Library rows were updated now; Legacy echo was never imported.
    const updated = await sorted('updated', 'desc')
    expect(updated.slice(0, 3).sort(byName)).toEqual(library)
    expect(updated.slice(3)).toEqual([
      'Alpha imported',
      'Delta liked',
      'Legacy echo',
    ])
  })

  it('pages stably across both kinds', async () => {
    for (const [sortBy, direction] of [
      ['name', 'asc'],
      ['type', 'desc'],
      ['count', 'desc'],
      ['owner', 'asc'],
    ] as const) {
      const all = names(
        (await directory({ library: 'tracks', sortBy, direction })).items,
      )
      const pages: string[] = []
      for (let page = 1; page <= 3; page += 1) {
        const result = await directory({
          library: 'tracks',
          sortBy,
          direction,
          page,
          size: 2,
        })
        pages.push(...names(result.items))
        expect(result.hasMore, `${sortBy} page ${page}`).toBe(page < 3)
        expect(result.count).toBe(6)
      }
      expect(pages, sortBy).toEqual(all)
    }
  })

  it('searches the displayed Saved view sentence before paging and counting', async () => {
    await pool.query(`
      insert into library_playlist (id, library, type, name, deleted_at) values
        ('view-reference-live', 'albums', 'playlist', 'Evening albums', null),
        ('view-reference-deleted', 'albums', 'playlist', 'Deleted fixture', now());
      insert into library_playlist_entry (id, playlist_id, position, media_item_id, batch_id)
        values ('view-reference-item', 'view-reference-live', 1, 'album-1', 'fixture');
      insert into library_playlist (id, library, type, name, view)
        select 'earlier-candidate-' || n, 'albums', 'smart', 'Batch fixture ' || n,
          '{"sortBy":"title","direction":"asc"}'
        from generate_series(1, 200) n;
      insert into library_playlist (id, library, type, name, view)
      select id, 'albums', 'smart', name,
        jsonb_build_object('sortBy', 'dateAdded', 'direction', direction, 'filters',
          jsonb_build_array(jsonb_build_object(
            'field', 'libraryPlaylist', 'value', reference, 'mode', 'required'
          ))::text)
      from (values
        ('view-1', 'A later view', 'desc', 'view-reference-live'),
        ('view-2', 'M older view', 'asc', 'view-reference-live'),
        ('view-3', 'Z later view', 'desc', 'view-reference-live'),
        ('view-4', 'Y missing view', 'desc', 'view-reference-deleted')
      ) fixture(id, name, direction, reference);
    `)
    const cases: Array<[string, string[]]> = [
      [
        'added, NEWEST FIRST',
        ['A later view', 'Y missing view', 'Z later view'],
      ],
      ['oldest first', ['M older view']],
      ['evening albums', ['A later view', 'M older view', 'Z later view']],
      ['In playlist: removed · Added, newest first', ['Y missing view']],
      ['Deleted fixture', []],
      ['view-reference-live', []],
    ]
    for (const [savedViewText, expected] of cases) {
      const response = await directory({ library: 'albums', savedViewText })
      expect(names(response.items), savedViewText).toEqual(expected)
      expect(response.count, savedViewText).toBe(expected.length)
    }

    const query = {
      library: 'albums',
      savedViewText: 'In playlist: Evening albums · Added, newest first',
      columnRanges: { count: { min: 1, max: 1 } },
      size: 1,
    }
    const first = await directory(query)
    expect(first.items).toMatchObject([{ name: 'A later view', itemCount: 1 }])
    expect(first).toMatchObject({ count: 2, hasMore: true })
    const second = await directory({ ...query, page: 2 })
    expect(second.items).toMatchObject([{ name: 'Z later view', itemCount: 1 }])
    expect(second).toMatchObject({ count: 2, hasMore: false })
  })

  it('searches Track view dates and keys in the displayed formats', async () => {
    const view = {
      filters: JSON.stringify([{ field: 'musicalKey', value: '8A' }]),
      ranges: JSON.stringify([
        {
          field: 'dateAdded',
          min: Date.parse('2025-03-01T23:59:59Z'),
          includeMissing: false,
        },
      ]),
    }
    await pool.query(
      `
      insert into library_playlist (id, library, type, name, view)
      values ('view-track-format', 'tracks', 'smart', 'Formatted view', $1)
    `,
      [JSON.stringify(view)],
    )
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ savedViewText: '8A', keyNotation: 'camelot' }, 1],
      [{ savedViewText: '8A', keyNotation: 'musical' }, 0],
      [{ savedViewText: 'Am', keyNotation: 'musical' }, 1],
      [{ savedViewText: '2025-03-01', timeZone: 'UTC' }, 1],
      [{ savedViewText: '2025-03-02', timeZone: 'Australia/Hobart' }, 1],
      [{ savedViewText: '2025-03-01', timeZone: 'Australia/Hobart' }, 0],
    ]
    for (const [filters, count] of cases) {
      const result = await directory({ library: 'tracks', ...filters })
      expect(result.count, JSON.stringify(filters)).toBe(count)
      expect(names(result.items), JSON.stringify(filters)).toEqual(
        count ? ['Formatted view'] : [],
      )
    }
  })
})
