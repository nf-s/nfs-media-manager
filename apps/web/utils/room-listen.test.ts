import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlaybackListen } from '@repo/schemas/playback'
import {
  earlierPlays,
  finishedPlays,
  hearRoom,
  listenDue,
  listenThreshold,
  type Sighting,
} from './room-listen'

const LENGTH = 200_000

function sighting(
  uri: string,
  index: number,
  positionMs: number,
  at: number,
): Sighting & { durationMs: number } {
  return { uri, index, positionMs, at, durationMs: LENGTH }
}

function listenOf(values: Partial<PlaybackListen> = {}): PlaybackListen {
  return {
    uri: 'spotify:track:one',
    startedAt: 0,
    heardMs: 0,
    durationMs: LENGTH,
    reported: false,
    ...values,
  }
}

test('a scrobble needs half of a track or four minutes, and a track over 30 seconds', () => {
  assert.equal(listenThreshold(200_000), 100_000)
  assert.equal(listenThreshold(20 * 60_000), 4 * 60_000)
  assert.equal(listenThreshold(30_000), null)
  assert.equal(listenThreshold(0), null)
  assert.equal(listenDue(listenOf({ heardMs: 99_000 })), false)
  assert.equal(listenDue(listenOf({ heardMs: 100_000 })), true)
  assert.equal(listenDue(listenOf({ heardMs: 150_000, reported: true })), false)
})

test('a track first read is credited with no more than the time since it was asked for', () => {
  const step = hearRoom(
    null,
    null,
    sighting('spotify:track:one', 0, 1_500, 10_000),
    9_000,
  )
  assert.deepEqual(step.listen, {
    uri: 'spotify:track:one',
    startedAt: 8_500,
    heardMs: 1_500,
    durationMs: LENGTH,
    reported: false,
  })
  assert.equal(step.earlier, null)
  // Started part-way through, as when playback is moved to the room.
  const moved = hearRoom(
    null,
    null,
    sighting('spotify:track:one', 0, 120_000, 10_000),
    9_000,
  )
  assert.equal(moved.listen.heardMs, 3_000)
})

test('progress between two reads is credited, a seek forward is not', () => {
  const before = sighting('spotify:track:one', 0, 10_000, 10_000)
  const played = hearRoom(
    listenOf({ heardMs: 10_000 }),
    before,
    sighting('spotify:track:one', 0, 13_000, 13_000),
    0,
  )
  assert.equal(played.listen.heardMs, 13_000)
  const sought = hearRoom(
    listenOf({ heardMs: 10_000 }),
    before,
    sighting('spotify:track:one', 0, 150_000, 13_000),
    0,
  )
  assert.equal(sought.listen.heardMs, 15_000)
  const back = hearRoom(
    listenOf({ heardMs: 10_000 }),
    before,
    sighting('spotify:track:one', 0, 2_000, 13_000),
    0,
  )
  assert.equal(back.listen.heardMs, 10_000)
  // A page that slept through part of the track still credits what played.
  const slept = hearRoom(
    listenOf({ heardMs: 10_000 }),
    before,
    sighting('spotify:track:one', 0, 130_000, 130_000),
    0,
  )
  assert.equal(slept.listen.heardMs, 130_000)
})

test('a reported track that starts again is a new listen', () => {
  const before = sighting('spotify:track:one', 0, 150_000, 150_000)
  const again = hearRoom(
    listenOf({ heardMs: 150_000, reported: true }),
    before,
    sighting('spotify:track:one', 0, 1_000, 153_000),
    0,
  )
  assert.deepEqual(again.listen, {
    uri: 'spotify:track:one',
    startedAt: 152_000,
    heardMs: 1_000,
    durationMs: LENGTH,
    reported: false,
  })
  assert.equal(again.earlier, null)
})

test('a saved listen carries on after a reload without its start being credited twice', () => {
  const saved = listenOf({ heardMs: 120_000, reported: true })
  const step = hearRoom(
    saved,
    sighting('spotify:track:one', 0, 120_000, 0),
    sighting('spotify:track:one', 0, 120_000, 1_200_000),
    0,
  )
  assert.equal(step.listen.reported, true)
  assert.equal(step.listen.startedAt, 0)
  // A page with no listen saved counts only what plays from here on.
  const fresh = hearRoom(
    null,
    sighting('spotify:track:one', 0, 120_000, 0),
    sighting('spotify:track:one', 0, 125_000, 1_200_000),
    0,
  )
  assert.equal(fresh.listen.heardMs, 5_000)
})

test('moving to the next track leaves the time not used by it to the track before', () => {
  const before = sighting('spotify:track:one', 0, 190_000, 190_000)
  const step = hearRoom(
    listenOf({ heardMs: 60_000 }),
    before,
    sighting('spotify:track:two', 1, 2_000, 202_000),
    0,
  )
  assert.equal(step.listen.uri, 'spotify:track:two')
  assert.equal(step.listen.heardMs, 2_000)
  assert.equal(step.listen.startedAt, 200_000)
  assert.deepEqual(step.earlier, {
    listen: listenOf({ heardMs: 60_000 }),
    budgetMs: 12_000,
  })
})

test('a track that ran out between two reads is reported, a skipped one is not', () => {
  const before = sighting('spotify:track:one', 0, 95_000, 95_000)
  const ranOut = earlierPlays({
    listen: listenOf({ heardMs: 95_000 }),
    before,
    beforeDurationMs: LENGTH,
    passed: [],
    budgetMs: 105_000,
    until: 200_000,
  })
  assert.deepEqual(ranOut, [{ uri: 'spotify:track:one', startedAt: 0 }])
  const skipped = earlierPlays({
    listen: listenOf({ heardMs: 95_000 }),
    before,
    beforeDurationMs: LENGTH,
    passed: [],
    budgetMs: 3_000,
    until: 98_000,
  })
  assert.deepEqual(skipped, [])
  const reported = earlierPlays({
    listen: listenOf({ heardMs: 120_000, reported: true }),
    before,
    beforeDurationMs: LENGTH,
    passed: [],
    budgetMs: 105_000,
    until: 200_000,
  })
  assert.deepEqual(reported, [])
})

test('tracks passed while nothing read the room are reported as far as the time allows', () => {
  const before = sighting('spotify:track:one', 0, 60_000, 60_000)
  const passed = [
    { uri: 'spotify:track:two', durationMs: 180_000 },
    { uri: 'spotify:track:three', durationMs: 180_000 },
  ]
  const all = earlierPlays({
    listen: listenOf({ heardMs: 60_000 }),
    before,
    beforeDurationMs: LENGTH,
    passed,
    budgetMs: 30 * 60_000,
    until: 1_000_000,
  })
  assert.deepEqual(all, [
    { uri: 'spotify:track:one', startedAt: 0 },
    { uri: 'spotify:track:two', startedAt: 640_000 },
    { uri: 'spotify:track:three', startedAt: 820_000 },
  ])
  // Four minutes are enough for the latest track and part of the one before.
  const some = earlierPlays({
    listen: listenOf({ heardMs: 60_000 }),
    before,
    beforeDurationMs: LENGTH,
    passed,
    budgetMs: 240_000,
    until: 1_000_000,
  })
  assert.deepEqual(some, [{ uri: 'spotify:track:three', startedAt: 820_000 }])
  // A track of unknown length is passed over.
  const unknown = earlierPlays({
    listen: null,
    before,
    beforeDurationMs: 0,
    passed: [{ uri: 'spotify:track:two', durationMs: 0 }],
    budgetMs: 30 * 60_000,
    until: 1_000_000,
  })
  assert.deepEqual(unknown, [])
})

test('a queue that played to its end is reported from the track last read', () => {
  const before = sighting('spotify:track:one', 0, 60_000, 60_000)
  const rest = [
    { uri: 'spotify:track:two', durationMs: 180_000 },
    { uri: 'spotify:track:three', durationMs: 180_000 },
  ]
  assert.deepEqual(
    finishedPlays({
      listen: listenOf({ heardMs: 60_000 }),
      before,
      beforeDurationMs: LENGTH,
      rest,
      budgetMs: 3 * 60 * 60_000,
    }),
    [
      { uri: 'spotify:track:one', startedAt: 0 },
      { uri: 'spotify:track:two', startedAt: 200_000 },
      { uri: 'spotify:track:three', startedAt: 380_000 },
    ],
  )
  assert.deepEqual(
    finishedPlays({
      listen: listenOf({ heardMs: 120_000, reported: true }),
      before,
      beforeDurationMs: LENGTH,
      rest,
      budgetMs: 250_000,
    }),
    [{ uri: 'spotify:track:two', startedAt: 200_000 }],
  )
})
