import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AlbumPlayButtons,
  LibraryTrackPlayButton,
  LibraryTrackPlayButtons,
  LibraryTrackQueueButton,
  TilePlayControls,
  TrackPlayButton,
  TrackQueueButton,
} from './play-controls'
import { PlaybackViewContext, type PlaybackView } from './playback-provider'
import {
  albumPlayable,
  type LibraryTrackSource,
  type PlaybackSnapshot,
} from '@/utils/playback'
import { idlePlaybackState } from '@/utils/playback-engine'

const trackId = 'ABCDEFGHIJKL1234567890'
const album = {
  id: 'library-album',
  title: 'Fixture album',
  artworkUrl: null,
  credits: [{ name: 'Example artist', role: 'artist', billingOrder: 0 }],
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
const on: PlaybackView = { ...idlePlaybackState, enabled: true }

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
      <TrackQueueButton album={album} track={track} />
    </>
  )
}

test('play controls are absent while playback is off', () => {
  assert.equal(render(controls()), '2')
})

test('play controls name the album and track they act on', () => {
  const html = render(controls(), on)
  assert.match(html, /aria-label="Play Fixture album"/)
  assert.match(html, /aria-label="Add Fixture album to queue"/)
  assert.match(html, />Play<\/button>/)
  assert.match(html, />Add to queue<\/button>/)
  assert.match(html, /aria-label="Play Second track"/)
  assert.match(html, /aria-label="Add Second track to queue"/)
  assert.doesNotMatch(html, /Pause/)
})

test('the playing album and track offer pause', () => {
  const html = render(controls(), {
    ...on,
    active: true,
    current: albumPlayable(album),
    snapshot,
  })
  assert.match(html, /class="tile-play" data-current="true"/)
  assert.match(html, /aria-label="Pause Fixture album"/)
  assert.match(html, />Pause<\/button>/)
  assert.match(html, /class="track-play" data-current="true"/)
  assert.match(html, /aria-label="Pause Second track"/)
  const paused = render(controls(), {
    ...on,
    active: true,
    current: albumPlayable(album),
    snapshot: { ...snapshot, paused: true },
  })
  assert.match(paused, /aria-label="Play Fixture album"/)
  assert.match(paused, /aria-label="Play Second track"/)
})

test('albums and tracks without Spotify identifiers have no play controls', () => {
  const unlinked = { ...album, spotifyUrl: null }
  const untracked = { ...track, externalId: null }
  assert.equal(
    render(
      <>
        <TilePlayControls album={unlinked} />
        <AlbumPlayButtons album={unlinked} />
        <TrackPlayButton album={album} track={untracked} />
        <TrackQueueButton album={album} track={untracked} />
      </>,
      on,
    ),
    '2',
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
      <LibraryTrackQueueButton track={track} />
      <LibraryTrackPlayButtons track={track} />
    </>
  )
}

test('library track controls are absent while playback is off, leaving the row number', () => {
  assert.equal(render(libraryControls()), '7')
})

test('library track controls play, number and queue the track', () => {
  const html = render(libraryControls(), on)
  assert.equal(
    (html.match(/aria-label="Play Playlist track"/g) ?? []).length,
    2,
  )
  assert.match(html, /class="track-number[^"]*">7<\/span>/)
  assert.match(
    html,
    /class="track-queue[^"]*" aria-label="Add Playlist track to queue"/,
  )
  assert.match(html, />Play<\/button>/)
  assert.match(html, />Add to queue<\/button>/)
  assert.doesNotMatch(html, /Pause/)
})

test('the playing library track offers pause', () => {
  const html = render(libraryControls(), { ...on, active: true, snapshot })
  assert.equal(
    (html.match(/data-current="true" aria-label="Pause Playlist track"/g) ?? [])
      .length,
    2,
  )
  assert.match(html, />Pause<\/button>/)
})

test('library tracks without a Spotify track ID have no play controls', () => {
  assert.equal(
    render(libraryControls({ ...libraryTrack, spotifyTrackId: 'local' }), on),
    '7',
  )
  assert.equal(
    render(libraryControls({ ...libraryTrack, spotifyTrackId: null }), on),
    '7',
  )
})
