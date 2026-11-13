import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import { ConfigContext } from './providers'
import SpotifyPlaybackSetting from './spotify-playback-setting'

function render(
  status: { configured: boolean; connected: boolean; playback: boolean },
  search = '',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['spotify-account'],
    SpotifyAccountStatusSchema.parse({
      ...status,
      playlists: false,
      expiresAt: null,
      scope: null,
      redirectUri: null,
    }),
  )
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            <SpotifyPlaybackSetting />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
    network.mock.restore()
  }
}

test('playback is offered once Spotify credentials are saved', () => {
  const unconfigured = render({
    configured: false,
    connected: false,
    playback: false,
  })
  assert.match(unconfigured, /<h2>Playback<\/h2>/)
  assert.match(unconfigured, /Requires Spotify Premium\./)
  assert.match(unconfigured, /Save Spotify credentials first\./)
  assert.doesNotMatch(unconfigured, /<button/)

  const off = render({ configured: true, connected: true, playback: false })
  assert.match(off, />Connect playback<\/button>/)
  assert.doesNotMatch(off, /Save Spotify credentials first|Turn off playback/)
})

test('connected playback can be turned off and reports the Spotify outcome', () => {
  const status = { configured: true, connected: true, playback: true }
  const connected = render(status, 'spotify=connected')
  assert.match(connected, />Turn off playback<\/button>/)
  assert.match(connected, /Playback is on\./)
  assert.match(connected, /<p role="status">Spotify connected\.<\/p>/)
  assert.doesNotMatch(connected, /Connect playback|role="alert"/)

  const failed = render({ ...status, playback: false }, 'spotify=error')
  assert.match(
    failed,
    /<p role="alert">Spotify did not connect\. Try again\.<\/p>/,
  )
})
