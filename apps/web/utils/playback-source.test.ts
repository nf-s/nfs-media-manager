import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AlbumDetailSchema } from '@repo/schemas/media'
import {
  PlaylistDetailSchema,
  TrackListItemSchema,
  type PlaylistEntry,
} from '@repo/schemas/tracks'
import {
  albumDetailTab,
  albumTrackView,
  albumTrackViewHref,
  createAlbumPlaybackSource,
  createBrowsePlaybackSource,
  createPlaylistPlaybackSource,
} from './playback-source'
import { browsePageSize } from './virtual-browse'

const albumId = 'A'.repeat(22)
const firstTrackId = 'B'.repeat(22)
const secondTrackId = 'C'.repeat(22)
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
    {
      title: 'Second',
      position: 2,
      externalId: secondTrackId,
      durationSec: 180,
    },
    { title: 'Unmatched', position: 3, externalId: null, durationSec: null },
    { title: 'First', position: 1, externalId: firstTrackId, durationSec: 180 },
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

test('a browse source stays lazy and retains its query beyond the visible page', async (t) => {
  const calls: URL[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url)
      assert.equal(init?.credentials, 'include')
      return response(page([track], Number(url.searchParams.get('page'))))
    },
  )
  const params = new URLSearchParams({
    q: 'Fixture',
    filters: '[{"field":"artists","value":"Fixture artist","mode":"include"}]',
    ranges: '[]',
    sortBy: 'title',
    direction: 'asc',
  })
  const source = createBrowsePlaybackSource({
    ...options,
    collection: 'tracks',
    params,
    startIndex: 500,
    href: '/tracks?q=Fixture&sortBy=title&direction=asc',
  })
  params.set('q', 'Changed view')
  assert.equal(calls.length, 0)
  assert.equal(source.startIndex, 500)
  assert.equal(source.href, '/tracks?q=Fixture&sortBy=title&direction=asc')
  const loaded = await source.load(500)
  assert.equal(loaded[0]?.uri, `spotify:track:${firstTrackId}`)
  assert.equal(calls[0]?.pathname, '/api/v1/tracks')
  assert.equal(calls[0]?.searchParams.get('page'), '6')
  assert.equal(calls[0]?.searchParams.get('size'), String(browsePageSize))
  assert.equal(calls[0]?.searchParams.get('q'), 'Fixture')
  assert.equal(calls[0]?.searchParams.get('sortBy'), 'title')
  assert.equal(calls[0]?.searchParams.get('direction'), 'asc')
  assert.equal(calls[0]?.searchParams.get('ranges'), '[]')
  assert.match(calls[0]?.searchParams.get('filters') ?? '', /Fixture artist/)
  await source.load(500)
  assert.equal(calls.length, 1)
})

test('the clicked track starts without fetching and unplayable or missing rows are skipped', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () =>
    response(page([track, { ...track, spotifyTrackId: null }])),
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
  const selected = album.tracks.filter((track) => track.externalId !== null)
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

test('album return links restore the track table search, order and tab only for that album', () => {
  const view = albumTrackView(
    JSON.stringify({
      id: album.id,
      q: 'Fixture ',
      sortBy: 'duration',
      direction: 'desc',
    }),
    album.id,
  )
  const previous = new URLSearchParams({
    item: album.id,
    q: 'Browse search',
    view: 'table',
  })
  const href = albumTrackViewHref('/albums', previous, view)
  const params = new URL(href, 'http://localhost').searchParams
  assert.equal(params.get('item'), album.id)
  assert.equal(params.get('q'), 'Browse search')
  assert.equal(params.get('view'), 'table')
  assert.equal(albumDetailTab(params, album.id), 'tracks')
  assert.equal(albumDetailTab(params, 'another-album'), 'overview')
  assert.deepEqual(albumTrackView(params.get('albumTrackView'), album.id), view)
  assert.equal(view.q, 'Fixture ')
  assert.equal(previous.has('albumTrackView'), false)
  for (const invalid of [
    null,
    '{',
    JSON.stringify({ id: album.id, sortBy: 'invalid' }),
  ])
    assert.equal(albumTrackView(invalid, album.id).sortBy, 'position')
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
      requests === 1 ? page([{ title: 'Incomplete' }]) : page([track]),
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
    response(page([track])),
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
