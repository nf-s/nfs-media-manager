import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  SonosAccountStatusSchema,
  SonosRoomsSchema,
  type SonosRooms,
} from '@repo/schemas/sonos'
import { ConfigContext } from './providers'
import SonosConnection from './sonos-connection'

function render(
  status: { configured: boolean; connected: boolean },
  options: { rooms?: SonosRooms; search?: string; appUrl?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['sonos-account'],
    SonosAccountStatusSchema.parse({ ...status, redirectUri: null }),
  )
  if (options.rooms)
    client.setQueryData(['sonos-rooms'], SonosRoomsSchema.parse(options.rooms))
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  const appUrl = options.appUrl ?? 'https://app.example.test'
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider value={{ apiBaseUrl: '', appUrl }}>
          <SearchParamsContext.Provider
            value={new URLSearchParams(options.search ?? '')}
          >
            <SonosConnection />
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

test('setup names the callback to register, or why it cannot be registered here', () => {
  const deployed = render({ configured: false, connected: false })
  assert.match(
    deployed,
    /Save the Sonos integration key, secret and redirect URI first\./,
  )
  assert.match(
    deployed,
    /Register https:\/\/app\.example\.test\/api\/v1\/sonos\/callback as the redirect URI/,
  )
  assert.doesNotMatch(deployed, /<button/)

  const local = render(
    { configured: false, connected: false },
    { appUrl: 'http://localhost:3001' },
  )
  assert.match(local, /Sonos requires an HTTPS redirect URI/)
})

test('a configured integration offers Connect and reports the outcome', () => {
  const html = render(
    { configured: true, connected: false },
    { search: 'sonos=error' },
  )
  assert.match(html, />Connect Sonos<\/button>/)
  assert.match(html, /<p role="alert">Sonos did not connect\. Try again\.<\/p>/)
  assert.doesNotMatch(html, /Rooms|Disconnect/)
})

test('a connection lists rooms with what they play and the controls Sonos accepts', () => {
  const html = render(
    { configured: true, connected: true },
    {
      search: 'sonos=connected',
      rooms: {
        households: [
          {
            id: 'household',
            name: null,
            rooms: [
              {
                id: 'group-1',
                name: 'Lounge + 1',
                players: ['Lounge', 'Portable'],
                state: 'playing',
                service: 'Spotify',
                track: 'Fixture track',
                artist: 'Fixture artist',
                actions: {
                  pause: true,
                  play: false,
                  next: true,
                  previous: false,
                  seek: true,
                },
              },
              {
                id: 'group-2',
                name: 'Study',
                players: ['Study'],
                state: 'idle',
                service: null,
                track: null,
                artist: null,
                actions: {
                  pause: false,
                  play: false,
                  next: false,
                  previous: false,
                  seek: false,
                },
              },
            ],
          },
        ],
      },
    },
  )
  assert.match(html, /<p role="status">Sonos connected\.<\/p>/)
  assert.match(html, />Disconnect Sonos<\/button>/)
  assert.match(html, /<dt>Lounge \+ Portable<\/dt>/)
  assert.match(
    html,
    /Playing · Spotify · Fixture track – Fixture artist · Controls: pause, next, seek/,
  )
  assert.match(html, /<dt>Study<\/dt><dd>Idle · No controls accepted<\/dd>/)
  assert.match(html, />Refresh rooms<\/button>/)
})
