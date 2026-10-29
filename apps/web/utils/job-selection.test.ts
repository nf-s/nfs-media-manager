import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Job } from '@repo/schemas/job'
import {
  canDismissJob,
  canCancelJob,
  canRetryJob,
  unfinishedJobItems,
  updateJobSelection,
} from './job-selection'

function jobItem(
  status: Job['status'],
  mediaItemId: string | null = 'film',
): Job['items'][number] {
  return {
    id: `item-${status}`,
    mediaItemId,
    mediaTitle: null,
    mediaType: 'film',
    provider: 'example',
    status,
    attemptCount: 1,
    message: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  }
}

const failedJob: Job = {
  id: 'failed-job',
  provider: 'example',
  status: 'failed',
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  errorMessage: null,
  scope: { mediaItemIds: ['film'], mediaType: 'film', limit: 5 },
  options: {},
  confirmBroadRun: false,
  items: [jobItem('failed')],
  logs: [],
}

test('retry includes running jobs; dismissal and cancellation keep distinct eligibility', () => {
  const statuses: Job['status'][] = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
  ]
  for (const status of statuses) {
    const job = { ...failedJob, status }
    const eligible = status === 'failed' || status === 'cancelled'
    assert.equal(canRetryJob(job), eligible || status === 'running', status)
    assert.equal(canDismissJob(job), eligible, status)
    assert.equal(
      canCancelJob(job),
      status === 'queued' || status === 'running',
      status,
    )
  }
})

test('unfinished items count only failed or cancelled items with media IDs', () => {
  assert.equal(
    unfinishedJobItems({
      ...failedJob,
      items: [
        jobItem('failed'),
        jobItem('cancelled'),
        jobItem('succeeded'),
        jobItem('queued'),
        jobItem('running'),
        jobItem('failed', null),
        jobItem('cancelled', null),
        jobItem('failed', ''),
      ],
    }),
    2,
  )
  assert.equal(unfinishedJobItems({ ...failedJob, items: [] }), 0)
})

test('retry requires unfinished media items and no existing retry', () => {
  for (const items of [[], [jobItem('succeeded')], [jobItem('failed', null)]]) {
    assert.equal(canRetryJob({ ...failedJob, items }), false)
    assert.equal(canDismissJob({ ...failedJob, items }), true)
  }
  assert.equal(
    canRetryJob({ ...failedJob, items: [jobItem('cancelled')] }),
    true,
  )
  const retried = { ...failedJob, options: { retryJobId: 'retry-job' } }
  assert.equal(canRetryJob(retried), false)
  assert.equal(canDismissJob(retried), true)
})

test('valid dismissal prevents dismissing again without disabling retry', () => {
  const dismissed = {
    ...failedJob,
    options: {
      dismissal: { dismissedAt: '2026-01-01T00:00:00.000Z', userId: null },
    },
  }
  assert.equal(canDismissJob(dismissed), false)
  assert.equal(canRetryJob(dismissed), true)
  const invalidDismissals: Job['options'][string][] = [
    null,
    true,
    {},
    { dismissedAt: 'invalid', userId: null },
  ]
  for (const dismissal of invalidDismissals) {
    assert.equal(canDismissJob({ ...failedJob, options: { dismissal } }), true)
  }
})

const rows = ['a', 'b', 'c', 'd', 'e']

test('running jobs expose unfinished running and queued items for selected retry', () => {
  const running: Job = {
    ...failedJob,
    status: 'running',
    items: [jobItem('running'), jobItem('queued'), jobItem('succeeded')],
  }
  assert.equal(canRetryJob(running), true)
  assert.equal(unfinishedJobItems(running), 2)
})

test('ordinary click toggles one row without replacing other selections', () => {
  assert.deepEqual(updateJobSelection(['a'], rows, 'c', 'a', false, true), [
    'a',
    'c',
  ])
  assert.deepEqual(
    updateJobSelection(['a', 'c'], rows, 'c', 'a', false, false),
    ['a'],
  )
})

test('shift selects inclusive forward and reverse ranges', () => {
  assert.deepEqual(updateJobSelection(['b'], rows, 'd', 'b', true, true), [
    'b',
    'c',
    'd',
  ])
  assert.deepEqual(
    new Set(updateJobSelection(['d'], rows, 'b', 'd', true, true)),
    new Set(['b', 'c', 'd']),
  )
})

test('shift deselection removes only the inclusive range', () => {
  assert.deepEqual(updateJobSelection(rows, rows, 'd', 'b', true, false), [
    'a',
    'e',
  ])
  assert.deepEqual(updateJobSelection(rows, rows, 'b', 'd', true, false), [
    'a',
    'e',
  ])
})

test('shift ranges have no 100-job selection cap in either direction', () => {
  const ids = Array.from({ length: 251 }, (_, index) => `job-${index}`)
  assert.deepEqual(
    updateJobSelection([], ids, 'job-250', 'job-0', true, true),
    ids,
  )
  assert.deepEqual(
    updateJobSelection([], ids, 'job-0', 'job-250', true, true),
    ids,
  )
  assert.deepEqual(
    updateJobSelection(ids, ids, 'job-0', 'job-250', true, false),
    [],
  )
  assert.equal(
    updateJobSelection(ids, [...ids, 'next'], 'next', null, false, true).length,
    252,
  )
})

test('ineligible targets cannot be selected or deselected and inputs stay unchanged', () => {
  const selected = ['a', 'c']
  const eligible = ['a', 'b', 'd', 'e']
  for (const checked of [true, false]) {
    assert.deepEqual(
      updateJobSelection(selected, eligible, 'c', 'a', true, checked),
      selected,
    )
  }
  assert.deepEqual(
    updateJobSelection(selected, eligible, 'd', 'a', true, true),
    ['a', 'c', 'b', 'd'],
  )
  assert.deepEqual(selected, ['a', 'c'])
  assert.deepEqual(eligible, ['a', 'b', 'd', 'e'])
})

test('ranges follow current displayed IDs, skip ineligible jobs and preserve other choices', () => {
  assert.deepEqual(
    updateJobSelection(['e', 'a'], ['d', 'b', 'a'], 'd', 'a', true, true),
    ['e', 'a', 'd', 'b'],
  )
})

test('a missing anchor falls back to one row and a missing target does nothing', () => {
  assert.deepEqual(updateJobSelection([], rows, 'b', 'removed', true, true), [
    'b',
  ])
  assert.deepEqual(
    updateJobSelection(['a'], rows, 'removed', 'a', true, true),
    ['a'],
  )
})
