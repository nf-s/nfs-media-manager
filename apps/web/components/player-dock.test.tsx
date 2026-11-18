import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import PlayerDock, { rejoinMessage } from './player-dock'
import { PlaybackViewContext, type PlaybackView } from './playback-provider'
import { ConfigContext } from './providers'
import type {
  PlayableItem,
  PlaybackSnapshot,
  QueueEntry,
} from '@/utils/playback'
import { idlePlaybackState, type PlaybackTarget } from '@/utils/playback-engine'

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
  albumUri: null,
  artistLinks: [],
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
const on: PlaybackView = {
  ...idlePlaybackState,
  enabled: true,
  connection: 'connected',
}

function unexpectedNavigation() {
  throw new Error('Navigation forbidden during rendering')
}

function render(view?: PlaybackView, search = '') {
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
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              {dock}
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
}

test('the bar asks to connect Spotify until playback is connected, then always shows the player', () => {
  assert.equal(render(), '')
  const off: PlaybackView = {
    ...idlePlaybackState,
    enabled: false,
    connection: 'disconnected',
  }
  const prompt = render(off)
  assert.match(prompt, /Spotify playback is not connected/)
  assert.match(prompt, />Connect Spotify<\/button>/)
  assert.match(prompt, /aria-label="Dismiss"/)
  const unconfigured = render({ ...off, connection: 'unconfigured' })
  assert.match(unconfigured, /href="\/providers\/spotify\?tab=settings"/)
  assert.doesNotMatch(unconfigured, />Connect Spotify</)
  const idle = render(on)
  assert.match(idle, /<strong>Nothing playing<\/strong>/)
  assert.match(idle, /aria-label="Play on: This browser"/)
  assert.match(idle, /aria-label="Play" disabled=""/)
})

test('a sign-in that returned to the app reports its result in the bar', () => {
  assert.match(
    render(on, 'player=sonos-connected'),
    /role="status" data-tone="info"><span>Sonos connected\.<\/span>/,
  )
  assert.match(
    render(on, 'player=sonos-error'),
    /role="alert" data-tone="error"><span>Sonos did not connect\. Try again\./,
  )
  assert.doesNotMatch(render(on, 'player=unknown'), /player-alert/)
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
  // Artwork, track and album open the library album; the artist has no page to open.
  assert.match(
    html,
    /<a [^>]*aria-label="Open Fixture album"[^>]*href="\/albums[^"]*library-album[^"]*"/,
  )
  assert.match(html, /<strong><a [^>]*>Second track<\/a><\/strong>/)
  assert.match(html, /Example artist · <a [^>]*>Fixture album<\/a>/)
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

test('shuffle can be set at any time and exposes its selected state', () => {
  const withoutSource = render({ ...on, active: true, current: item })
  assert.match(withoutSource, /aria-label="Shuffle" aria-pressed="false"/)
  assert.doesNotMatch(withoutSource, /aria-label="Shuffle"[^>]*disabled=""/)
  assert.doesNotMatch(withoutSource, /Back to source/)
  const withSource = render({
    ...on,
    active: true,
    current: item,
    source: { label: 'Tracks', href: '/tracks?sortBy=title&direction=asc' },
    shuffle: true,
  })
  assert.match(withSource, /aria-label="Shuffle" aria-pressed="true"/)
})

test('the queue links to the saved source and places ten upcoming tracks after queued items', () => {
  const upcoming: QueueEntry[] = Array.from({ length: 12 }, (_, index) => ({
    key: `${index + 1}:0`,
    item: {
      ...item,
      kind: 'track',
      uri: `spotify:track:fixture-${index}`,
      title: `Source track ${index + 1}`,
      trackCount: 1,
    },
  }))
  const html = render({
    ...on,
    active: true,
    current: item,
    source: { label: 'Tracks', href: '/tracks?sortBy=title&direction=asc' },
    queue: [{ key: 'queued-1', item: { ...item, title: 'Queued album' } }],
    upcoming,
  })
  assert.match(html, /href="\/tracks\?sortBy=title&amp;direction=asc"/)
  assert.match(html, /Back to source: Tracks/)
  assert.match(html, /<h3>Queued<\/h3>/)
  assert.match(html, /<h3>Next from Tracks<\/h3>/)
  assert.ok(html.indexOf('Queued album') < html.indexOf('Next from Tracks'))
  assert.match(html, /<strong>Source track 10<\/strong>/)
  assert.doesNotMatch(html, /Source track 11|Source track 12/)
  // A queued entry can be played now, moved and removed.
  assert.match(html, /aria-label="Play Queued album now"/)
  assert.match(html, /aria-label="Move Queued album up"[^>]* disabled=""/)
  assert.match(html, /aria-label="Remove Queued album from queue"/)
  assert.doesNotMatch(html, /aria-label="Move Queued album to queue"/)
  // A source track can be skipped to, moved to the queue, reordered and removed.
  assert.match(html, /aria-label="Skip to Source track 3"/)
  assert.match(html, /aria-label="Move Source track 3 to queue"/)
  assert.match(html, /aria-label="Move Source track 1 up"[^>]* disabled=""/)
  assert.doesNotMatch(
    html,
    /aria-label="Move Source track 2 up"[^>]* disabled=""/,
  )
  // The last track listed cannot be moved out of sight.
  assert.match(html, /aria-label="Move Source track 10 down"[^>]* disabled=""/)
  assert.match(html, /aria-label="Remove Source track 3 from upcoming tracks"/)
  assert.equal(
    html.match(/<li class="queue-row"[^>]* draggable="true"/g)?.length,
    11,
  )
})

test('the queue shows loading state and permits next when only the source has tracks', () => {
  const html = render({
    ...on,
    active: true,
    source: { label: 'Albums', href: '/albums' },
    upcoming: [
      { key: '1:0', item: { ...item, kind: 'track', title: 'Upcoming track' } },
    ],
    sourceLoading: true,
  })
  assert.match(html, /role="status">Loading tracks…/)
  assert.match(html, /aria-label="Queue: 0 queued, 1 upcoming"/)
  assert.doesNotMatch(html, /aria-label="Next" disabled=""/)
  assert.doesNotMatch(html, /aria-label="Play" disabled=""/)
  assert.doesNotMatch(html, /No upcoming tracks/)
})

test('playback started elsewhere is shown without a library album', () => {
  const html = render({
    ...on,
    active: true,
    snapshot: {
      ...snapshot,
      paused: false,
      albumUri: 'spotify:album:1234567890ABCDEFGHIJKL',
      artistLinks: [
        {
          name: 'Example artist',
          uri: 'spotify:artist:0987654321ABCDEFGHIJKL',
        },
      ],
    },
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
  // Without library items, the track, artist and album open on Spotify.
  assert.match(
    html,
    new RegExp(
      `<strong><a href="https://open.spotify.com/track/${trackId}"[^>]*>Second track</a></strong>`,
    ),
  )
  assert.match(
    html,
    /<a href="https:\/\/open\.spotify\.com\/artist\/0987654321ABCDEFGHIJKL"[^>]*>Example artist<\/a> · <a href="https:\/\/open\.spotify\.com\/album\/1234567890ABCDEFGHIJKL"[^>]*>Fixture album<\/a>/,
  )
  assert.match(html, /aria-label="Open Fixture album in Spotify"/)
  assert.match(html, /aria-label="Pause"/)
  assert.match(html, /aria-label="Play on: Fixture speaker"/)
  assert.match(html, /Press Next to start the queue\./)
  assert.doesNotMatch(html, /<h3>Playing<\/h3>/)
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
  assert.match(html, /<strong><a [^>]*>Second track<\/a><\/strong>/)
  assert.match(html, /aria-label="Play on: Fixture hi-fi"/)
  assert.match(html, /aria-label="Previous" disabled=""/)
  assert.match(html, /aria-label="Pause" disabled=""/)
  assert.match(html, /aria-label="Next" disabled=""/)
  assert.match(html, /aria-label="Seek"[^>]* disabled=""/)
  assert.match(html, /Spotify does not let apps control Fixture hi-fi\./)
  assert.doesNotMatch(html, /aria-label="Volume"/)
  // Starting the queue would take the playback off the device, so Next stays off.
  const queued = render({ ...view, queue: [{ key: 'queued-1', item }] })
  assert.match(queued, /aria-label="Next" disabled=""/)
  assert.match(queued, /Fixture hi-fi plays the tracks it was sent/)
  assert.doesNotMatch(queued, /Press Next to start the queue/)
  // While its Sonos room is being looked up, the device shows that instead.
  const finding = render({ ...view, findingSonos: true })
  assert.match(
    finding,
    /lucide-loader-circle[^>]*>.*?<\/svg><span>Fixture hi-fi<\/span>/,
  )
  assert.doesNotMatch(finding, /does not let apps control/)
})

test('a Sonos group enables the controls Sonos accepts', () => {
  const html = render({
    ...on,
    active: true,
    snapshot: { ...snapshot, paused: false },
    target: {
      kind: 'sonos',
      name: 'Fixture hi-fi',
      type: 'speaker',
      group: {
        id: 'RINCON_FIXTURE:1',
        name: 'Fixture hi-fi',
        household: 'household-1',
        playable: false,
        actions: {
          pause: true,
          play: true,
          next: true,
          previous: false,
          seek: false,
        },
        volume: 0.3,
      },
    },
    queue: [{ key: 'queued-1', item }],
    volume: 0.3,
  })
  assert.match(html, /aria-label="Play on: Fixture hi-fi"/)
  assert.match(html, /aria-label="Pause"(?! disabled)/)
  assert.doesNotMatch(html, /aria-label="Pause" disabled=""/)
  assert.doesNotMatch(html, /aria-label="Next" disabled=""/)
  // Neither previous nor seek is accepted, so both are off.
  assert.match(html, /aria-label="Previous" disabled=""/)
  assert.match(html, /aria-label="Seek"[^>]* disabled=""/)
  assert.match(html, /aria-label="Volume"/)
  assert.match(html, /Fixture hi-fi is controlled through Sonos\./)
  assert.match(
    html,
    /<span class="sonos-mark" aria-hidden="true">SONOS<\/span><span>Fixture hi-fi<\/span>/,
  )
  assert.doesNotMatch(
    html,
    /Press Next to start the queue|does not let apps control/,
  )
})

test('a chosen Sonos room is shown as the device with its mark', () => {
  const html = render({
    ...on,
    active: true,
    current: item,
    snapshot: { ...snapshot, paused: false },
    target: {
      kind: 'room',
      room: {
        id: 'RINCON_FIXTURE:1',
        name: 'Fixture hi-fi',
        household: 'household-1',
      },
    },
    queue: [{ key: 'queued-1', item }],
    volume: 0.3,
  })
  assert.match(html, /aria-label="Play on: Fixture hi-fi"/)
  assert.match(
    html,
    /<span class="sonos-mark" aria-hidden="true">SONOS<\/span><span>Fixture hi-fi<\/span>/,
  )
  for (const control of ['Pause', 'Next', 'Previous'])
    assert.doesNotMatch(html, new RegExp(`aria-label="${control}" disabled=""`))
  assert.doesNotMatch(html, /aria-label="Seek"[^>]* disabled=""/)
  assert.doesNotMatch(html, /plays the tracks|does not let apps control/)
})

test('a Sonos group that can be started keeps Next for the track due', () => {
  const group = {
    id: 'RINCON_FIXTURE:1',
    name: 'Fixture hi-fi',
    household: 'household-1',
    playable: true,
    actions: {
      pause: true,
      play: true,
      next: false,
      previous: false,
      seek: true,
    },
    volume: 0.3,
  }
  const view: PlaybackView = {
    ...on,
    active: true,
    snapshot: { ...snapshot, paused: false },
    target: { kind: 'sonos', name: 'Fixture hi-fi', type: 'speaker', group },
    volume: 0.3,
  }
  // The group has no track of its own to skip to and nothing is due here.
  assert.match(render(view), /aria-label="Next" disabled=""/)
  const queued = render({ ...view, queue: [{ key: 'queued-1', item }] })
  assert.doesNotMatch(queued, /aria-label="Next" disabled=""/)
  assert.match(queued, /Press Next to start the queue\./)
  assert.match(
    queued,
    /Changes to the queue reach it with the next track started from\s+here\./,
  )
  assert.doesNotMatch(queued, /device this app can start/)
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

test('rejoining a saved session shows what happened on its room or device', () => {
  const room: PlaybackTarget = {
    kind: 'room',
    room: { id: 'RINCON_FIXTURE:1', name: 'Fixture hi-fi', household: 'h1' },
  }
  let html = render({
    ...on,
    active: true,
    current: item,
    target: room,
    starting: true,
    rejoin: { status: 'checking', device: 'Fixture hi-fi' },
  })
  assert.match(
    html,
    /<div class="player-alert" role="status" data-tone="info"><span>Rejoining the queue on Fixture hi-fi…<\/span><\/div>/,
  )
  html = render({
    ...on,
    active: true,
    current: item,
    snapshot: { ...snapshot, paused: false },
    target: room,
    rejoin: { status: 'rejoined', device: 'Fixture hi-fi' },
  })
  assert.match(
    html,
    /Rejoined the queue on Fixture hi-fi\.<\/span><button type="button" aria-label="Dismiss"/,
  )
  assert.match(html, /aria-label="Play on: Fixture hi-fi"/)
  html = render({
    ...on,
    active: true,
    rejoin: { status: 'changed', device: 'Fixture hi-fi' },
  })
  assert.match(
    html,
    /Fixture hi-fi no longer has this queue, so the player did not rejoin it\./,
  )
  assert.match(html, /aria-label="Play on: This browser"/)
  // An error takes the place of the note.
  html = render({
    ...on,
    active: true,
    failure: { status: 'error', message: 'Fixture failure' },
    rejoin: { status: 'ended', device: 'Fixture hi-fi' },
  })
  assert.doesNotMatch(html, /no longer playing/)
  assert.equal(
    rejoinMessage({ status: 'ended', device: 'Fixture hi-fi' }),
    'The queue is no longer playing on Fixture hi-fi.',
  )
  assert.equal(
    rejoinMessage({ status: 'unreadable', device: null }),
    'The device could not be read, so the player did not rejoin it.',
  )
})
