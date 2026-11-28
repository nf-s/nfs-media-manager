import { afterEach, describe, expect, it } from 'vitest'
import {
  albumBrowseFields,
  filmBrowseFields,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  type BrowseFilter,
  type LibraryPlaylistView,
} from '@repo/schemas/browse'
import {
  LibraryPlaylistListQuerySchema,
  LibraryPlaylistSummarySchema,
} from '@repo/schemas/library-playlists'
import { devicePayloadSchemas } from '@repo/schemas/device'
import { AlbumListeningHistogramQuerySchema } from '@repo/schemas/media'
import { describeSavedView } from '@repo/schemas/saved-view-sentence'
import {
  PlaylistBrowseQuerySchema,
  PlaylistSummarySchema,
  TrackListeningHistogramQuerySchema,
} from '@repo/schemas/tracks'
import { applyRows } from '../src/apply'
import { localDates } from '../src/compile/local-date'
import {
  openDeviceStore,
  positionsQuery,
  reason,
  served,
  trackQuery,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import { live, playlistPayload, tombstone, trackRow } from './fixtures'
import {
  libraryPlaylist,
  microseconds,
  playlist,
  playlistJob,
  type PlaylistRowPatch,
} from './library-fixtures'
import {
  albumQuery,
  albumRow,
  fieldsRow,
  filmQuery,
  filmRow,
  sorted,
} from './media-fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

let store: DeviceStore | undefined

async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore(
    [
      fieldsRow('album', albumBrowseFields),
      fieldsRow('film', filmBrowseFields),
      ...rows,
    ],
    options,
  )
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const track = (id: string): StoreRow => ({
  entity: 'track',
  id,
  payload: trackRow(id),
})
const album = (id: string) => albumRow(id)
const film = (id: string) => filmRow(id)

const filterJson = (filters: BrowseFilter[]) => JSON.stringify(filters)
const titleView = (title: string): LibraryPlaylistView => ({
  filters: filterJson([{ field: 'title', value: title }]),
})

describe('the libraryPlaylist Browse filter (PL-18)', () => {
  const rows = () => [
    track('t1'),
    track('t2'),
    track('t3'),
    album('a1'),
    album('a2'),
    film('f1'),
    film('f2'),
    // Entries listed twice and of an item outside the library.
    libraryPlaylist('lp-t', 'Late shift', {
      entries: ['t3', 't1', 't3', 'outside-1'],
    }),
    libraryPlaylist('lp-a', 'Albums list', {
      library: 'albums',
      entries: ['a2'],
    }),
    libraryPlaylist('lp-f', 'Films list', {
      library: 'films',
      entries: ['f1'],
    }),
    // Another library's playlist holding a track ID, and a smart playlist.
    libraryPlaylist('lp-other', 'Other library', {
      library: 'albums',
      entries: ['t2'],
    }),
    libraryPlaylist('lp-smart', 'Smart', { view: titleView('Track t2') }),
  ]
  const modes = [undefined, 'any', 'required', 'exclude'] as const
  const filter = (value: string, mode?: BrowseFilter['mode']) => [
    { field: LIBRARY_PLAYLIST_FILTER_FIELD, value, mode },
  ]
  const expected = (
    members: string[],
    all: string[],
    mode: BrowseFilter['mode'],
  ) =>
    mode === 'exclude' ? all.filter((id) => !members.includes(id)) : members

  it('reads Tracks pages, counts, lists, positions, recordings and histograms in every mode', async () => {
    const device = await open(rows())
    const all = ['t1', 't2', 't3']
    const cases = [
      { value: 'lp-t', members: ['t1', 't3'] },
      { value: 'lp-other', members: [] },
      { value: 'lp-smart', members: [] },
      { value: 'lp-unknown', members: [] },
    ]
    for (const { value, members } of cases)
      for (const mode of modes) {
        const label = `${value} ${mode ?? 'unset'}`
        const want = expected(members, all, mode)
        const filters = filter(value, mode)
        const query = trackQuery({ filters, size: 100 })
        const page = served(await device.source.trackPage(query))
        expect(sorted(page.items.map((item) => item.id)), label).toEqual(want)
        const grouped = served(
          await device.source.trackPage(
            trackQuery({ filters, groupRecordings: 'true', size: 100 }),
          ),
        )
        expect(grouped.items.length, label).toBe(want.length)
        expect(
          served(await device.source.trackCount(query)).totalCount,
          label,
        ).toBe(want.length)
        const list = served(await device.source.trackList(query))
        expect(sorted(list.items.map((item) => item.id)), label).toEqual(want)
        served(
          await device.source.trackPositions(
            positionsQuery({ filters, positions: '0,1' }),
          ),
        )
        served(await device.source.trackRecordings({ id: 't1', query }))
        const histogram = served(
          await device.source.trackHistogram(
            TrackListeningHistogramQuerySchema.parse({
              filters,
              period: JSON.stringify({ kind: 'all' }),
            }),
          ),
        )
        expect(
          histogram.counts.reduce((sum, count) => sum + count, 0),
          label,
        ).toBe(want.length)
      }
  })

  it('joins the any group across fields and ANDs a required filter beside another', async () => {
    const device = await open(rows())
    const ids = async (filters: BrowseFilter[]) =>
      sorted(
        served(
          await device.source.trackPage(trackQuery({ filters })),
        ).items.map((item) => item.id),
      )
    expect(
      await ids([
        { field: 'title', value: 'Track t2' },
        ...filter('lp-t', 'any'),
      ]),
    ).toEqual(['t1', 't2', 't3'])
    expect(
      await ids([
        { field: 'title', value: 'Track t1', mode: 'required' },
        ...filter('lp-t', 'required'),
      ]),
    ).toEqual(['t1'])
    expect(
      await ids([...filter('lp-t', 'required'), ...filter('lp-t', 'exclude')]),
    ).toEqual([])
  })

  it('reads Albums and Films in every mode', async () => {
    const device = await open(rows())
    for (const mode of modes) {
      const albums = expected(['a2'], ['a1', 'a2'], mode)
      const albumFilters = filter('lp-a', mode)
      const page = served(
        await device.source.albumPage(albumQuery({ filters: albumFilters })),
      )
      expect(sorted(page.items.map((item) => item.id)), mode).toEqual(albums)
      expect(
        served(
          await device.source.albumCount(albumQuery({ filters: albumFilters })),
        ).totalCount,
      ).toBe(albums.length)
      const list = served(
        await device.source.albumList(albumQuery({ filters: albumFilters })),
      )
      expect(sorted(list.items.map((item) => item.id))).toEqual(albums)
      const histogram = served(
        await device.source.albumHistogram(
          AlbumListeningHistogramQuerySchema.parse({
            filters: filterJson(albumFilters),
            period: JSON.stringify({ kind: 'all' }),
          }),
        ),
      )
      expect(histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(
        albums.length,
      )
      // A Tracks playlist on Albums is an empty set.
      expect(
        served(
          await device.source.albumCount(
            albumQuery({ filters: filter('lp-t', mode) }),
          ),
        ).totalCount,
      ).toBe(mode === 'exclude' ? 2 : 0)

      const films = expected(['f1'], ['f1', 'f2'], mode)
      const filmFilters = filter('lp-f', mode)
      const filmPage = served(
        await device.source.filmPage(filmQuery({ filters: filmFilters })),
      )
      expect(sorted(filmPage.items.map((item) => item.id)), mode).toEqual(films)
      expect(
        served(
          await device.source.filmCount(filmQuery({ filters: filmFilters })),
        ).totalCount,
      ).toBe(films.length)
      const filmList = served(
        await device.source.filmList(filmQuery({ filters: filmFilters })),
      )
      expect(sorted(filmList.items.map((item) => item.id))).toEqual(films)
    }
  })

  it('keeps the earlier reasons: a catalog scope, and an unknown field beside it', async () => {
    const device = await open(rows())
    expect(
      reason(
        await device.source.trackPage(
          trackQuery({ libraryScope: 'all', filters: filter('lp-t') }),
        ),
      ),
    ).toBe('catalog-scope')
    expect(
      reason(
        await device.source.albumPage(
          albumQuery({
            filters: [...filter('lp-a'), { field: 'nothing', value: 'x' }],
          }),
        ),
      ),
    ).toBe('invalid-query')
  })

  it('removes a playlist and its members with its tombstone, and replaces members with a newer row', async () => {
    const device = await open(rows())
    const count = async (value: string) =>
      served(
        await device.source.trackCount(trackQuery({ filters: filter(value) })),
      ).totalCount
    const members = async () =>
      (
        await device.driver.all(
          `SELECT m.item_id AS id FROM library_playlist_item m
           JOIN library_playlist p ON p.rid = m.rid WHERE p.id = 'lp-t'`,
        )
      ).map((row) => row.id)
    expect(await count('lp-t')).toBe(2)
    const newer = libraryPlaylist('lp-t', 'Late shift', { entries: ['t2'] })
    await device.driver.transaction((tx) =>
      applyRows(tx, [live(newer.entity, newer.id, 100, newer.payload)]),
    )
    expect(await members()).toEqual(['t2'])
    expect(await count('lp-t')).toBe(1)
    await device.driver.transaction((tx) =>
      applyRows(tx, [tombstone('library_playlist', 'lp-t', 101)]),
    )
    expect(await members()).toEqual([])
    expect(await count('lp-t')).toBe(0)
    const left = await device.driver.all(
      `SELECT count(*) AS n FROM library_playlist_item m
       WHERE m.rid NOT IN (SELECT rid FROM library_playlist)`,
    )
    expect(left).toEqual([{ n: 0 }])
    expect(
      served(
        await device.source.libraryPlaylistList(
          LibraryPlaylistListQuerySchema.parse({ library: 'tracks' }),
        ),
      ).items.map((item) => item.id),
    ).toEqual(['lp-smart'])
  })
})

describe('the library playlist list (PL-10)', () => {
  const rows = () => [
    libraryPlaylist('lp-1', 'Late shift', { entries: ['t1', 't1'] }),
    libraryPlaylist('lp-2', 'alpha', { view: titleView('x') }),
    libraryPlaylist('lp-3', 'Mid 100%', { entries: ['t2'] }),
    libraryPlaylist('lp-4', 'Bravo', { library: 'albums', entries: ['t1'] }),
  ]
  const list = async (device: DeviceStore, input: Record<string, unknown>) =>
    served(
      await device.source.libraryPlaylistList(
        LibraryPlaylistListQuerySchema.parse(input),
      ),
    )
  const ids = async (device: DeviceStore, input: Record<string, unknown>) =>
    (await list(device, input)).items.map((item) => item.id)

  it('lists one library by lower-cased name, with the stored summaries', async () => {
    const device = await open(rows())
    const page = await list(device, { library: 'tracks' })
    expect(page.items.map((item) => item.id)).toEqual(['lp-2', 'lp-1', 'lp-3'])
    expect(page.items[1]).toEqual(
      LibraryPlaylistSummarySchema.parse({
        id: 'lp-1',
        library: 'tracks',
        type: 'playlist',
        name: 'Late shift',
        entryCount: 2,
        view: null,
        updatedAt: '2024-05-02T09:30:00.000Z',
      }),
    )
    expect(page.items[1]).not.toHaveProperty('containsItem')
    expect(await ids(device, { library: 'albums' })).toEqual(['lp-4'])
    expect(await ids(device, { library: 'films' })).toEqual([])
  })

  it('filters by type and by q as one substring of the name', async () => {
    const device = await open(rows())
    expect(await ids(device, { library: 'tracks', type: 'smart' })).toEqual([
      'lp-2',
    ])
    expect(await ids(device, { library: 'tracks', type: 'playlist' })).toEqual([
      'lp-1',
      'lp-3',
    ])
    expect(await ids(device, { library: 'tracks', q: 'LATE' })).toEqual([
      'lp-1',
    ])
    expect(await ids(device, { library: 'tracks', q: 'late shift' })).toEqual([
      'lp-1',
    ])
    expect(await ids(device, { library: 'tracks', q: '0%' })).toEqual(['lp-3'])
    expect(await ids(device, { library: 'tracks', q: '_' })).toEqual([])
    expect(await ids(device, { library: 'tracks', q: '' })).toEqual([
      'lp-2',
      'lp-1',
      'lp-3',
    ])
  })

  it('pages with size + 1 rows', async () => {
    const device = await open(rows())
    const at = async (page: number) => {
      const result = await list(device, { library: 'tracks', size: 2, page })
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await at(1)).toEqual([['lp-2', 'lp-1'], true])
    expect(await at(2)).toEqual([['lp-3'], false])
    expect(await at(3)).toEqual([[], false])
  })

  it('says whether each playlist holds the item when itemId is given', async () => {
    const device = await open(rows())
    const contains = async (itemId: string) =>
      (await list(device, { library: 'tracks', itemId })).items.map((item) => [
        item.id,
        item.containsItem,
      ])
    expect(await contains('t1')).toEqual([
      ['lp-2', false],
      ['lp-1', true],
      ['lp-3', false],
    ])
    expect(await contains('t2')).toEqual([
      ['lp-2', false],
      ['lp-1', false],
      ['lp-3', true],
    ])
  })

  it('answers not-ready before the first fill and nul-text first', async () => {
    const device = await open(rows(), { ready: false })
    expect(
      reason(
        await device.source.libraryPlaylistList(
          LibraryPlaylistListQuerySchema.parse({ library: 'tracks' }),
        ),
      ),
    ).toBe('not-ready')
    expect(
      reason(
        await device.source.libraryPlaylistList(
          LibraryPlaylistListQuerySchema.parse({
            library: 'tracks',
            q: 'a\u0000',
          }),
        ),
      ),
    ).toBe('nul-text')
  })
})

// The Playlists directory

/** An imported playlist in its own sync group, `spotify:<id>`. */
function own(id: string, name: string, patch: PlaylistRowPatch = {}) {
  return playlist(id, name, {
    ...patch,
    extra: { syncGroupKey: `spotify:${id}`, ...patch.extra },
  })
}

const playlistQuery = (input: Record<string, unknown> = {}) =>
  PlaylistBrowseQuerySchema.parse(input)

async function page(device: DeviceStore, input: Record<string, unknown> = {}) {
  return served(await device.source.playlistPage(playlistQuery(input)))
}

async function ids(device: DeviceStore, input: Record<string, unknown> = {}) {
  return (await page(device, input)).items.map((item) => item.id)
}

async function total(device: DeviceStore, input: Record<string, unknown> = {}) {
  return served(await device.source.playlistCount(playlistQuery(input)))
    .totalCount
}

/** The page's IDs, checked against the count of the same query. */
async function counted(
  device: DeviceStore,
  input: Record<string, unknown> = {},
) {
  const found = await ids(device, { size: 100, ...input })
  expect(await total(device, input), JSON.stringify(input)).toBe(found.length)
  return found
}

async function why(device: DeviceStore, input: Record<string, unknown>) {
  const query = playlistQuery(input)
  const pageReason = reason(await device.source.playlistPage(query))
  expect(reason(await device.source.playlistCount(query))).toBe(pageReason)
  return pageReason
}

describe('the directory with library (PL-17)', () => {
  const base = playlistPayload('p').item
  const rows = () => [
    own('p-alpha', 'Alpha', { num: { tracks: 5, albums: 1 } }),
    // No source, with a Spotify URL: Spotify in the directory.
    own('p-echo', 'Echo', {
      item: { source: null, spotifyUrl: 'https://open.spotify.com/x' },
      extra: { source: 'library', syncGroupKey: null },
      sort: { source: 1, schedule: null },
      num: {
        tracks: 2,
        albums: 4,
        imported: microseconds('2024-04-01T00:00:00Z'),
      },
    }),
    libraryPlaylist('lp-bravo', 'Bravo', {
      entries: ['t1', 't2', 't3'],
      updatedAt: '2024-05-10T00:00:00.000Z',
      createdAt: '2024-01-10T00:00:00.000Z',
    }),
    libraryPlaylist('lp-delta', 'delta', {
      view: titleView('Track t1'),
      updatedAt: '2024-05-20T00:00:00.000Z',
      createdAt: '2024-01-20T00:00:00.000Z',
    }),
    libraryPlaylist('lp-film', 'Charlie', { library: 'films', entries: [] }),
    libraryPlaylist('lp-album', 'Album list', {
      library: 'albums',
      entries: ['a1'],
    }),
  ]

  it('lists imported playlists beside the library’s own in Tracks and Albums, and only its own elsewhere', async () => {
    const device = await open(rows())
    expect(await counted(device, { library: 'tracks' })).toEqual([
      'p-alpha',
      'lp-bravo',
      'lp-delta',
      'p-echo',
    ])
    expect(await counted(device, { library: 'albums' })).toEqual([
      'lp-album',
      'p-alpha',
      'p-echo',
    ])
    expect(await counted(device, { library: 'films' })).toEqual(['lp-film'])
    expect(await counted(device, { library: 'subscriptions' })).toEqual([])
    expect(await counted(device)).toEqual(['p-alpha', 'p-echo'])
  })

  it('returns imported rows as imported, counted in the library’s noun, and library rows as stored', async () => {
    const device = await open(rows())
    const tracks = (await page(device, { library: 'tracks' })).items
    const alpha = PlaylistSummarySchema.parse({
      ...base,
      id: 'p-alpha',
      name: 'Alpha',
      sync: { ...base.sync, job: null },
    })
    expect(tracks[0]).toEqual({
      ...alpha,
      origin: 'imported',
      type: 'playlist',
      library: null,
      view: null,
      updatedAt: alpha.importedAt,
      itemCount: alpha.trackCount,
    })
    const bravo = devicePayloadSchemas.library_playlist.parse(
      libraryPlaylist('lp-bravo', 'Bravo', {
        entries: ['t1', 't2', 't3'],
        updatedAt: '2024-05-10T00:00:00.000Z',
        createdAt: '2024-01-10T00:00:00.000Z',
      }).payload,
    )
    expect(tracks[1]).toEqual(bravo.item)
    expect(tracks[1]?.itemCount).toBe(3)
    expect(tracks[2]?.itemCount).toBeNull()
    const albums = (await page(device, { library: 'albums' })).items
    expect(albums[1]?.itemCount).toBe(alpha.albumCount)
  })

  it('sorts both origins together, nulls last, then by name and ID', async () => {
    const device = await open(rows())
    const sortedBy = (sortBy: string, direction = 'asc') =>
      counted(device, { library: 'tracks', sortBy, direction })
    // Playlist (imported and library playlists), then Smart playlist.
    expect(await sortedBy('type')).toEqual([
      'p-alpha',
      'lp-bravo',
      'p-echo',
      'lp-delta',
    ])
    expect(await sortedBy('type', 'desc')).toEqual([
      'lp-delta',
      'p-alpha',
      'lp-bravo',
      'p-echo',
    ])
    // Tracks of an imported playlist, entries of a playlist; a smart one has none.
    expect(await sortedBy('count')).toEqual([
      'p-echo',
      'lp-bravo',
      'p-alpha',
      'lp-delta',
    ])
    expect(await sortedBy('count', 'desc')).toEqual([
      'p-alpha',
      'lp-bravo',
      'p-echo',
      'lp-delta',
    ])
    // Library, then Spotify: Echo has a Spotify URL and no source.
    expect(await sortedBy('source')).toEqual([
      'lp-bravo',
      'lp-delta',
      'p-alpha',
      'p-echo',
    ])
    expect(await sortedBy('updated')).toEqual([
      'p-echo',
      'p-alpha',
      'lp-bravo',
      'lp-delta',
    ])
    expect(await sortedBy('added', 'desc')).toEqual([
      'p-alpha',
      'p-echo',
      'lp-delta',
      'lp-bravo',
    ])
    // An imported-playlist field puts library rows last in both directions.
    expect(await sortedBy('tracks', 'desc')).toEqual([
      'p-alpha',
      'p-echo',
      'lp-bravo',
      'lp-delta',
    ])
    expect(await sortedBy('name', 'desc')).toEqual([
      'p-echo',
      'lp-delta',
      'lp-bravo',
      'p-alpha',
    ])
    // Albums count albums.
    expect(
      await counted(device, { library: 'albums', sortBy: 'count' }),
    ).toEqual(['lp-album', 'p-alpha', 'p-echo'])
  })

  it('pages the combined list', async () => {
    const device = await open(rows())
    const at = async (pageNumber: number) => {
      const result = await page(device, {
        library: 'tracks',
        size: 3,
        page: pageNumber,
      })
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await at(1)).toEqual([['p-alpha', 'lp-bravo', 'lp-delta'], true])
    expect(await at(2)).toEqual([['p-echo'], false])
  })

  it('searches library rows by name only, and filters sources by the directory source', async () => {
    const device = await open([
      ...rows(),
      own('p-owner', 'Zulu', { search: { owner: ['Bravo fan'] } }),
    ])
    expect(await counted(device, { library: 'tracks', q: 'BRAVO' })).toEqual([
      'lp-bravo',
      'p-owner',
    ])
    expect(await counted(device, { library: 'tracks', name: 'bravo' })).toEqual(
      ['lp-bravo'],
    )
    expect(
      await counted(device, { library: 'tracks', sources: ['library'] }),
    ).toEqual(['lp-bravo', 'lp-delta'])
    expect(
      await counted(device, { library: 'tracks', sources: ['spotify'] }),
    ).toEqual(['p-alpha', 'p-echo', 'p-owner'])
    // Without library, Echo's source is Library.
    expect(await counted(device, { sources: ['library'] })).toEqual(['p-echo'])
    expect(
      await counted(device, { library: 'tracks', ids: ['lp-delta', 'p-echo'] }),
    ).toEqual(['lp-delta', 'p-echo'])
    expect(
      await counted(device, { library: 'tracks', acceptsAdditions: 'true' }),
    ).toEqual([])
    expect(
      await counted(device, { library: 'tracks', acceptsAdditions: 'false' }),
    ).toHaveLength(5)
  })
})

describe('the directory column filters, with and without library', () => {
  const rows = () => [
    own('p-a', 'Alpha', {
      search: { owner: ['Example Owner'], description: ['Slow starts'] },
      sort: { schedule: 4 },
      num: { tracks: 0, linkedTracks: 0, albums: 1, duration: 89 },
    }),
    own('p-b', 'Beta', {
      search: { owner: [], description: [] },
      // An unknown schedule is sorted, and filtered, as Off.
      sort: { schedule: 5 },
      num: { tracks: 3, linkedTracks: 2, albums: 0, duration: 90 },
    }),
    own('p-c', 'Gamma', {
      search: { owner: [], description: [] },
      extra: { syncGroupKey: null },
      sort: { schedule: null },
      num: { tracks: 7, linkedTracks: 7, albums: 2, duration: 30 },
    }),
    libraryPlaylist('lp-1', 'Delta', { entries: ['t1', 't2'] }),
    libraryPlaylist('lp-2', 'Epsilon', { view: titleView('Track t1') }),
  ]

  it('applies owner, description and schedules to imported rows and excludes library rows', async () => {
    const device = await open(rows())
    for (const library of [undefined, 'tracks']) {
      const read = (input: Record<string, unknown>) =>
        counted(device, { library, ...input })
      expect(await read({ owner: 'example' })).toEqual(['p-a'])
      expect(await read({ description: 'SLOW' })).toEqual(['p-a'])
      expect(await read({ owner: '' })).toHaveLength(library ? 5 : 3)
      expect(await read({ schedules: ['1h'] })).toEqual(['p-a'])
      expect(await read({ schedules: ['off', 'daily'] })).toEqual(['p-b'])
    }
  })

  it('reads savedView, types and saved view text without library as the service does', async () => {
    const device = await open(rows())
    expect(await counted(device, { savedView: 'present' })).toEqual([])
    expect(await counted(device, { savedView: 'absent' })).toHaveLength(3)
    expect(await counted(device, { savedViewText: 'track' })).toEqual([])
    expect(await counted(device, { savedViewText: '' })).toHaveLength(3)
    expect(await counted(device, { types: ['smart'] })).toEqual([])
    expect(await counted(device, { types: [] })).toHaveLength(3)
    expect(await counted(device, { types: ['playlist'] })).toHaveLength(3)
    expect(await counted(device, { keyNotation: 'camelot' })).toHaveLength(3)
    expect(await counted(device, { timeZone: 'EST' })).toHaveLength(3)
  })

  it('reads savedView and types with library', async () => {
    const device = await open(rows())
    const read = (input: Record<string, unknown>) =>
      counted(device, { library: 'tracks', ...input })
    expect(await read({ savedView: 'present' })).toEqual(['lp-2'])
    expect(await read({ savedView: 'absent' })).toEqual([
      'p-a',
      'p-b',
      'lp-1',
      'p-c',
    ])
    expect(await read({ types: ['smart'] })).toEqual(['lp-2'])
    expect(await read({ types: ['playlist'] })).toEqual([
      'p-a',
      'p-b',
      'lp-1',
      'p-c',
    ])
  })

  it('compares number ranges as the service does, library rows as constants', async () => {
    const device = await open(rows())
    const ranges = (columnRanges: object, library?: string) =>
      counted(device, { library, columnRanges: JSON.stringify(columnRanges) })
    expect(await ranges({ tracks: { min: 3 } })).toEqual(['p-b', 'p-c'])
    expect(await ranges({ tracks: { max: 0 } }, 'tracks')).toEqual([
      'p-a',
      'lp-1',
      'lp-2',
    ])
    // Linked tracks are missing when a playlist has no tracks, and for library rows.
    expect(await ranges({ linkedTracks: { max: 7 } }, 'tracks')).toEqual([
      'p-b',
      'p-c',
    ])
    expect(await ranges({ albums: { min: 0, max: 0 } }, 'tracks')).toEqual([
      'p-b',
      'lp-1',
      'lp-2',
    ])
    // round(seconds / 60): 89 s is 1 minute, 90 s is 2, 30 s is 1.
    expect(await ranges({ duration: { min: 1.5 } })).toEqual(['p-b'])
    expect(await ranges({ duration: { max: 1 } })).toEqual(['p-a', 'p-c'])
    // Count: none without library; tracks in Tracks; entries of a playlist.
    expect(await ranges({ count: { min: 0 } })).toEqual([])
    expect(await ranges({ count: { min: 2, max: 3 } }, 'tracks')).toEqual([
      'p-b',
      'lp-1',
    ])
    expect(await ranges({})).toHaveLength(3)
    expect(await ranges({ tracks: {} }, 'tracks')).toHaveLength(5)
  })
})

describe('the directory date ranges', () => {
  const at = (iso: string) => ({
    updatedAt: iso,
    createdAt: '2024-01-01T12:00:00.000Z',
  })
  const rows = () => [
    // America/Havana moves from 00:00 to 01:00 on 2024-03-10.
    libraryPlaylist('lp-a', 'A', at('2024-03-10T04:59:59.999Z')),
    libraryPlaylist('lp-b', 'B', at('2024-03-10T05:00:00.000Z')),
    libraryPlaylist('lp-c', 'C', at('2024-03-11T03:59:59.999Z')),
    libraryPlaylist('lp-d', 'D', at('2024-03-11T04:00:00.000Z')),
    // The last microsecond of a UTC day.
    libraryPlaylist('lp-e', 'E', at('2024-03-09T23:59:59.999Z')),
    own('p-1', 'Imported', {
      num: { imported: microseconds('2024-03-10T00:00:00.000Z') + 1 },
      sort: { nextSync: microseconds('2024-03-10T12:00:00.000Z') },
    }),
    own('p-2', 'Failed', {
      num: { imported: microseconds('2024-03-09T23:59:59.999Z') + 999 },
      sort: { nextSync: microseconds('2024-03-10T12:00:00.000Z') },
    }),
    playlistJob('spotify:p-2', 'failed'),
  ]
  const day = { min: '2024-03-10', max: '2024-03-10' }
  const read = (
    device: DeviceStore,
    columnRanges: object,
    timeZone?: string,
    library: string | undefined = 'tracks',
  ) =>
    counted(device, {
      library,
      timeZone,
      columnRanges: JSON.stringify(columnRanges),
    })

  it('compares the UTC calendar date by default and in UTC', async () => {
    const device = await open(rows())
    for (const zone of [undefined, 'UTC']) {
      expect(await read(device, { updated: day }, zone)).toEqual([
        'lp-a',
        'lp-b',
        'p-1',
      ])
      expect(
        await read(device, { updated: { max: '2024-03-09' } }, zone),
      ).toEqual(['lp-e', 'p-2'])
    }
  })

  it('compares the local date in a zone whose clocks change at midnight', async () => {
    const device = await open(rows())
    expect(await read(device, { updated: day }, 'America/Havana')).toEqual([
      'lp-b',
      'lp-c',
    ])
    expect(
      await read(device, { updated: { min: '2024-03-11' } }, 'America/Havana'),
    ).toEqual(['lp-d'])
    expect(
      await read(device, { imported: day }, 'America/Havana', undefined),
    ).toEqual([])
    expect(
      await read(device, { imported: { max: '2024-03-09' } }, 'America/Havana'),
    ).toEqual(['p-2', 'p-1'])
  })

  it('reads the next sync of a group whose job failed as missing, and library rows as missing for imported dates', async () => {
    const device = await open(rows())
    expect(await read(device, { nextSync: day })).toEqual(['p-1'])
    expect(await read(device, { checked: { min: '2000-01-01' } })).toEqual([
      'p-2',
      'p-1',
    ])
    expect(await read(device, { added: { max: '2024-01-01' } })).toEqual([
      'lp-a',
      'lp-b',
      'lp-c',
      'lp-d',
      'lp-e',
    ])
  })

  it('leaves a date range in a zone PostgreSQL may read differently to the API', async () => {
    const device = await open(rows())
    for (const timeZone of ['EST', 'Etc/GMT+3', 'GMT', 'EST5EDT'])
      for (const library of [undefined, 'tracks']) {
        const columnRanges = JSON.stringify({ updated: day })
        expect(await why(device, { library, timeZone, columnRanges })).toBe(
          'time-zone',
        )
        // Without a date range the zone is not read.
        expect(
          await why(device, {
            library,
            timeZone,
            columnRanges: JSON.stringify({ tracks: { min: 0 } }),
          }),
        ).toBeNull()
      }
  })

  it('computes local dates per instant', () => {
    const beirut = localDates('Asia/Beirut')
    // Beirut moves from 00:00 to 01:00 on 2024-03-31.
    expect(beirut(microseconds('2024-03-30T21:59:59.999Z'))).toBe(20240330)
    expect(beirut(microseconds('2024-03-30T22:00:00.000Z'))).toBe(20240331)
    expect(localDates(undefined)(microseconds('1969-12-31T23:59:59Z'))).toBe(
      19691231,
    )
  })
})

describe('the directory smart playlist rules', () => {
  const tracks = () => [track('t1'), track('t2'), track('t3')]
  const rows = () => [
    ...tracks(),
    libraryPlaylist('lp-list', 'List', { entries: ['t1', 't2'] }),
    libraryPlaylist('lp-one', 'One', { view: titleView('Track t1') }),
    libraryPlaylist('lp-all', 'All', {
      view: { sortBy: 'title', direction: 'asc' },
    }),
    // A view that does not parse has no count.
    libraryPlaylist('lp-broken', 'Broken', { view: { nonsense: 'x' } }),
  ]
  const countRange = (min: number, max?: number) =>
    JSON.stringify({ count: { min, max } })

  it('counts smart playlists live for a count range, and in the count sort under one', async () => {
    const device = await open(rows())
    const read = (input: Record<string, unknown>) =>
      counted(device, { library: 'tracks', ...input })
    expect(await read({ columnRanges: countRange(1, 1) })).toEqual(['lp-one'])
    expect(await read({ columnRanges: countRange(2) })).toEqual([
      'lp-all',
      'lp-list',
    ])
    const items = (
      await page(device, {
        library: 'tracks',
        columnRanges: countRange(0),
        sortBy: 'count',
        direction: 'desc',
      })
    ).items
    expect(items.map((item) => [item.id, item.itemCount])).toEqual([
      ['lp-all', 3],
      ['lp-list', 2],
      ['lp-one', 1],
    ])
    // Without a count range, smart rows have no count and sort last.
    expect(
      (await page(device, { library: 'tracks', sortBy: 'count' })).items.map(
        (item) => [item.id, item.itemCount],
      ),
    ).toEqual([
      ['lp-list', 2],
      ['lp-all', null],
      ['lp-broken', null],
      ['lp-one', null],
    ])
    expect(
      await read({ columnRanges: countRange(0), types: ['playlist'] }),
    ).toEqual(['lp-list'])
  })

  it('falls through with smart-count when a smart playlist of the library cannot be counted', async () => {
    const device = await open([
      ...rows(),
      libraryPlaylist('lp-odd', 'Odd', {
        view: { filters: filterJson([{ field: 'nothing', value: 'x' }]) },
      }),
      libraryPlaylist('lp-sub', 'Subs', {
        library: 'subscriptions',
        view: { q: 'news' },
      }),
    ])
    expect(
      await why(device, { library: 'tracks', columnRanges: countRange(1) }),
    ).toBe('smart-count')
    expect(
      await why(device, {
        library: 'subscriptions',
        columnRanges: countRange(1),
      }),
    ).toBe('smart-count')
    // Not without a count range, nor when the types leave smart rows out.
    expect(await why(device, { library: 'tracks' })).toBeNull()
    expect(
      await why(device, {
        library: 'tracks',
        columnRanges: countRange(1),
        types: ['playlist'],
      }),
    ).toBeNull()
    expect(await why(device, { columnRanges: countRange(1) })).toBeNull()
  })

  it('passes not-ready from a count read through as itself', async () => {
    const device = await openDeviceStore(
      [
        libraryPlaylist('lp-a', 'Albums', {
          library: 'albums',
          view: { sortBy: 'title' },
        }),
      ],
      { trackFields: null },
    )
    store = device
    expect(
      await why(device, { library: 'albums', columnRanges: countRange(0) }),
    ).toBe('not-ready')
    expect(await why(device, { library: 'albums' })).toBeNull()
  })

  it('matches saved view text against each smart playlist’s sentence', async () => {
    const views: Record<string, LibraryPlaylistView> = {
      'lp-tag': { filters: filterJson([{ field: 'genre', value: 'jazz' }]) },
      'lp-in': {
        filters: filterJson([
          { field: LIBRARY_PLAYLIST_FILTER_FIELD, value: 'lp-list' },
        ]),
        sortBy: 'title',
        direction: 'asc',
      },
      'lp-key': { filters: filterJson([{ field: 'musicalKey', value: '8A' }]) },
      'lp-gone': {
        filters: filterJson([
          { field: LIBRARY_PLAYLIST_FILTER_FIELD, value: 'lp-deleted' },
        ]),
      },
    }
    const device = await open([
      ...tracks(),
      libraryPlaylist('lp-list', 'Late shift', { entries: ['t1'] }),
      // A playlist of another library still names the view's playlist.
      libraryPlaylist('lp-elsewhere', 'Elsewhere', {
        library: 'albums',
        view: views['lp-in'],
      }),
      ...Object.entries(views).map(([id, view]) =>
        libraryPlaylist(id, id, { view }),
      ),
    ])
    const read = (input: Record<string, unknown>) =>
      counted(device, { library: 'tracks', ...input })
    expect(await read({ savedViewText: 'TAG: JAZZ' })).toEqual(['lp-tag'])
    // The sentence's own punctuation is settled.
    expect(await read({ savedViewText: 'jazz · added' })).toEqual(['lp-tag'])
    expect(await read({ savedViewText: 'in playlist: late' })).toEqual([
      'lp-in',
    ])
    expect(await read({ savedViewText: 'in playlist: removed' })).toEqual([
      'lp-gone',
    ])
    // The default key notation, whatever the engine's state, or the query's.
    const keyText = (keyNotation: 'musical' | 'camelot') =>
      describeSavedView({
        library: 'tracks',
        view: views['lp-key'] ?? {},
        playlistName: () => null,
        timeZone: 'UTC',
        keyNotation,
      })
        .toLowerCase()
        .split(' · ')[0]
    expect(keyText('musical')).not.toBe(keyText('camelot'))
    expect(await read({ savedViewText: keyText('musical') })).toEqual([
      'lp-key',
    ])
    expect(
      await read({ savedViewText: keyText('camelot'), keyNotation: 'camelot' }),
    ).toEqual(['lp-key'])
    expect(await read({ savedViewText: keyText('camelot') })).toEqual([])
    // Only smart rows match; the type filter can leave them all out.
    expect(await read({ savedViewText: 'tag', types: ['playlist'] })).toEqual(
      [],
    )
    // With a count range, the matching views are counted.
    expect(
      (
        await page(device, {
          library: 'tracks',
          savedViewText: 'in playlist',
          columnRanges: countRange(0),
        })
      ).items.map((item) => [item.id, item.itemCount]),
    ).toEqual([
      ['lp-gone', 0],
      ['lp-in', 1],
    ])
  })

  it('leaves saved view text the fold cannot settle to the API', async () => {
    const device = await open([
      ...tracks(),
      libraryPlaylist('lp-plain', 'Plain', { view: titleView('Track t1') }),
    ])
    // A capital sigma in the needle.
    expect(await why(device, { library: 'tracks', savedViewText: 'Σ' })).toBe(
      'server-lower-case',
    )
    // Not when no smart row is read.
    expect(
      await why(device, {
        library: 'tracks',
        savedViewText: 'Σ',
        types: ['playlist'],
      }),
    ).toBeNull()
    expect(await why(device, { savedViewText: 'Σ' })).toBeNull()
    await device.close()
    const sigma = await open([
      ...tracks(),
      libraryPlaylist('lp-sigma', 'Sigma', { view: { q: 'ΣΑΣ' } }),
    ])
    expect(
      await why(sigma, { library: 'tracks', savedViewText: 'search' }),
    ).toBe('server-lower-case')
    // A smart row other filters leave out is not read.
    expect(
      await why(sigma, {
        library: 'tracks',
        savedViewText: 'search',
        q: 'nothing',
      }),
    ).toBeNull()
  })
})

describe('the directory order of reasons', () => {
  const rows = () => [
    track('t1'),
    own('p-busy', 'Busy'),
    playlistJob('spotify:p-busy', 'running'),
    libraryPlaylist('lp-odd', 'Odd', {
      view: { filters: filterJson([{ field: 'nothing', value: 'x' }]) },
    }),
    libraryPlaylist('lp-sigma', 'Sigma', { view: { q: 'Σ' } }),
  ]
  const dates = JSON.stringify({ updated: { min: '2024-01-01' } })
  const counts = JSON.stringify({ count: { min: 0 } })

  it('answers the first reason the read holds', async () => {
    const device = await open(rows())
    const all = {
      library: 'tracks',
      libraryScope: 'all',
      timeZone: 'EST',
      columnRanges: JSON.stringify({
        updated: { min: '2024-01-01' },
        count: { min: 0 },
      }),
      savedViewText: 'search',
    }
    expect(await why(device, { ...all, q: 'a\u0000' })).toBe('nul-text')
    expect(await why(device, all)).toBe('catalog-scope')
    const scoped = { ...all, libraryScope: undefined }
    expect(await why(device, scoped)).toBe('time-zone')
    expect(await why(device, { ...scoped, timeZone: 'UTC' })).toBe(
      'server-lower-case',
    )
    expect(
      await why(device, {
        library: 'tracks',
        columnRanges: counts,
        savedViewText: 'odd',
      }),
    ).toBe('server-lower-case')
    expect(await why(device, { library: 'tracks', columnRanges: counts })).toBe(
      'smart-count',
    )
    expect(
      reason(
        await device.source.playlistPage(
          playlistQuery({ library: 'tracks', columnRanges: dates }),
        ),
      ),
    ).toBe('active-import')
    expect(
      await total(device, { library: 'tracks', columnRanges: dates }),
    ).toBe(3)
  })

  it('answers not-ready before the query’s own reasons', async () => {
    const device = await open(rows(), { ready: false })
    expect(
      await why(device, {
        library: 'tracks',
        libraryScope: 'all',
        timeZone: 'EST',
        columnRanges: dates,
      }),
    ).toBe('not-ready')
  })
})
