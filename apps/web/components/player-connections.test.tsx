import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SonosAccountStatus, SonosRooms } from '@repo/schemas/sonos'
import {
  PlayerConnections,
  SonosRooms as SonosRoomList,
} from './player-connections'
import type { PlaybackView } from './playback-provider'
import { ConfigContext } from './providers'
import { idlePlaybackState } from '@/utils/playback-engine'

const view: PlaybackView = {
  ...idlePlaybackState,
  enabled: true,
  connection: 'connected',
}
const connected: SonosAccountStatus = {
  configured: true,
  connected: true,
  redirectUri: 'https://app.example/api/v1/sonos/callback',
}
const actions = {
  pause: true,
  play: true,
  next: true,
  previous: false,
  seek: true,
}
const rooms: SonosRooms = {
  households: [
    {
      id: 'household-1',
      name: null,
      rooms: [
        {
          id: 'RINCON_FIXTURE:1',
          name: 'Fixture hi-fi',
          players: ['Fixture hi-fi'],
          state: 'playing',
          service: 'Spotify',
          track: 'Fixture track',
          artist: 'Fixture artist',
          actions,
        },
        {
          id: 'RINCON_FIXTURE:2',
          name: 'Fixture study',
          players: ['Fixture study', 'Fixture hall'],
          state: 'idle',
          service: 'Spotify',
          track: 'Earlier track',
          artist: null,
          actions,
        },
      ],
    },
  ],
}

function render(
  element: React.ReactElement,
  account?: SonosAccountStatus,
  list?: SonosRooms,
) {
  const client = new QueryClient()
  if (account) client.setQueryData(['sonos-account'], account)
  if (list) client.setQueryData(['sonos-rooms'], list)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
      >
        {element}
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
}

test('Sonos rooms are listed with what they play and which one is controlled', () => {
  const html = render(
    <SonosRoomList
      view={{
        ...view,
        target: {
          kind: 'sonos',
          name: 'Fixture hi-fi',
          type: 'speaker',
          group: {
            id: 'RINCON_FIXTURE:1',
            name: 'Fixture hi-fi',
            actions,
            volume: 0.3,
          },
        },
      }}
    />,
    connected,
    rooms,
  )
  assert.match(
    html,
    /data-current="true"><span class="sonos-mark"[^>]*>SONOS<\/span><span class="device-room-text"><strong>Fixture hi-fi<\/strong><span>Controlled here · Spotify · Fixture track – Fixture artist<\/span>/,
  )
  assert.match(
    html,
    /data-current="false">.*?<strong>Fixture study \+ Fixture hall<\/strong><span>Idle<\/span>/,
  )
  assert.match(html, /start it from the Spotify\s+app\./)
})

test('the room being looked up and an empty account are reported', () => {
  const html = render(
    <SonosRoomList
      view={{
        ...view,
        findingSonos: true,
        target: { kind: 'restricted', name: 'Fixture hi-fi', type: 'speaker' },
      }}
    />,
    connected,
    { households: [] },
  )
  assert.match(html, /Finding Fixture hi-fi on Sonos…/)
  assert.match(html, /No Sonos rooms on this account\./)
})

test('rooms are left out until Sonos is connected', () => {
  assert.equal(
    render(<SonosRoomList view={view} />, { ...connected, connected: false }),
    '',
  )
  assert.equal(render(<SonosRoomList view={view} />), '')
})

test('connections show Spotify and the Sonos status with its next step', () => {
  const on = render(<PlayerConnections />, connected)
  assert.match(on, /<dt>Spotify<\/dt><dd>Connected<\/dd>/)
  assert.match(on, />Turn off playback<\/button>/)
  assert.match(on, /<dt>Sonos<\/dt><dd>Connected<\/dd>.*?>Disconnect<\/button>/)
  const off = render(<PlayerConnections />, { ...connected, connected: false })
  assert.match(
    off,
    /<dt>Sonos<\/dt><dd>Not connected<\/dd>.*?>Connect Sonos<\/button>/,
  )
  const unset = render(<PlayerConnections />, {
    configured: false,
    connected: false,
    redirectUri: null,
  })
  assert.match(
    unset,
    /<dd>Not set up<\/dd><a class="underline" href="\/providers\?provider=sonos&amp;section=credentials">Add credentials<\/a>/,
  )
  assert.match(render(<PlayerConnections />), /<dd>Checking…<\/dd>/)
})
