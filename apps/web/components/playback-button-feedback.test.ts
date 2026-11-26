import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlayableItem, PlaybackSnapshot } from '@/utils/playback'
import { idlePlaybackState } from '@/utils/playback-engine'
import {
  createPlaybackButtonFeedback,
  playButtonRequest,
  queueButtonRequest,
} from './playback-button-feedback'

const track: PlayableItem = {
  kind: 'track',
  uri: 'spotify:track:1234567890ABCDEFGHIJKL',
  title: 'Synthetic track',
  artist: 'Synthetic artist',
  albumId: null,
  albumTitle: '',
  artworkUrl: null,
  trackCount: null,
}

const snapshot: PlaybackSnapshot = {
  trackUri: track.uri,
  linkedFromUri: null,
  trackName: track.title,
  artists: track.artist,
  albumName: '',
  albumUri: null,
  artistLinks: [],
  artworkUrl: null,
  durationMs: 200_000,
  positionMs: 1_000,
  paused: false,
  contextUri: null,
  hasNext: false,
  trackNumber: 1,
  discNumber: 1,
  at: 1000,
}

test('Play records one request and confirms it from the actual device report', () => {
  const store = createPlaybackButtonFeedback()
  try {
    store.observe(idlePlaybackState)
    let sends = 0
    const send = () => {
      sends += 1
    }
    store.run('play', playButtonRequest(track), send)
    store.run('play', playButtonRequest(track), send)
    assert.equal(sends, 1)
    assert.deepEqual(store.get('play'), {
      phase: 'pending',
      label: 'Starting…',
    })
    const accepted = {
      ...idlePlaybackState,
      current: track,
      starting: true,
      startAccepted: true,
    }
    store.observe(accepted)
    assert.deepEqual(store.get('play'), {
      phase: 'running',
      label: 'Accepted · waiting for device',
    })
    const expected = { ...accepted, snapshot, starting: false }
    store.observe(expected)
    assert.equal(store.get('play')?.phase, 'running')
    store.observe({
      ...expected,
      observation: { snapshot, target: idlePlaybackState.target },
    })
    assert.deepEqual(store.get('play'), { phase: 'done', label: 'Playing' })
  } finally {
    store.clear()
  }
})

test('both deliberate duplicate queue entries work while save confirmation is pending', () => {
  const store = createPlaybackButtonFeedback()
  try {
    store.observe(idlePlaybackState)
    let sends = 0
    const add = queueButtonRequest(
      (next, before) => next.queue.length > before.queue.length,
      'Queued in app',
    )
    const enqueue = () => {
      sends += 1
      store.observe({
        ...idlePlaybackState,
        queue: Array.from({ length: sends }, (_, index) => ({
          key: `queue-${index}`,
          item: track,
        })),
        queueSync: 'pending',
      })
    }
    store.run('queue', add, enqueue)
    store.run('queue', add, enqueue)
    assert.equal(sends, 2)
    assert.deepEqual(store.get('queue'), {
      phase: 'running',
      label: 'Queued in app · syncing…',
    })
    store.observe({
      ...idlePlaybackState,
      queue: [
        { key: 'queue-0', item: track },
        { key: 'queue-1', item: track },
      ],
      queueSync: 'unconfirmed',
    })
    assert.deepEqual(store.get('queue'), {
      phase: 'unconfirmed',
      label: 'Queued in app · sync unconfirmed',
    })
  } finally {
    store.clear()
  }
})
