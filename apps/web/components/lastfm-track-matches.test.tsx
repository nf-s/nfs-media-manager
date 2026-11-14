import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import { TrackListItemSchema, type TrackListItem } from '@repo/schemas/tracks'
import LastfmTrackMatches, {
  LastfmTrackMatchList,
  lastfmTrackMatchFilters,
  loadLastfmTrackMatchCounts,
  loadLastfmTracksToMatch,
} from './lastfm-track-matches'
import { refreshScrobbleLinks } from './lastfm-sync'
import { ConfigContext } from './providers'

const stored = LastfmSyncStatusSchema.parse({
  configured: true,
  state: 'complete',
  schedule: 'off',
  nextScheduledAt: null,
  pagesFetched: 1,
  totalPages: 1,
  newScrobbles: 3,
  storedScrobbles: 3,
  matchedScrobbles: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  lastCompletedAt: '2026-01-01T00:01:00.000Z',
  errorMessage: null,
})

function render(status = stored) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['lastfm-sync'], status)
  client.setQueryData(['tracks', 'lastfm-match-counts'], {
    total: 3,
    withoutSpotify: 2,
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <LastfmTrackMatches />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('track imports explain stored-history matching and link to unmatched tracks', () => {
  const html = render()
  assert.match(html, />Refresh matches<\/button>/)
  assert.match(html, /This makes no Last.fm or Spotify requests/)
  assert.match(html, /No Spotify match/)
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(
    (match) => new URL(match[1] ?? '', 'http://localhost'),
  )
  assert.ok(
    links.some((url) =>
      JSON.parse(url.searchParams.get('filters') ?? '[]').some(
        (filter: { field: string; value: string }) =>
          filter.field === 'spotifyMatch' && filter.value === 'Unmatched',
      ),
    ),
  )
  assert.doesNotMatch(html, /Import Last.fm tracks/)
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Refresh matches/)
  assert.match(
    render({ ...stored, storedScrobbles: 0 }),
    /<button[^>]*disabled=""[^>]*>Refresh matches/,
  )
  assert.match(
    render({ ...stored, configured: false }),
    /<button[^>]*disabled=""[^>]*>Refresh matches/,
  )
  assert.match(
    render({ ...stored, state: 'running' }),
    /<button[^>]*disabled=""[^>]*>Refresh matches/,
  )
})

const lastfmTrack = TrackListItemSchema.parse({
  id: 'lastfm-track',
  mediaType: 'track',
  title: 'Stored recording',
  artists: ['Example artist'],
  albumName: 'Recorded album',
  album: null,
  albumLinkStrategy: null,
  albumTags: [],
  playlists: [],
  sources: ['lastfm'],
  artworkUrl: null,
  releaseDate: null,
  durationSec: null,
  dateAdded: null,
  spotifyTrackId: null,
  spotifyMatch: 'unmatched',
  spotifyUrl: null,
  isrc: null,
  scrobbles: 4,
  lastListenedAt: null,
})

function renderList(items: TrackListItem[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['tracks', 'lastfm-matching', '', '["needs-match"]', 'scrobbles', 'desc'],
    {
      pages: [
        { page: 1, size: 100, totalCount: items.length, pageCount: 1, items },
      ],
      pageParams: [1],
    },
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <LastfmTrackMatchList />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('needs match includes unmatched and album-derived identities, while all remains Last.fm scoped', () => {
  const source = { field: 'source', value: 'Last.fm', mode: 'required' }
  assert.deepEqual(lastfmTrackMatchFilters(['needs-match']), [
    source,
    { field: 'spotifyMatch', value: 'Spotify import', mode: 'exclude' },
  ])
  assert.deepEqual(lastfmTrackMatchFilters(['matched']), [
    source,
    { field: 'spotifyMatch', value: 'Spotify import', mode: 'required' },
  ])
  assert.deepEqual(lastfmTrackMatchFilters([]), [source])
  assert.deepEqual(lastfmTrackMatchFilters(['needs-match', 'matched']), [
    source,
  ])
})

test('matching list searches, sorts and paginates stored tracks on the server with cancellation', async (t) => {
  const signal = new AbortController().signal
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new URL(String(url))
      assert.equal(request.pathname, '/api/v1/tracks')
      assert.equal(request.searchParams.get('q'), 'Example artist')
      assert.equal(request.searchParams.get('page'), '2')
      assert.equal(request.searchParams.get('size'), '100')
      assert.equal(request.searchParams.get('sortBy'), 'artist')
      assert.equal(request.searchParams.get('direction'), 'asc')
      assert.deepEqual(
        JSON.parse(request.searchParams.get('filters') ?? '[]'),
        lastfmTrackMatchFilters(['needs-match']),
      )
      assert.equal(init?.signal, signal)
      assert.equal(init?.method, undefined)
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: {
          page: 2,
          size: 100,
          totalCount: 101,
          pageCount: 2,
          items: [lastfmTrack],
        },
      })
    },
  )
  const result = await loadLastfmTracksToMatch(
    'http://localhost:4001',
    {
      q: 'Example artist',
      statuses: ['needs-match'],
      page: 2,
      sortBy: 'artist',
      direction: 'asc',
    },
    signal,
  )
  assert.equal(result.items[0]?.id, lastfmTrack.id)
  assert.equal(result.totalCount, 101)
  assert.equal(fetch.mock.callCount(), 1)
})

test('matching rows expose stored metadata, service icons and actions for both eligible match types', () => {
  const fallback = TrackListItemSchema.parse({
    ...lastfmTrack,
    id: 'album-derived',
    title: 'Album-derived recording',
    spotifyMatch: 'album-track-list',
    spotifyTrackId: '1234567890ABCDEFGHIJKL',
    spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
  })
  const html = renderList([lastfmTrack, fallback])
  assert.match(html, /aria-label="Search Last.fm tracks"/)
  assert.match(html, /aria-label="Last.fm tracks to match"/)
  assert.match(html, /aria-label="Match Stored recording"/)
  assert.match(html, /aria-label="Match Album-derived recording"/)
  assert.match(html, /Recorded album/)
  assert.match(html, /Example artist/)
  assert.match(html, /Album track list/)
  assert.match(
    html,
    /https:\/\/www.last.fm\/music\/Example%20artist\/_\/Stored%20recording/,
  )
  assert.match(html, /aria-label="Open Spotify \(opens in a new tab\)"/)
  assert.match(html, /aria-label="Open Last.fm \(opens in a new tab\)"/)
  assert.doesNotMatch(html, /<dialog|Confirm merge|Unlink|Search Spotify/)
})

test('native imported Spotify rows open details and never offer a merge or unlink action', () => {
  const html = renderList([
    TrackListItemSchema.parse({
      ...lastfmTrack,
      spotifyMatch: 'spotify-import',
      spotifyTrackId: '1234567890ABCDEFGHIJKL',
      spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
      sources: ['lastfm', 'spotify'],
    }),
  ])
  assert.match(html, /href="\/tracks\/lastfm-track">Open track<\/a>/)
  assert.match(html, /Spotify import/)
  assert.match(html, /1 track/)
  assert.doesNotMatch(html, /aria-label="Match Stored recording"|Unlink/)
})

test('match counts use source membership and effective Spotify matching filters', async (t) => {
  const queries: URLSearchParams[] = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    const params = new URL(String(url)).searchParams
    queries.push(params)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: {
        items: [],
        totalCount: params.get('filters')?.includes('spotifyMatch') ? 2 : 3,
        page: 1,
        size: 1,
        pageCount: 3,
      },
    })
  })
  assert.deepEqual(await loadLastfmTrackMatchCounts('http://localhost:4001'), {
    total: 3,
    withoutSpotify: 2,
  })
  assert.equal(queries.length, 2)
  for (const params of queries) {
    assert.equal(params.get('size'), '1')
    assert.deepEqual(JSON.parse(params.get('filters') ?? '[]')[0], {
      field: 'source',
      value: 'Last.fm',
      mode: 'required',
    })
  }
})

test('refresh posts only the stored relink action and invalidates affected library data', async (t) => {
  const client = new QueryClient()
  const keys = [
    ['tracks', 'browse'],
    ['tracks', 'facets'],
    ['track', 'track-1'],
    ['playlists'],
    ['playlist', 'playlist-1'],
    ['album-playlists', 'album-1'],
    ['albums'],
    ['album', 'album-1'],
    ['album-listening', 'album-1'],
    ['lastfm-links'],
  ]
  for (const key of [...keys, ['films']]) client.setQueryData(key, [])
  const network = t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(url, 'http://localhost:4001/api/v1/lastfm/links/refresh')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.body, '{}')
      return Response.json({ statusCode: 200, message: 'OK', data: stored })
    },
  )
  try {
    assert.deepEqual(
      await refreshScrobbleLinks('http://localhost:4001', client),
      stored,
    )
    assert.equal(network.mock.callCount(), 1)
    assert.deepEqual(client.getQueryData(['lastfm-sync']), stored)
    for (const key of keys)
      assert.equal(client.getQueryState(key)?.isInvalidated, true)
    assert.equal(client.getQueryState(['films'])?.isInvalidated, false)
  } finally {
    client.clear()
  }
})
