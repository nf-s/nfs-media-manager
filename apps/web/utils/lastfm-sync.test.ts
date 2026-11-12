import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LastfmSyncStatusSchema,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
import { MIN_STEP_INTERVAL_MS, driveLastfmSync, waitFor } from './lastfm-sync'

function status(state: LastfmSyncStatus['state'], pagesFetched: number) {
  return LastfmSyncStatusSchema.parse({
    configured: true,
    state,
    pagesFetched,
    totalPages: 3,
    newScrobbles: pagesFetched * 200,
    storedScrobbles: pagesFetched * 200,
    matchedScrobbles: 0,
    startedAt: '2026-01-01T00:00:00Z',
    lastCompletedAt: null,
    errorMessage: null,
  })
}

test('steps one at a time until the sync leaves running', async () => {
  const responses = [
    status('running', 1),
    status('running', 2),
    status('complete', 3),
  ]
  const seen: number[] = []
  const waits: number[] = []
  let clock = 0
  let inFlight = 0
  await driveLastfmSync({
    signal: new AbortController().signal,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    step: async () => {
      inFlight += 1
      assert.equal(inFlight, 1)
      clock += 500
      const next = responses.shift()
      inFlight -= 1
      if (!next) throw new Error('Stepped after completion')
      return next
    },
    onStatus: (next) => seen.push(next.pagesFetched),
  })
  assert.deepEqual(seen, [1, 2, 3])
  assert.deepEqual(waits, [
    MIN_STEP_INTERVAL_MS - 500,
    MIN_STEP_INTERVAL_MS - 500,
  ])
})

test('long steps continue immediately without an extra wait', async () => {
  const responses = [status('running', 1), status('stopped', 1)]
  const waits: number[] = []
  let clock = 0
  await driveLastfmSync({
    signal: new AbortController().signal,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms)
    },
    step: async () => {
      clock += 20_000
      const next = responses.shift()
      if (!next) throw new Error('Stepped after stop')
      return next
    },
    onStatus: () => {},
  })
  assert.deepEqual(waits, [])
})

test('aborting stops the loop and ignores the in-flight response', async () => {
  const controller = new AbortController()
  const seen: LastfmSyncStatus[] = []
  let steps = 0
  await driveLastfmSync({
    signal: controller.signal,
    wait: async () => {},
    step: async () => {
      steps += 1
      controller.abort()
      return status('running', 1)
    },
    onStatus: (next) => seen.push(next),
  })
  assert.equal(steps, 1)
  assert.deepEqual(seen, [])
})

test('step failures propagate so the page can stop and offer a retry', async () => {
  await assert.rejects(
    driveLastfmSync({
      signal: new AbortController().signal,
      wait: async () => {},
      step: async () => {
        throw new Error('Last.fm unavailable')
      },
      onStatus: () => {},
    }),
    /Last\.fm unavailable/,
  )
})

test('waiting resolves early when aborted', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = waitFor(10_000, controller.signal)
  controller.abort()
  await pending
  assert.ok(Date.now() - started < 1000)
})
