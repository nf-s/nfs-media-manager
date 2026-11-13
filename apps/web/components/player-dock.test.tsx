import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import PlayerDock from './player-dock'
import { PlaybackViewContext, type PlaybackView } from './playback-provider'
import { ConfigContext } from './providers'
import type { PlayableItem, PlaybackSnapshot } from '@/utils/playback'
import { idlePlaybackState } from '@/utils/playback-engine'

const trackId = 'ABCDEFGHIJKL1234567890'
const item: PlayableItem = {
  kind: 'album',
  uri: 'spotify:album:1234567890ABCDEFGHIJKL',
  title: 'Fixture album',
  artist: 'Example artist',
  albumId: 'library-album',
  albumTitle: 'Fixture album',
  artworkUrl: null,
  trackCount: 2,
}
const snapshot: PlaybackSnapshot = {
  trackUri: `spotify:track:${trackId}`,
  linkedFromUri: null,
  trackName: 'Second track',
  artists: 'Example artist',
  albumName: 'Fixture album',
  artworkUrl: null,
  durationMs: 200_000,
  positionMs: 65_000,
  paused: true,
  contextUri: item.uri,
  hasNext: false,
  trackNumber: 2,
  discNumber: 1,
  at: 0,
}
const on: PlaybackView = { ...idlePlaybackState, enabled: true }

function unexpectedNavigation() {
  throw new Error('Navigation forbidden during rendering')
}

function render(view?: PlaybackView) {
  const dock = view ? (
    <PlaybackViewContext.Provider value={view}>
      <PlayerDock />
    </PlaybackViewContext.Provider>
  ) : (
    <PlayerDock />
  )
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ConfigContext.Provider
        value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
      >
        <AppRouterContext.Provider
          value={{
            back: unexpectedNavigation,
            forward: unexpectedNavigation,
            refresh: unexpectedNavigation,
            push: unexpectedNavigation,
            replace: unexpectedNavigation,
            prefetch: unexpectedNavigation,
          }}
        >
          <PathnameContext.Provider value="/albums">
            {dock}
          </PathnameContext.Provider>
        </AppRouterContext.Provider>
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
}

test('the dock is hidden until playback is on and something is played or queued', () => {
  assert.equal(render(), '')
  assert.equal(render(on), '')
  assert.equal(
    render({ ...idlePlaybackState, active: true, enabled: false }),
    '',
  )
})

test('the dock shows the track, transport, queue count, device and Spotify link', () => {
  const html = render({
    ...on,
    active: true,
    current: item,
    snapshot,
    queue: [{ key: 'queued-1', item: { ...item, title: 'Queued album' } }],
    volume: 0.8,
  })
  assert.match(html, /<section class="player-dock" aria-label="Player"/)
  assert.match(html, /aria-label="Open Fixture album"/)
  assert.match(html, /<strong>Second track<\/strong>/)
  assert.match(html, /Example artist · Fixture album/)
  assert.match(html, /aria-label="Play"/)
  assert.match(html, /1:05/)
  assert.match(html, /3:20/)
  assert.match(html, /aria-label="Queue: 1 next"/)
  assert.match(html, /Queued album/)
  assert.match(html, /aria-label="Play on: This browser"/)
  assert.match(
    html,
    new RegExp(`href="https://open.spotify.com/track/${trackId}"`),
  )
  assert.doesNotMatch(html, /role="alert"/)
})

test('a queue with nothing playing keeps the dock and its queue', () => {
  const html = render({
    ...on,
    active: true,
    queue: [{ key: 'queued-1', item }],
  })
  assert.match(html, /<strong>Nothing playing<\/strong>/)
  assert.match(html, /aria-label="Queue: 1 next"/)
  assert.match(html, /aria-label="Previous" disabled=""/)
  assert.doesNotMatch(html, /open\.spotify\.com/)
})

test('playback started elsewhere is shown without a library album', () => {
  const html = render({
    ...on,
    active: true,
    snapshot: { ...snapshot, paused: false },
    target: {
      kind: 'remote',
      device: {
        id: 'speaker',
        name: 'Fixture speaker',
        type: 'speaker',
        active: true,
        restricted: false,
        volume: 0.4,
      },
    },
    queue: [{ key: 'queued-1', item }],
    volume: 0.4,
  })
  assert.match(html, /<strong>Second track<\/strong>/)
  assert.match(html, /aria-label="Pause"/)
  assert.match(html, /aria-label="Play on: Fixture speaker"/)
  assert.match(html, /Press Next to start the queue\./)
  assert.doesNotMatch(html, /aria-label="Open Fixture album"|<h3>Playing<\/h3>/)
})

test('a device apps cannot control is shown with its transport disabled', () => {
  const view: PlaybackView = {
    ...on,
    active: true,
    snapshot: { ...snapshot, paused: false },
    target: { kind: 'restricted', name: 'Fixture hi-fi', type: 'speaker' },
    volume: null,
  }
  const html = render(view)
  assert.match(html, /<strong>Second track<\/strong>/)
  assert.match(html, /aria-label="Play on: Fixture hi-fi"/)
  assert.match(html, /aria-label="Previous" disabled=""/)
  assert.match(html, /aria-label="Pause" disabled=""/)
  assert.match(html, /aria-label="Next" disabled=""/)
  assert.match(html, /aria-label="Seek"[^>]* disabled=""/)
  assert.match(html, /Spotify does not let apps control Fixture hi-fi\./)
  assert.doesNotMatch(html, /aria-label="Volume"/)
  // The queue can still start here, so Next stays available for it.
  const queued = render({ ...view, queue: [{ key: 'queued-1', item }] })
  assert.doesNotMatch(queued, /aria-label="Next" disabled=""/)
})

test('a playback error keeps the controls and links to Spotify', () => {
  const html = render({
    ...on,
    active: true,
    current: item,
    failure: {
      status: 'error',
      message: 'Spotify Premium is required to play in the browser.',
    },
  })
  assert.match(
    html,
    /role="alert"><span>Spotify Premium is required to play in the browser\.<\/span>/,
  )
  assert.match(html, /Open in Spotify/)
  assert.match(html, /aria-label="Dismiss"/)
  assert.match(html, /class="player-transport"/)
})

test('an expired connection replaces the controls with Reconnect', () => {
  const html = render({
    ...on,
    active: true,
    current: item,
    failure: { status: 'expired', message: 'Sign in again to keep playing.' },
  })
  assert.match(html, /Spotify disconnected/)
  assert.match(html, /Sign in again to keep playing\./)
  assert.match(html, />Reconnect<\/button>/)
  assert.doesNotMatch(html, /player-transport/)
})
