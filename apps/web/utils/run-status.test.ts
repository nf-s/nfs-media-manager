import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  runStatusLabel,
  runStatusStates,
  syncStatusLabel,
  syncStatusStates,
} from './run-status'

test('runs and syncs use the shared status vocabulary', () => {
  assert.equal(runStatusStates.succeeded, 'done')
  assert.equal(runStatusLabel('succeeded'), 'Done')
  assert.equal(runStatusLabel('running'), 'Running')
  assert.equal(syncStatusStates.stopped, 'cancelled')
  assert.equal(syncStatusLabel('never'), 'Never')
  assert.equal(syncStatusLabel('complete'), 'Done')
  assert.equal(syncStatusLabel('paused'), 'Paused')
})
