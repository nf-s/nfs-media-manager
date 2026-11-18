import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import type { LastfmPlay, LastfmScrobbleResult } from '@repo/schemas/lastfm'
import { createScrobbleReporter } from './scrobble-reporter'

function play(index: number): LastfmPlay {
  return {
    trackUri: `spotify:track:${String(index).padStart(22, '0')}`,
    track: `Track ${index}`,
    artist: 'Fixture artist',
    album: 'Fixture album',
    durationMs: 200_000,
    startedAt: 1_800_000_000_000 + index * 200_000,
  }
}

const taken: LastfmScrobbleResult = {
  connected: true,
  accepted: 1,
  scrobbled: 1,
  waiting: 0,
}

function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

test('plays are sent as they are reported, at most 50 at a time', async () => {
  const sent: LastfmPlay[][] = []
  const reporter = createScrobbleReporter({
    send: async (plays) => {
      sent.push(plays)
      return taken
    },
  })
  reporter.report([play(1)])
  await settle()
  assert.deepEqual(sent, [[play(1)]])
  reporter.report(Array.from({ length: 60 }, (_, index) => play(index + 2)))
  await settle()
  await settle()
  assert.deepEqual(
    sent.map((plays) => plays.length),
    [1, 50, 10],
  )
  reporter.dispose()
})

test('a play that is not a Spotify track with a name and artist is left out', async () => {
  const sent: LastfmPlay[][] = []
  const reporter = createScrobbleReporter({
    send: async (plays) => {
      sent.push(plays)
      return taken
    },
  })
  reporter.report([
    { ...play(1), trackUri: 'spotify:episode:fixture' },
    { ...play(2), artist: ' ' },
  ])
  await settle()
  assert.deepEqual(sent, [])
  reporter.dispose()
})

test('plays are kept and sent again when the server cannot be reached', async () => {
  const sent: LastfmPlay[][] = []
  let failing = true
  const reporter = createScrobbleReporter({
    send: async (plays) => {
      sent.push(plays)
      if (failing) throw new Error('offline')
      return taken
    },
    retryMs: 1_000,
  })
  reporter.report([play(1)])
  await settle()
  reporter.report([play(2)])
  await settle()
  assert.deepEqual(sent, [[play(1)], [play(1), play(2)]])
  failing = false
  mock.timers.tick(1_000)
  await settle()
  assert.deepEqual(sent.at(-1), [play(1), play(2)])
  const count = sent.length
  mock.timers.tick(5_000)
  await settle()
  assert.equal(sent.length, count)
  reporter.dispose()
})

test('nothing is kept once the server reports Last.fm as not connected', async () => {
  const sent: LastfmPlay[][] = []
  let disconnected = 0
  const reporter = createScrobbleReporter({
    send: async (plays) => {
      sent.push(plays)
      return { connected: false, accepted: 0, scrobbled: 0, waiting: 0 }
    },
    onDisconnected: () => {
      disconnected += 1
    },
  })
  reporter.report(Array.from({ length: 70 }, (_, index) => play(index)))
  await settle()
  await settle()
  assert.equal(sent.length, 1)
  assert.equal(disconnected, 1)
  reporter.dispose()
})
