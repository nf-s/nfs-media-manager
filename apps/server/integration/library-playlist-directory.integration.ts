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
const { database, pool } = createTrackPerformanceFixture()
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
  `)
  await pool.query(
    `insert into provider_snapshot (id, provider, checksum, payload, source)
    values ('views', 'legacy-smart-playlists', 'views', $1, 'legacy-import:smart-playlists.json')`,
    [
      JSON.stringify([
        { name: 'Quiet echo', filters: [], sort: ['title', 'ASC'] },
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
  subscriptions: ['Videos'],
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
})
