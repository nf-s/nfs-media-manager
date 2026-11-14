import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  albumPlayable,
  formatClock,
  libraryTrackPlayable,
  moveEntry,
  playRequest,
  positionAt,
  queueSummary,
  sessionContains,
  spotifyWebUrl,
  startSession,
  stepSession,
  trackPlayable,
  type PlayableItem,
  type PlaybackSession,
  type PlaybackSnapshot,
} from './playback'

const albumId = '1234567890ABCDEFGHIJKL'
const trackId = 'ABCDEFGHIJKL1234567890'
const album = {
  id: 'library-album',
  title: 'Fixture album',
  artworkUrl: null,
  credits: [
    { name: 'First artist', role: 'artist', billingOrder: 0 },
    { name: 'A producer', role: 'producer', billingOrder: 1 },
    { name: 'Second artist', role: 'artist', billingOrder: 2 },
  ],
  trackCount: 3,
  spotifyUrl: `https://open.spotify.com/album/${albumId}`,
  links: [],
  providerReferences: [],
}
const albumUri = `spotify:album:${albumId}`
const trackUri = `spotify:track:${trackId}`

function snapshot(values: Partial<PlaybackSnapshot>): PlaybackSnapshot {
  return {
    trackUri: 'spotify:track:first',
    linkedFromUri: null,
    trackName: 'First',
    artists: 'First artist',
    albumName: 'Fixture album',
    artworkUrl: null,
    durationMs: 200_000,
    positionMs: 0,
    paused: false,
    contextUri: albumUri,
    hasNext: true,
    trackNumber: null,
    discNumber: null,
    at: 0,
    ...values,
  }
}

function playing(
  item: PlayableItem,
  anchorUri: string | null = null,
): PlaybackSession {
  return { ...startSession(item, 0), phase: 'playing', anchorUri }
}

test('builds playable albums and tracks only from valid Spotify identifiers', () => {
  const item = albumPlayable(album)
  assert.deepEqual(item, {
    kind: 'album',
    uri: albumUri,
    title: 'Fixture album',
    artist: 'First artist, Second artist',
    albumId: 'library-album',
    albumTitle: 'Fixture album',
    artworkUrl: null,
    trackCount: 3,
  })
  assert.equal(albumPlayable({ ...album, spotifyUrl: null }), null)
  assert.equal(
    albumPlayable(album, { externalId: trackId, title: 'Second' })?.startUri,
    trackUri,
  )
  assert.equal(albumPlayable(album, { externalId: null, title: 'x' }), null)
  assert.equal(
    trackPlayable(album, { externalId: 'not-an-id', title: 'x' }),
    null,
  )
  const track = trackPlayable(album, { externalId: trackId, title: 'Second' })
  assert.equal(track?.uri, trackUri)
  assert.equal(track?.title, 'Second')
  assert.equal(track?.albumTitle, 'Fixture album')
})

test('library tracks play alone, with their linked album when there is one', () => {
  const track = {
    spotifyTrackId: trackId,
    title: 'Playlist track',
    artists: ['First artist', 'Second artist'],
    album: { id: 'library-album', title: 'Fixture album' },
    albumName: 'Spotify album name',
    artworkUrl: null,
  }
  assert.deepEqual(libraryTrackPlayable(track), {
    kind: 'track',
    uri: trackUri,
    title: 'Playlist track',
    artist: 'First artist, Second artist',
    albumId: 'library-album',
    albumTitle: 'Fixture album',
    artworkUrl: null,
    trackCount: 1,
  })
  const unlinked = libraryTrackPlayable({ ...track, album: null })
  assert.equal(unlinked?.albumId, null)
  assert.equal(unlinked?.albumTitle, 'Spotify album name')
  assert.deepEqual(unlinked && playRequest(unlinked), { uris: [trackUri] })
  assert.equal(
    libraryTrackPlayable({ ...track, spotifyTrackId: 'local-file' }),
    null,
  )
  assert.equal(libraryTrackPlayable({ ...track, spotifyTrackId: null }), null)
})

test('requests an album context, an album from a track, or a single track', () => {
  const item = albumPlayable(album)
  const from = albumPlayable(album, { externalId: trackId, title: 'Second' })
  const track = trackPlayable(album, { externalId: trackId, title: 'Second' })
  assert.ok(item && from && track)
  assert.deepEqual(playRequest(item), { context_uri: albumUri })
  assert.deepEqual(playRequest(from), {
    context_uri: albumUri,
    offset: { uri: trackUri },
  })
  assert.deepEqual(playRequest(track), { uris: [trackUri] })
  assert.equal(
    spotifyWebUrl(albumUri),
    `https://open.spotify.com/album/${albumId}`,
  )
  assert.equal(
    spotifyWebUrl(trackUri),
    `https://open.spotify.com/track/${trackId}`,
  )
  assert.equal(spotifyWebUrl('spotify:playlist:1234567890ABCDEFGHIJKL'), null)
  assert.equal(spotifyWebUrl(null), null)
})

test('reorders, summarises and formats without mutating the queue', () => {
  const list = ['a', 'b', 'c']
  assert.deepEqual(moveEntry(list, 0, 2), ['b', 'c', 'a'])
  assert.deepEqual(moveEntry(list, 2, 0), ['c', 'a', 'b'])
  assert.deepEqual(moveEntry(list, 1, 3), list)
  assert.deepEqual(moveEntry(list, 5, 0), list)
  assert.deepEqual(list, ['a', 'b', 'c'])
  const item = albumPlayable(album)
  const track = trackPlayable(album, { externalId: trackId, title: 'Second' })
  assert.ok(item && track)
  assert.equal(queueSummary([]), '')
  assert.equal(
    queueSummary([
      { key: '1', item },
      { key: '2', item: track },
      { key: '3', item },
    ]),
    '2 albums, 1 track',
  )
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(72_400), '1:12')
  assert.equal(formatClock(-5), '0:00')
  assert.equal(formatClock(3_725_000), '62:05')
})

test('extrapolates position only while playing and never past the end', () => {
  const state = snapshot({ positionMs: 10_000, at: 1_000 })
  assert.equal(positionAt(state, 6_000), 15_000)
  assert.equal(positionAt({ ...state, paused: true }, 6_000), 10_000)
  assert.equal(positionAt(state, 900_000), 200_000)
  assert.equal(positionAt(state, 0), 10_000)
})

test('an album session starts when its context plays and gives up otherwise', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const session = startSession(item, 0)
  const other = snapshot({ contextUri: 'spotify:album:other', at: 1_000 })
  assert.deepEqual(stepSession(session, null, other), {
    session,
    event: 'none',
  })
  assert.equal(
    stepSession(session, null, { ...other, at: 11_000 }).event,
    'left',
  )
  const started = stepSession(session, other, snapshot({ at: 1_500 }))
  assert.equal(started.session.phase, 'playing')
  assert.equal(started.event, 'none')
})

test('an album finishes when its last track runs out and playback stops at the start', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const session = playing(item)
  const last = snapshot({
    trackUri: 'spotify:track:last',
    positionMs: 198_000,
    hasNext: false,
    at: 10_000,
  })
  const stopped = snapshot({ paused: true, positionMs: 0, at: 12_500 })
  assert.equal(stepSession(session, last, stopped).event, 'finished')
  // A track boundary inside the album is not the end of the album.
  const middle = { ...last, hasNext: true }
  assert.equal(stepSession(session, middle, stopped).event, 'none')
  // Returning to the start of the same track mid-way is not the end either.
  const early = { ...last, positionMs: 30_000 }
  assert.equal(
    stepSession(session, early, { ...stopped, trackUri: last.trackUri }).event,
    'none',
  )
  assert.equal(
    stepSession(session, { ...last, paused: true }, stopped).event,
    'none',
  )
})

test('an album skipped past its last track elsewhere still finishes', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const session = playing(item)
  const stopped = snapshot({ paused: true, positionMs: 0, at: 5_000 })
  const local = snapshot({
    trackUri: 'spotify:track:last',
    positionMs: 30_000,
    hasNext: false,
  })
  assert.equal(stepSession(session, local, stopped).event, 'finished')
  const remote = { ...local, hasNext: null, trackNumber: 3 }
  const reset = { ...stopped, hasNext: null, trackNumber: 1, discNumber: 1 }
  assert.equal(stepSession(session, remote, reset).event, 'finished')
  // Stopping on a later track is not the album's reset.
  assert.equal(
    stepSession(session, remote, { ...reset, trackNumber: 2 }).event,
    'none',
  )
  assert.equal(
    stepSession(session, { ...local, hasNext: true }, stopped).event,
    'none',
  )
})

test('a remote device without a track window uses the reset to track one', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const session = playing(item)
  const last = snapshot({
    trackUri: 'spotify:track:last',
    positionMs: 196_000,
    hasNext: null,
    trackNumber: 3,
    at: 0,
  })
  const reset = snapshot({
    paused: true,
    positionMs: 0,
    hasNext: null,
    trackNumber: 1,
    discNumber: 1,
    at: 5_000,
  })
  assert.equal(stepSession(session, last, reset).event, 'finished')
  assert.equal(
    stepSession(session, last, { ...reset, trackNumber: 2 }).event,
    'none',
  )
  const single = playing({ ...item, trackCount: 1 })
  const only = { ...last, trackUri: 'spotify:track:first', trackNumber: 1 }
  assert.equal(stepSession(single, only, reset).event, 'finished')
  assert.equal(stepSession(session, only, reset).event, 'none')
})

test('distinguishes running out into other playback from being replaced', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const session = playing(item)
  const elsewhere = snapshot({
    trackUri: 'spotify:track:other',
    contextUri: 'spotify:playlist:other',
    at: 4_000,
  })
  const last = snapshot({ positionMs: 199_000, hasNext: false, at: 2_000 })
  assert.equal(stepSession(session, last, elsewhere).event, 'finished')
  const middle = snapshot({ positionMs: 40_000, at: 2_000 })
  assert.equal(stepSession(session, middle, elsewhere).event, 'left')
  assert.equal(stepSession(session, null, elsewhere).event, 'left')
})

test('a skip at the end of the item counts as finishing it', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const session = playing(item)
  const last = snapshot({ positionMs: 20_000, hasNext: false, at: 1_000 })
  const stopped = snapshot({ paused: true, positionMs: 0, at: 3_000 })
  assert.equal(stepSession(session, last, stopped, 2_000).event, 'finished')
  assert.equal(stepSession(session, last, stopped, null).event, 'none')
  assert.equal(
    stepSession(session, last, { ...stopped, at: 20_000 }, 2_000).event,
    'none',
  )
})

test('a track session follows the requested or substituted recording', () => {
  const track = trackPlayable(album, { externalId: trackId, title: 'Second' })
  assert.ok(track)
  const session = startSession(track, 0)
  const direct = snapshot({ trackUri, contextUri: null, at: 500 })
  const started = stepSession(session, null, direct)
  assert.equal(started.session.phase, 'playing')
  assert.equal(started.session.anchorUri, trackUri)
  const linked = snapshot({
    trackUri: 'spotify:track:substitute',
    linkedFromUri: trackUri,
    contextUri: null,
    at: 500,
  })
  assert.equal(
    stepSession(session, null, linked).session.anchorUri,
    'spotify:track:substitute',
  )
  const unlinked = { ...linked, linkedFromUri: null, positionMs: 400 }
  assert.equal(stepSession(session, null, unlinked).session.phase, 'starting')
  const later = { ...unlinked, positionMs: 3_200, at: 3_500 }
  assert.equal(stepSession(session, null, later).session.phase, 'playing')
  // Older playback that never changed is not mistaken for the request.
  const stale = { ...unlinked, positionMs: 90_000, at: 3_500 }
  assert.equal(stepSession(session, null, stale).session.phase, 'starting')
  assert.equal(
    stepSession(session, null, { ...stale, at: 12_000 }).event,
    'left',
  )

  const active = playing(track, trackUri)
  assert.equal(sessionContains(active, direct), true)
  const end = snapshot({
    trackUri,
    contextUri: null,
    positionMs: 199_500,
    hasNext: true,
    at: 0,
  })
  const stopped = { ...end, paused: true, positionMs: 0, at: 1_000 }
  assert.equal(stepSession(active, end, stopped).event, 'finished')
  const next = snapshot({
    trackUri: 'spotify:track:next',
    contextUri: null,
    at: 1_000,
  })
  assert.equal(stepSession(active, end, next).event, 'finished')
  assert.equal(
    stepSession(active, { ...end, positionMs: 5_000 }, next).event,
    'left',
  )
})
