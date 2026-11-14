import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import LastfmTracksImport from './lastfm-tracks-import'
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
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <LastfmTracksImport />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('stored history offers an explicit import without provider requests', () => {
  const html = render()
  assert.match(html, />Import Last.fm tracks<\/button>/)
  assert.match(html, /title="Use stored scrobbles; no Last.fm requests\."/)
  assert.doesNotMatch(html, /disabled=""/)
  assert.equal(render({ ...stored, storedScrobbles: 0 }), '')
  assert.equal(render({ ...stored, configured: false }), '')
})

test('import posts only the stored relink action and invalidates affected library data', async (t) => {
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
