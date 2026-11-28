import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AlbumDetailSchema, AlbumListItemSchema } from '@repo/schemas/media'
import { SavedSourceSchema } from '@repo/schemas/playback'
import { TIDAL_SIMILAR_LIMIT } from '@repo/schemas/tidal'
import {
  PlaylistDetailSchema,
  TrackListItemSchema,
  type PlaylistEntry,
} from '@repo/schemas/tracks'
import {
  albumTrackView,
  createAlbumPlaybackSource,
  createBrowsePlaybackSource,
  createLibraryPlaylistPlaybackSource,
  createPendingTrackBrowseSource,
  createPlaylistPlaybackSource,
  createSimilarTracksPlaybackSource,
  restorePlaybackSource,
} from './playback-source'
import { libraryTrackPlayable } from './playback'
import { browsePageSize } from './virtual-browse'

const albumId = 'A'.repeat(22)
const firstTrackId = 'B'.repeat(22)
const secondTrackId = 'C'.repeat(22)
function albumTrack(
  position: number,
  title: string,
  spotifyTrackId: string | null,
  durationSec: number | null,
) {
  return {
    position,
    track: {
      id: `fixture-track-${position}`,
      mediaType: 'track',
      title,
      artworkUrl: null,
      releaseDate: null,
      artists: ['Fixture artist'],
      albumName: 'Fixture album',
      album: { id: 'fixture-album', title: 'Fixture album' },
      albumLinkStrategy: null,
      albumTags: [],
      playlists: [],
      sources: ['album'],
      durationSec,
      dateAdded: null,
      spotifyTrackId,
      spotifyMatch: spotifyTrackId ? 'album-track-list' : 'unmatched',
      spotifyUrl: spotifyTrackId
        ? `https://open.spotify.com/track/${spotifyTrackId}`
        : null,
      isrc: null,
      scrobbles: 0,
      lastListenedAt: null,
    },
  }
}

const album = AlbumDetailSchema.parse({
  id: 'fixture-album',
  mediaType: 'album',
  slug: 'fixture-album',
  title: 'Fixture album',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [{ name: 'Fixture artist', role: 'artist', billingOrder: 0 }],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  dateAdded: null,
  durationSec: null,
  spotifyUrl: `https://open.spotify.com/album/${albumId}`,
  trackCount: 3,
  tracks: [
    albumTrack(2, 'Second', secondTrackId, 180),
    albumTrack(3, 'Unmatched', null, null),
    albumTrack(1, 'First', firstTrackId, 180),
  ],
})
const track = TrackListItemSchema.parse({
  id: 'fixture-track',
  mediaType: 'track',
  title: 'Fixture track',
  artworkUrl: null,
  releaseDate: null,
  artists: ['Fixture artist'],
  albumName: 'Fixture album',
  album: null,
  albumLinkStrategy: null,
  albumTags: [],
  playlists: [],
  durationSec: 180,
  dateAdded: null,
  spotifyTrackId: firstTrackId,
  spotifyMatch: 'spotify-import',
  spotifyUrl: `https://open.spotify.com/track/${firstTrackId}`,
  isrc: null,
  scrobbles: 0,
  lastListenedAt: null,
})
const options = {
  apiBaseUrl: 'http://localhost',
  params: new URLSearchParams(),
  href: '/tracks',
  label: 'Tracks',
  total: 1000,
  startIndex: 0,
}

function response(data: unknown) {
  return Response.json({ statusCode: 200, message: 'OK', data })
}

function page<T>(items: T[], pageNumber = 1) {
  return {
    page: pageNumber,
    size: browsePageSize,
    totalCount: 1000,
    pageCount: 10,
    items,
  }
}

function trackPage<T>(items: T[], pageNumber = 1) {
  return { page: pageNumber, size: browsePageSize, hasMore: true, items }
}

test('a browse source stays lazy and retains its query beyond the visible page', async (t) => {
  const calls: URL[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url)
      assert.equal(init?.credentials, 'include')
      return response(trackPage([track], Number(url.searchParams.get('page'))))
    },
  )
  const params = new URLSearchParams({
    q: 'Fixture',
    filters: '[{"field":"artists","value":"Fixture artist","mode":"include"}]',
    ranges: '[]',
    sortBy: 'title',
    direction: 'asc',
    groupRecordings: 'true',
  })
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'tracks',
    params,
    startIndex: 500,
    href: '/tracks?q=Fixture&sortBy=title&direction=asc',
  })
  params.set('q', 'Changed view')
  params.delete('groupRecordings')
  assert.equal(calls.length, 0)
  assert.equal(source.startIndex, 500)
  assert.equal(source.href, '/tracks?q=Fixture&sortBy=title&direction=asc')
  const loaded = await source.load(500)
  assert.equal(loaded[0]?.uri, `spotify:track:${firstTrackId}`)
  assert.equal(calls[0]?.pathname, '/api/v1/tracks/browse-page')
  assert.equal(calls[0]?.searchParams.get('page'), '6')
  assert.equal(calls[0]?.searchParams.get('size'), String(browsePageSize))
  assert.equal(calls[0]?.searchParams.get('q'), 'Fixture')
  assert.equal(calls[0]?.searchParams.get('sortBy'), 'title')
  assert.equal(calls[0]?.searchParams.get('direction'), 'asc')
  assert.equal(calls[0]?.searchParams.get('ranges'), '[]')
  assert.equal(calls[0]?.searchParams.get('groupRecordings'), 'true')
  assert.match(calls[0]?.searchParams.get('filters') ?? '', /Fixture artist/)
  await source.load(500)
  assert.equal(calls.length, 1)
})

test('pending Track playback reuses cached Browse rows before fetching a later page', async (t) => {
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input)))
    return response({ ...trackPage([track], 2), hasMore: false })
  })
  const source = createPendingTrackBrowseSource(
    {
      ...options,
      startIndex: browsePageSize - 2,
      initialItem: track,
      getCachedPage: (page) =>
        page === 1
          ? trackPage(Array.from({ length: browsePageSize }, () => track))
          : undefined,
    },
    async () => {
      throw new Error('Count unavailable')
    },
  )
  assert.deepEqual(await source.readPageEnd(browsePageSize - 2), {
    end: browsePageSize,
    hasMore: true,
  })
  assert.equal((await source.load(browsePageSize - 1))[0]?.title, track.title)
  assert.equal(calls.length, 0)
  assert.deepEqual(await source.readPageEnd(browsePageSize), {
    end: browsePageSize + 1,
    hasMore: false,
  })
  assert.equal((await source.load(browsePageSize))[0]?.title, track.title)
  const exact = source.withLength(browsePageSize + 1)
  assert.equal(exact.length, browsePageSize + 1)
  assert.equal((await exact.load(browsePageSize))[0]?.title, track.title)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.pathname, '/api/v1/tracks/browse-page')
  assert.equal(calls[0]?.searchParams.get('page'), '2')
})

test('the clicked track starts without fetching and unplayable or missing rows are skipped', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () =>
    response(trackPage([track, { ...track, spotifyTrackId: null }])),
  )
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'tracks',
    initialItem: track,
  })
  assert.equal((await source.load(0))[0]?.title, 'Fixture track')
  assert.equal(network.mock.callCount(), 0)
  assert.deepEqual(await source.load(1), [])
  assert.deepEqual(await source.load(2), [])
  for (const index of [-1, 0.5, 1000])
    assert.deepEqual(await source.load(index), [])
  assert.equal(network.mock.callCount(), 1)
})

test('tracks spread over a grouped list keep the group query for their positions', async (t) => {
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    const positions = (url.searchParams.get('positions') ?? '')
      .split(',')
      .map(Number)
    return response({
      items: positions
        // Position 7 is past the end of the list on the server.
        .filter((position) => position !== 7)
        .map((position) => ({
          position,
          item: {
            ...track,
            id: `fixture-${position}`,
            title: `Track ${position}`,
            spotifyTrackId: position === 5 ? null : track.spotifyTrackId,
          },
        })),
    })
  })
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'tracks',
    params: new URLSearchParams({
      q: 'Fixture',
      sortBy: 'title',
      direction: 'asc',
      groupRecordings: 'true',
      page: '3',
      size: '100',
    }),
    startIndex: 2,
    initialItem: track,
  })
  const loaded = await source.loadScattered?.([640, 2, 5, 7, 12, 640, -1, 1000])
  assert.deepEqual(
    loaded?.map((items) => items.map((item) => item.title)),
    [
      ['Track 640'],
      ['Fixture track'],
      [],
      [],
      ['Track 12'],
      ['Track 640'],
      [],
      [],
    ],
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.pathname, '/api/v1/tracks/positions')
  assert.equal(calls[0]?.searchParams.get('positions'), '640,5,7,12')
  assert.equal(calls[0]?.searchParams.get('q'), 'Fixture')
  assert.equal(calls[0]?.searchParams.get('sortBy'), 'title')
  assert.equal(calls[0]?.searchParams.get('direction'), 'asc')
  assert.equal(calls[0]?.searchParams.get('groupRecordings'), 'true')
  assert.equal(calls[0]?.searchParams.has('page'), false)
  assert.equal(calls[0]?.searchParams.has('size'), false)

  // More positions than one request takes are split between requests.
  const many = Array.from({ length: 60 }, (_, index) => index + 100)
  assert.equal((await source.loadScattered?.(many))?.length, 60)
  assert.deepEqual(
    calls
      .slice(1)
      .map((url) => url.searchParams.get('positions')?.split(',').length),
    [50, 10],
  )
  // The clicked track alone needs no request.
  assert.equal(
    (await source.loadScattered?.([2]))?.[0]?.[0]?.title,
    'Fixture track',
  )
  assert.equal(calls.length, 3)

  assert.ok(source.descriptor)
  const restored = restorePlaybackSource(options.apiBaseUrl, {
    label: source.label,
    href: source.href,
    length: source.length,
    startIndex: source.startIndex,
    descriptor: source.descriptor,
  })
  assert.equal(
    (await restored.loadScattered?.([640]))?.[0]?.[0]?.title,
    'Track 640',
  )
  assert.equal(calls[3]?.searchParams.get('groupRecordings'), 'true')

  const albums = createBrowsePlaybackSource({
    ...options,
    collection: 'albums',
  })
  assert.equal(albums.loadScattered, undefined)
})

test('album rows expand stored tracks in position order and cache their detail', async (t) => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    return response(url.pathname === '/api/v1/albums' ? page([album]) : album)
  })
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'albums',
    label: 'Albums',
    href: '/albums',
  })
  const tracks = await source.load(0)
  assert.deepEqual(
    tracks.map((item) => item.title),
    ['First', 'Second'],
  )
  assert.ok(tracks.every((item) => item.kind === 'track'))
  assert.equal(tracks[0]?.albumId, album.id)
  await source.load(0)
  assert.deepEqual(paths, ['/api/v1/albums', '/api/v1/albums/fixture-album'])
})

test('an album source uses captured tracks and falls back to album context only without playable tracks', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected request')
  })
  const source = createAlbumPlaybackSource(album, '/albums?item=fixture-album')
  assert.equal(source.length, 1)
  assert.equal(source.label, 'Fixture album')
  const first = await source.load(0)
  assert.deepEqual(
    first.map((item) => item.title),
    ['First', 'Second'],
  )
  first.splice(0, 1)
  assert.equal((await source.load(0)).length, 2)
  assert.deepEqual(await source.load(1), [])
  const fallback = createAlbumPlaybackSource(
    { ...album, tracks: [] },
    '/albums',
  )
  assert.equal((await fallback.load(0))[0]?.uri, `spotify:album:${albumId}`)
  const unplayable = createAlbumPlaybackSource(
    { ...album, tracks: [], spotifyUrl: null },
    '/albums',
  )
  assert.deepEqual(await unplayable.load(0), [])
  assert.equal(network.mock.callCount(), 0)
})

test('album table playback preserves its selected rows and order instead of re-sorting the album', async () => {
  const selected = album.tracks.filter(
    ({ track }) => track.spotifyTrackId !== null,
  )
  const source = createAlbumPlaybackSource(album, '/albums', selected)
  assert.deepEqual(
    (await source.load(0)).map((item) => item.title),
    ['Second', 'First'],
  )
  selected.reverse()
  assert.deepEqual(
    (await source.load(0)).map((item) => item.title),
    ['Second', 'First'],
  )
  const empty = createAlbumPlaybackSource(album, '/albums', [])
  assert.deepEqual(await empty.load(0), [])
})

test('album track views restore search and order only for that album', () => {
  const saved = JSON.stringify({
    id: album.id,
    q: 'Fixture ',
    sortBy: 'duration',
    direction: 'desc',
  })
  assert.deepEqual(albumTrackView(saved, album.id), {
    id: album.id,
    q: 'Fixture ',
    sortBy: 'duration',
    direction: 'desc',
  })
  assert.deepEqual(albumTrackView(saved, 'another-album'), {
    id: 'another-album',
    q: '',
    sortBy: 'position',
    direction: 'asc',
  })
  for (const invalid of [
    null,
    '{',
    JSON.stringify({ id: album.id, sortBy: 'invalid' }),
  ])
    assert.equal(albumTrackView(invalid, album.id).sortBy, 'position')
})

test('a saved Similar tracks source keeps the selected start and captured row order', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error(
      'A captured source should not read the updated recommendations',
    )
  })
  const tracks = [
    ...album.tracks.map(({ track }) => libraryTrackPlayable(track)),
    libraryTrackPlayable({ ...track, spotifyTrackId: 'D'.repeat(22) }),
  ]
  const source = createSimilarTracksPlaybackSource('seed track', tracks, 2)
  const { descriptor, href, label, length, startIndex, kind } = source
  assert.equal(href, '/tracks/seed%20track?tab=similar')
  assert.equal(label, 'Similar tracks')
  assert.equal(kind, 'list')
  assert.equal(startIndex, 2)

  const saved = SavedSourceSchema.parse({
    descriptor,
    href,
    label,
    length,
    startIndex,
    kind,
    remaining: [[2, length]],
    played: [],
    skipped: [],
    exhausted: [],
    upcoming: [],
    history: [],
  })
  assert.equal(saved.descriptor.type, 'similar-tracks')
  assert.equal(
    SavedSourceSchema.safeParse({
      ...saved,
      descriptor: {
        ...saved.descriptor,
        tracks: Array.from({ length: TIDAL_SIMILAR_LIMIT + 1 }, () => null),
      },
    }).success,
    false,
  )
  tracks.reverse()

  const restored = restorePlaybackSource(options.apiBaseUrl, saved)
  for (const captured of [source, restored]) {
    assert.equal(captured.startIndex, 2)
    assert.equal(captured.href, href)
    const rows = await Promise.all(
      Array.from({ length: captured.length }, (_, index) =>
        captured.load(index),
      ),
    )
    assert.deepEqual(
      rows.map((row) => row[0]?.uri ?? null),
      [
        `spotify:track:${secondTrackId}`,
        null,
        `spotify:track:${firstTrackId}`,
        `spotify:track:${'D'.repeat(22)}`,
      ],
    )
  }
  assert.equal(network.mock.callCount(), 0)
})

test('playlist sources keep captured sorting and filters and expand legacy albums', async (t) => {
  const initialEntry: PlaylistEntry = {
    kind: 'track',
    position: 400,
    addedAt: null,
    track,
  }
  const playlist = PlaylistDetailSchema.parse({
    id: 'fixture-playlist',
    name: 'Fixture playlist',
    source: null,
    ownerName: null,
    description: null,
    artworkUrl: null,
    spotifyUrl: null,
    importedAt: null,
    trackCount: 1,
    linkedTrackCount: 0,
    albumCount: 1,
    durationSec: 180,
    items: page(
      [
        {
          kind: 'album',
          position: 401,
          addedAt: null,
          album: {
            id: album.id,
            title: album.title,
            artists: ['Fixture artist'],
            artworkUrl: null,
            releaseDate: null,
            spotifyUrl: album.spotifyUrl,
          },
        },
      ],
      6,
    ),
  })
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    return response(
      url.pathname.startsWith('/api/v1/playlists/') ? playlist : album,
    )
  })
  const params = new URLSearchParams({
    sortBy: 'title',
    direction: 'desc',
    q: 'Fixture',
    kinds: '["track","album"]',
  })
  const source = createPlaylistPlaybackSource({
    ...options,
    id: 'fixture-playlist',
    params,
    label: playlist.name,
    startIndex: 400,
    initialEntry,
  })
  params.set('sortBy', 'position')
  assert.equal((await source.load(400))[0]?.title, track.title)
  assert.equal(calls.length, 0)
  assert.deepEqual(
    (await source.load(500)).map((item) => item.title),
    ['First', 'Second'],
  )
  assert.equal(calls[0]?.pathname, '/api/v1/playlists/fixture-playlist')
  assert.equal(calls[0]?.searchParams.get('page'), '6')
  assert.equal(calls[0]?.searchParams.get('sortBy'), 'title')
  assert.equal(calls[0]?.searchParams.get('direction'), 'desc')
  assert.equal(calls[0]?.searchParams.get('q'), 'Fixture')
  assert.equal(calls[0]?.searchParams.get('kinds'), '["track","album"]')
})

test('page validation failures are not cached and can be retried explicitly', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1
    return response(
      requests === 1
        ? trackPage([{ title: 'Incomplete' }])
        : trackPage([track]),
    )
  })
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'tracks',
  })
  await assert.rejects(source.load(0))
  assert.equal(requests, 1)
  assert.equal((await source.load(0))[0]?.title, 'Fixture track')
  assert.equal(requests, 2)
})

test('source page caches stay bounded while concurrent reads share a request', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () =>
    response(trackPage([track])),
  )
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'tracks',
  })
  await Promise.all([source.load(0), source.load(0)])
  assert.equal(network.mock.callCount(), 1)
  for (const index of [100, 200, 300, 400]) await source.load(index)
  assert.equal(network.mock.callCount(), 5)
  await source.load(0)
  assert.equal(network.mock.callCount(), 6)
})

test('a library playlist plays its entries in position order and restores from its descriptor', async (t) => {
  const calls: URL[] = []
  const albumRow = AlbumListItemSchema.parse(album)
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    if (url.pathname === '/api/v1/library-playlists/tracks-pl/entries')
      return response({
        library: 'tracks',
        page: Number(url.searchParams.get('page')),
        size: browsePageSize,
        hasMore: false,
        items: [
          {
            id: 'entry-101',
            position: 101,
            addedAt: '2026-11-01T00:00:00.000Z',
            item: track,
          },
        ],
      })
    if (url.pathname === '/api/v1/library-playlists/albums-pl/entries')
      return response({
        library: 'albums',
        page: 1,
        size: browsePageSize,
        hasMore: false,
        items: [
          {
            id: 'entry-1',
            position: 1,
            addedAt: '2026-11-01T00:00:00.000Z',
            item: albumRow,
          },
        ],
      })
    return response(album)
  })
  const tracks = createLibraryPlaylistPlaybackSource({
    apiBaseUrl: options.apiBaseUrl,
    id: 'tracks-pl',
    library: 'tracks',
    href: '/playlists/library/tracks-pl',
    label: 'Late Shift',
    total: 101,
    startIndex: 0,
  })
  assert.deepEqual(tracks.descriptor, {
    type: 'library-playlist',
    id: 'tracks-pl',
    library: 'tracks',
  })
  assert.equal(tracks.kind, 'list')
  assert.deepEqual(
    (await tracks.load(100)).map((item) => item.title),
    ['Fixture track'],
  )
  assert.equal(calls[0]?.searchParams.get('page'), '2')
  assert.equal(calls[0]?.searchParams.get('size'), String(browsePageSize))
  assert.deepEqual(await tracks.load(101), [])

  const albums = createLibraryPlaylistPlaybackSource({
    apiBaseUrl: options.apiBaseUrl,
    id: 'albums-pl',
    library: 'albums',
    href: '/playlists/library/albums-pl',
    label: 'Rainy Sundays',
    total: 1,
    startIndex: 0,
  })
  assert.equal(albums.kind, 'album')
  // An album entry plays the album's stored tracks.
  assert.ok((await albums.load(0)).length > 0)
  assert.ok(
    calls.some((url) => url.pathname === '/api/v1/albums/fixture-album'),
  )

  // A saved session with the source reads back and resumes from it.
  assert.ok(tracks.descriptor)
  const saved = SavedSourceSchema.parse({
    descriptor: tracks.descriptor,
    label: tracks.label,
    href: tracks.href,
    length: tracks.length,
    startIndex: 100,
    kind: tracks.kind,
    remaining: [],
    played: [],
    skipped: [],
    exhausted: [],
    upcoming: [],
    history: [],
  })
  const restored = restorePlaybackSource(options.apiBaseUrl, saved)
  assert.deepEqual(restored.descriptor, tracks.descriptor)
  assert.equal(restored.startIndex, 100)
  assert.equal((await restored.load(100))[0]?.title, 'Fixture track')
})
