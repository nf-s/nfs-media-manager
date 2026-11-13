import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SubscriptionSyncStatus } from '@repo/schemas/subscriptions'
import {
  formatCount,
  formatVideoDuration,
  youtubeSyncPollInterval,
} from './youtube'

test('durations and counts use compact display forms', () => {
  assert.equal(formatVideoDuration(0), '0:00')
  assert.equal(formatVideoDuration(59), '0:59')
  assert.equal(formatVideoDuration(61), '1:01')
  assert.equal(formatVideoDuration(600), '10:00')
  assert.equal(formatVideoDuration(3600), '1:00:00')
  assert.equal(formatVideoDuration(3725), '1:02:05')
  assert.equal(formatVideoDuration(36000 + 59), '10:00:59')
  assert.equal(formatCount(null), 'Hidden')
  assert.equal(formatCount(0), '0')
})

test('polling follows the run state', () => {
  assert.equal(youtubeSyncPollInterval('running'), 3000)
  const idle: SubscriptionSyncStatus['state'][] = [
    'never',
    'paused',
    'stopped',
    'failed',
    'complete',
  ]
  for (const state of idle) assert.equal(youtubeSyncPollInterval(state), false)
  assert.equal(youtubeSyncPollInterval(null), false)
})
