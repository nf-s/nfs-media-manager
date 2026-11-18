import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import type { MatchDiagnosticsRow } from '@repo/schemas/match-diagnostics'
import type { SpotifyTrackSearchJob } from '@repo/schemas/spotify-track-search'
import { TrackListItemSchema, type TrackListItem } from '@repo/schemas/tracks'
import LastfmTrackMatches, {
  LastfmTrackMatchList,
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

const filters = [{ field: 'source', value: 'Last.fm', mode: 'required' }]

test('track imports explain stored-history matching and link to Last.fm tracks without a playable Spotify version', () => {
  const html = render()
  assert.match(html, />Refresh matches<\/button>/)
  assert.match(html, /This makes no Last.fm or Spotify requests/)
  assert.match(html, /No Spotify match/)
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(
    (match) =>
      new URL(match[1]?.replaceAll('&amp;', '&') ?? '', 'http://localhost'),
  )
  const missing = links.find((url) => url.pathname === '/tracks/matches')
  assert.equal(missing?.searchParams.get('playability'), 'unavailable')
  assert.equal(missing?.searchParams.get('sortBy'), 'scrobbles')
  assert.equal(missing?.searchParams.get('direction'), 'desc')
  assert.deepEqual(
    JSON.parse(missing?.searchParams.get('filters') ?? '[]'),
    filters,
  )
  assert.ok(
    links.some(
      (url) =>
        url.pathname === '/tracks' &&
        url.searchParams.get('filters') === JSON.stringify(filters),
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

function diagnosticRow(
  track: TrackListItem,
  spotifyAlternate?: MatchDiagnosticsRow['spotifyAlternate'],
) {
  return {
    id: track.id,
    name: track.title,
    creator: track.artists.join(', '),
    matches: [],
    track,
    spotifyAlternate,
  }
}

function renderList(
  items: ReturnType<typeof diagnosticRow>[],
  searchJob?: SpotifyTrackSearchJob,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['tracks', 'lastfm-matching', '', 'unavailable', 'scrobbles', 'desc', 1],
    { page: 1, size: 100, totalCount: items.length, pageCount: 1, items },
  )
  if (searchJob)
    client.setQueryData(
      ['tracks', 'spotify-track-search', 'status', [lastfmTrack.id]],
      { items: [{ trackId: lastfmTrack.id, job: searchJob }] },
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

test('matching list requests Spotify coverage, search, sort and pagination on the server with cancellation', async (t) => {
  const signal = new AbortController().signal
  const requestedPlayability: Array<string | null> = []
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new URL(String(url))
      assert.equal(request.pathname, '/api/v1/tracks/match-diagnostics')
      assert.equal(request.searchParams.get('q'), 'Example artist')
      assert.equal(request.searchParams.get('page'), '2')
      assert.equal(request.searchParams.get('size'), '100')
      assert.equal(
        request.searchParams.get('sortBy'),
        request.searchParams.get('playability') === 'playable'
          ? 'spotifyCoverage'
          : 'artist',
      )
      assert.equal(request.searchParams.get('direction'), 'asc')
      assert.equal(request.searchParams.get('view'), 'spotify-coverage')
      assert.deepEqual(
        JSON.parse(request.searchParams.get('filters') ?? '[]'),
        filters,
      )
      requestedPlayability.push(request.searchParams.get('playability'))
      assert.equal(init?.signal, signal)
      assert.equal(init?.method, undefined)
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: {
          totalCount: 101,
          pageCount: 2,
          providers: [],
          items: [diagnosticRow(lastfmTrack)],
        },
      })
    },
  )
  const selections: Array<
    Parameters<typeof loadLastfmTracksToMatch>[1]['statuses']
  > = [['needs-match'], ['matched'], [], ['needs-match', 'matched']]
  for (const statuses of selections) {
    const result = await loadLastfmTracksToMatch(
      'http://localhost:4001',
      {
        q: 'Example artist',
        statuses,
        page: 2,
        sortBy: statuses[0] === 'matched' ? 'spotifyMatch' : 'artist',
        direction: 'asc',
      },
      signal,
    )
    assert.equal(result.items[0]?.track.id, lastfmTrack.id)
    assert.equal(result.totalCount, 101)
  }
  assert.deepEqual(requestedPlayability, [
    'unavailable',
    'playable',
    null,
    null,
  ])
  assert.equal(fetch.mock.callCount(), 4)
})

test('matching rows preserve album provenance, service icons and name actions', () => {
  const fallback = TrackListItemSchema.parse({
    ...lastfmTrack,
    id: 'album-derived',
    title: 'Album-derived recording',
    spotifyMatch: 'album-track-list',
    spotifyTrackId: '1234567890ABCDEFGHIJKL',
    spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
  })
  const html = renderList([diagnosticRow(lastfmTrack), diagnosticRow(fallback)])
  assert.match(html, /aria-label="Search Last.fm tracks"/)
  assert.match(html, /aria-label="Last.fm tracks to match"/)
  assert.match(
    html,
    /aria-label="Select all loaded tracks needing a Spotify match"\/>/,
  )
  assert.match(
    html,
    /aria-label="Select Stored recording for Spotify search"\/>/,
  )
  assert.match(
    html,
    /aria-label="Select Album-derived recording for Spotify search" disabled=""/,
  )
  assert.match(html, /aria-label="Merge Last.fm names for Stored recording"/)
  assert.match(
    html,
    /aria-label="Merge Last.fm names for Album-derived recording"/,
  )
  assert.match(
    html,
    /href="\/tracks\/lastfm-track\?tab=sources">Scrobbled names<\/a>/,
  )
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

test('a track with a running Spotify search cannot be selected again', () => {
  const html = renderList([diagnosticRow(lastfmTrack)], {
    status: 'running',
    jobId: 'example-search',
    resultCount: null,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  })
  assert.match(
    html,
    /aria-label="Select Stored recording for Spotify search" disabled=""/,
  )
  assert.match(html, /data-status="running">Running/)
  assert.match(html, /href="\/jobs\/example-search"/)
})

test('matched Spotify rows open Sources and can merge their Last.fm names', () => {
  const html = renderList([
    diagnosticRow(
      TrackListItemSchema.parse({
        ...lastfmTrack,
        spotifyMatch: 'spotify-import',
        spotifyTrackId: '1234567890ABCDEFGHIJKL',
        spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
        sources: ['lastfm', 'spotify'],
      }),
    ),
  ])
  assert.match(
    html,
    /href="\/tracks\/lastfm-track\?tab=sources">Scrobbled names<\/a>/,
  )
  assert.match(html, /Spotify playlist \/ Liked Songs/)
  assert.match(html, /1 track/)
  assert.match(html, /aria-label="Merge Last.fm names for Stored recording"/)
  assert.doesNotMatch(html, /<dialog|Confirm merge/)
})

test('a confirmed Spotify catalog match has separate provenance and cannot be selected again', () => {
  const html = renderList(
    [
      diagnosticRow(
        TrackListItemSchema.parse({
          ...lastfmTrack,
          spotifyMatch: 'spotify-search',
          spotifyTrackId: '1234567890ABCDEFGHIJKL',
          spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
          sources: ['lastfm', 'spotify-search'],
        }),
      ),
    ],
    {
      jobId: 'example-search',
      status: 'succeeded',
      resultCount: 1,
      acceptedTrackId: lastfmTrack.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: '2026-01-01T00:02:00.000Z',
      errorMessage: null,
    },
  )
  assert.match(
    html,
    /href="\/tracks\/lastfm-track\?tab=sources">Matched track<\/a>/,
  )
  assert.doesNotMatch(html, /Review matches/)
  assert.match(html, /Spotify track search/)
  assert.match(
    html,
    /aria-label="Select Stored recording for Spotify search" disabled=""/,
  )
  assert.doesNotMatch(html, /Spotify playlist \/ Liked Songs|Unmatched/)
})

test('a verified alternate has its own match label, Spotify link and recording details', () => {
  const html = renderList([
    diagnosticRow(lastfmTrack, {
      trackId: 'spotify-alternate',
      name: 'Stored recording',
      albumName: 'Alternate album',
      identifier: '1234567890ABCDEFGHIJKL',
    }),
  ])
  assert.match(html, /Other Spotify version/)
  assert.match(html, /href="\/tracks\/spotify-alternate\?tab=sources"/)
  assert.match(
    html,
    /https:\/\/open.spotify.com\/track\/1234567890ABCDEFGHIJKL/,
  )
  assert.match(html, /aria-label="Merge Last.fm names for Stored recording"/)
  assert.doesNotMatch(html, /Unmatched|Album track list/)
})

test('a malformed stored Spotify ID without an alternate is unmatched', () => {
  const html = renderList([
    diagnosticRow(
      TrackListItemSchema.parse({
        ...lastfmTrack,
        spotifyMatch: 'album-track-list',
        spotifyTrackId: 'invalid',
        spotifyUrl: 'https://open.spotify.com/track/invalid',
      }),
    ),
  ])
  assert.match(html, /Unmatched/)
  assert.doesNotMatch(html, /Album track list|Open Spotify/)
})

test('match counts use source membership and effective Spotify matching filters', async (t) => {
  const queries: URLSearchParams[] = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    const request = new URL(String(url))
    assert.equal(request.pathname, '/api/v1/tracks/match-diagnostics')
    const params = request.searchParams
    queries.push(params)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: {
        items: [],
        totalCount: params.get('playability') === 'unavailable' ? 2 : 3,
        providers: [],
        pageCount: 3,
      },
    })
  })
  assert.deepEqual(await loadLastfmTrackMatchCounts('http://localhost:4001'), {
    total: 3,
    withoutSpotify: 2,
  })
  assert.deepEqual(
    queries.map((params) => params.get('playability')),
    [null, 'unavailable'],
  )
  for (const params of queries) {
    assert.equal(params.get('size'), '1')
    assert.equal(params.get('view'), 'spotify-coverage')
    assert.deepEqual(JSON.parse(params.get('filters') ?? '[]'), filters)
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
