import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import LastfmTrackMatches, {
  loadLastfmTrackMatchCounts,
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
  const links = [...html.matchAll(/href="([^\"]+)"/g)].map(
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
  assert.doesNotMatch(html, /disabled=""/)
  assert.match(render({ ...stored, storedScrobbles: 0 }), /disabled=""/)
  assert.match(render({ ...stored, configured: false }), /disabled=""/)
  assert.match(render({ ...stored, state: 'running' }), /disabled=""/)
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
