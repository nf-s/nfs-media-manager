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
  rejoinVerdict,
  sessionContains,
  spotifyWebUrl,
  startIgnored,
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
    { id: null, name: 'First artist', role: 'artist', billingOrder: 0 },
    { id: null, name: 'A producer', role: 'producer', billingOrder: 1 },
    { id: null, name: 'Second artist', role: 'artist', billingOrder: 2 },
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
    albumUri: null,
    artistLinks: [],
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
    credits: [
      { id: null, name: 'First artist' },
      { id: null, name: 'Second artist' },
    ],
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
    id: 'library-track',
    artistCredits: [{ id: 'library-artist', name: 'Second artist' }],
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
    trackId: 'library-track',
    credits: [
      { id: null, name: 'First artist' },
      { id: 'library-artist', name: 'Second artist' },
    ],
  })
  const unlinked = libraryTrackPlayable({ ...track, album: null })
  assert.equal(unlinked?.albumId, null)
  assert.equal(unlinked?.albumTitle, 'Spotify album name')
  assert.deepEqual(unlinked && playRequest(unlinked), { uris: [trackUri] })
  assert.deepEqual(
    unlinked &&
      playRequest(unlinked, [{ ...unlinked, uri: 'spotify:track:next' }]),
    { uris: [trackUri, 'spotify:track:next'] },
  )
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
  // Playback carried over from another device starts where that one was.
  assert.deepEqual(playRequest(track, [], 61_500.4), {
    uris: [trackUri],
    position_ms: 61_500,
  })
  assert.deepEqual(playRequest(from, [], 2_000), {
    context_uri: albumUri,
    offset: { uri: trackUri },
    position_ms: 2_000,
  })
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
  // The track the device was already on, begun again, is not the request.
  const replacing = startSession(track, 0, 'spotify:track:substitute')
  assert.equal(stepSession(replacing, null, later).session.phase, 'starting')
  assert.equal(startIgnored(replacing, later), true)
  assert.equal(startIgnored(replacing, unlinked), false)
  assert.equal(startIgnored(replacing, stale), false)
  assert.equal(startIgnored(session, later), false)
  assert.equal(
    stepSession(replacing, null, { ...later, positionMs: 11_500, at: 12_000 })
      .event,
    'left',
  )
  assert.equal(stepSession(replacing, null, direct).session.phase, 'playing')

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

test('a saved queue is rejoined only on the same tracks, further along', () => {
  const tracks = [0, 1, 2, 3].map(
    (index): PlayableItem => ({
      kind: 'track',
      uri: `spotify:track:list-${index}`,
      title: `Track ${index}`,
      artist: 'Fixture artist',
      albumId: null,
      albumTitle: '',
      artworkUrl: null,
      trackCount: 1,
    }),
  )
  const [, second] = tracks
  assert.ok(second)
  const saved = {
    item: second,
    sent: tracks,
    index: 1,
    anchorUri: second.uri,
  }
  const at = (index: number, values: Partial<PlaybackSnapshot> = {}) =>
    snapshot({
      trackUri: `spotify:track:list-${index}`,
      contextUri: null,
      positionMs: 60_000,
      ...values,
    })
  const before = at(1, { positionMs: 40_000 })
  // Further along, playing or paused.
  assert.deepEqual(rejoinVerdict(saved, before, at(3), false), {
    verdict: 'rejoined',
    index: 3,
  })
  assert.deepEqual(
    rejoinVerdict(saved, before, at(1, { paused: true }), false),
    {
      verdict: 'rejoined',
      index: 1,
    },
  )
  // Nothing loaded, or stopped.
  assert.deepEqual(rejoinVerdict(saved, before, null, false), {
    verdict: 'ended',
  })
  assert.deepEqual(rejoinVerdict(saved, before, at(2), true), {
    verdict: 'ended',
  })
  // Back at the start of the list, stopped: it ran out.
  assert.deepEqual(
    rejoinVerdict(saved, before, at(0, { paused: true, positionMs: 0 }), false),
    { verdict: 'ended' },
  )
  // Another track, a playlist, an earlier track playing, or the saved track
  // again from its start.
  for (const other of [
    at(9),
    at(2, { contextUri: 'spotify:playlist:other' }),
    at(0),
    at(1, { positionMs: 1_000 }),
  ])
    assert.deepEqual(rejoinVerdict(saved, before, other, false), {
      verdict: 'changed',
    })
})

test('a saved album is rejoined while its context plays', () => {
  const item = albumPlayable(album)
  assert.ok(item)
  const saved = { item, sent: [item], index: 0, anchorUri: null }
  const before = snapshot({
    trackUri: 'spotify:track:second',
    trackNumber: 2,
    positionMs: 30_000,
  })
  assert.deepEqual(
    rejoinVerdict(
      saved,
      before,
      snapshot({ trackUri: 'spotify:track:third', trackNumber: 3 }),
      false,
    ),
    { verdict: 'rejoined', index: 0 },
  )
  assert.deepEqual(
    rejoinVerdict(
      saved,
      before,
      snapshot({ contextUri: 'spotify:album:another' }),
      false,
    ),
    { verdict: 'changed' },
  )
  // A finished album stops at the start of its first track.
  assert.deepEqual(
    rejoinVerdict(
      saved,
      before,
      snapshot({
        trackUri: 'spotify:track:first',
        trackNumber: 1,
        positionMs: 0,
        paused: true,
      }),
      false,
    ),
    { verdict: 'ended' },
  )
})
