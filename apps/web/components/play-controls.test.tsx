import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AlbumPlayButtons,
  LibraryTrackPlayButton,
  LibraryTrackPlayButtons,
  playFromView,
  TilePlayControls,
  TrackPlayButton,
} from './play-controls'
import { PlaybackViewContext, type PlaybackView } from './playback-provider'
import {
  albumPlayable,
  libraryTrackPlayable,
  type LibraryTrackSource,
  type PendingPlaybackSource,
  type PlaybackSnapshot,
} from '@/utils/playback'
import { idlePlaybackState } from '@/utils/playback-engine'

const trackId = 'ABCDEFGHIJKL1234567890'
const album = {
  id: 'library-album',
  title: 'Fixture album',
  artworkUrl: null,
  credits: [
    { id: null, name: 'Example artist', role: 'artist', billingOrder: 0 },
  ],
  trackCount: 2,
  spotifyUrl: 'https://open.spotify.com/album/1234567890ABCDEFGHIJKL',
  links: [],
  providerReferences: [],
}
const track = { position: 2, externalId: trackId, title: 'Second track' }
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
  positionMs: 10_000,
  paused: false,
  contextUri: 'spotify:album:1234567890ABCDEFGHIJKL',
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

function render(children: ReactNode, view?: PlaybackView) {
  return renderToStaticMarkup(
    view ? (
      <PlaybackViewContext.Provider value={view}>
        {children}
      </PlaybackViewContext.Provider>
    ) : (
      children
    ),
  )
}

function controls() {
  return (
    <>
      <TilePlayControls album={album} />
      <AlbumPlayButtons album={album} />
      <TrackPlayButton album={album} track={track} />
    </>
  )
}

test('play controls remain visible with a connection explanation while playback is off', () => {
  const html = render(controls())
  assert.match(
    html,
    /aria-label="Play Fixture album: Connect Spotify playback in the player\."/,
  )
  assert.match(
    html,
    /aria-label="Add Fixture album to queue: Connect Spotify playback in the player\."/,
  )
  assert.match(
    html,
    /aria-label="Play Second track: Connect Spotify playback in the player\."/,
  )
  // Tile pair, header pair and track pair: Play and Queue each, all disabled.
  assert.equal((html.match(/disabled=""/g) ?? []).length, 6)
})

test('every control is the shared play pair: Play immediately followed by Queue', () => {
  const html = render(controls(), on)
  assert.match(html, /<span class="ds-play" data-place="tile">/)
  assert.match(html, /<span class="ds-play" data-place="row">/)
  for (const pair of html.match(/<span class="ds-play"[^>]*>.*?<\/span>/g) ??
    [])
    assert.match(pair, /aria-label="(Play|Pause) [^"]+".*aria-label="Add /)
  // Play is labelled; Queue is the square icon button after it.
  assert.match(
    html,
    />Play<\/button><button class="ds-btn"[^>]*data-icon=""[^>]*title="Add to queue"[^>]*>(?:(?!<\/button>).)*<\/svg><\/button>/,
  )
})

test('play controls name the album and track they act on', () => {
  const html = render(controls(), on)
  assert.match(html, /aria-label="Play Fixture album"/)
  assert.match(html, /aria-label="Add Fixture album to queue"/)
  assert.match(html, />Play<\/button>/)
  assert.doesNotMatch(html, />Queue<\/button>/)
  assert.match(html, /aria-label="Play Second track"/)
  assert.match(html, /aria-label="Add Second track to queue"/)
  assert.match(html, /class="browse-play-position">2<\/span>/)
  assert.doesNotMatch(html, /Pause/)
})

test('the playing album and track offer pause', () => {
  const html = render(controls(), {
    ...on,
    active: true,
    current: albumPlayable(album),
    snapshot,
  })
  assert.match(
    html,
    /data-place="tile"><button type="button" aria-label="Pause Fixture album"[^>]*aria-pressed="true"/,
  )
  assert.match(html, />Pause<\/button>/)
  assert.match(html, /aria-label="Pause Second track"[^>]*aria-pressed="true"/)
  const paused = render(controls(), {
    ...on,
    active: true,
    current: albumPlayable(album),
    snapshot: { ...snapshot, paused: true },
  })
  assert.match(paused, /aria-label="Play Fixture album"/)
  assert.match(paused, /aria-label="Play Second track"/)
})

test('albums and tracks without Spotify identifiers keep disabled play controls', () => {
  const unlinked = { ...album, spotifyUrl: null }
  const untracked = { ...track, externalId: null }
  const html = render(
    <>
      <TilePlayControls album={unlinked} />
      <AlbumPlayButtons album={unlinked} />
      <TrackPlayButton album={album} track={untracked} />
    </>,
    on,
  )
  assert.match(html, /No Spotify recording is available/)
  assert.equal((html.match(/disabled=""/g) ?? []).length, 6)
  assert.match(
    html,
    /aria-label="Add Fixture album to queue: No Spotify recording is available\."[^>]*disabled=""/,
  )
})

const libraryTrack = {
  spotifyTrackId: trackId,
  title: 'Playlist track',
  artists: ['Example artist'],
  album: null,
  albumName: 'Fixture album',
  artworkUrl: null,
}

function libraryControls(track: LibraryTrackSource = libraryTrack) {
  return (
    <>
      <LibraryTrackPlayButton track={track} />
      <LibraryTrackPlayButton track={track} position={7} />
      <LibraryTrackPlayButtons track={track} />
    </>
  )
}

test('library track controls explain disconnected playback and retain the row number', () => {
  const html = render(libraryControls())
  assert.match(html, /Connect Spotify playback in the player/)
  assert.match(html, /class="browse-play-position">7<\/span>/)
  assert.equal((html.match(/disabled=""/g) ?? []).length, 6)
})

test('library track controls play, number and queue the track', () => {
  const html = render(libraryControls(), on)
  assert.equal(
    (html.match(/aria-label="Play Playlist track"/g) ?? []).length,
    3,
  )
  assert.match(
    html,
    /class="browse-play-position">7<\/span><span class="ds-play"/,
  )
  assert.equal(
    (html.match(/aria-label="Add Playlist track to queue"/g) ?? []).length,
    3,
  )
  assert.match(html, />Play<\/button>/)
  assert.match(html, /title="Add to queue"/)
  assert.doesNotMatch(html, /Pause/)
})

test('the playing library track offers pause', () => {
  const html = render(libraryControls(), { ...on, active: true, snapshot })
  assert.equal(
    (
      html.match(
        /aria-label="Pause Playlist track"[^>]*aria-pressed="true"/g,
      ) ?? []
    ).length,
    2,
  )
  assert.match(html, />Pause<\/button>/)
})

test('library tracks without a Spotify track ID explain why playback is disabled', () => {
  for (const spotifyTrackId of ['local', null]) {
    const html = render(
      libraryControls({ ...libraryTrack, spotifyTrackId }),
      on,
    )
    assert.match(html, /No Spotify recording is available/)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 6)
  }
})

test("a library track pair can sit on a card's artwork", () => {
  const html = render(
    <LibraryTrackPlayButton track={libraryTrack} place="tile" />,
    on,
  )
  assert.match(
    html,
    /^<span class="ds-play" data-place="tile"><button type="button" aria-label="Play Playlist track"/,
  )
  assert.match(html, /aria-label="Add Playlist track to queue"/)
  const off = render(
    <LibraryTrackPlayButton
      track={{ ...libraryTrack, spotifyTrackId: null }}
      place="tile"
    />,
    on,
  )
  assert.match(off, /data-place="tile"/)
  assert.equal((off.match(/disabled=""/g) ?? []).length, 2)
})

test('clicking the same Browse track during startup or while paused uses toggle', () => {
  const item = libraryTrackPlayable(libraryTrack)
  assert.ok(item)
  const source: PendingPlaybackSource = {
    label: 'Tracks',
    href: '/tracks?sortBy=title',
    kind: 'list',
    startIndex: 0,
    load: async () => [],
    readPageEnd: async () => ({ end: 1, hasMore: false }),
    withLength: () => {
      throw new Error('The source should not be constructed again')
    },
    resolve: async () => {
      throw new Error('The count should not be requested again')
    },
  }
  const commands: string[] = []
  const controls = {
    play: () => commands.push('play'),
    toggle: () => commands.push('toggle'),
  }
  playFromView(
    controls,
    { ...on, current: item, starting: true, source },
    item,
    false,
    () => source,
  )
  playFromView(
    controls,
    { ...on, current: item, snapshot: { ...snapshot, paused: true }, source },
    item,
    true,
    () => source,
  )
  assert.deepEqual(commands, ['toggle', 'toggle'])
})
