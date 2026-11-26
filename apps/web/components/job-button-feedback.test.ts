import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobBatchEntrySchema } from '@repo/schemas/job'
import {
  jobBatchFeedback,
  jobBatchPollInterval,
  queueReceipt,
} from './job-button-feedback'

const queued = JobBatchEntrySchema.parse({
  kind: 'batch',
  batchId: 'fixture-batch',
  provider: null,
  providers: [],
  mediaType: 'film',
  label: null,
  importId: null,
  total: 4,
  matching: 4,
  queued: 4,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  createdAt: '2026-01-02T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  waiting: null,
})

test('an accepted batch keeps polling through a missing read, queue and progress', () => {
  assert.deepEqual(queueReceipt(4, 1), {
    phase: 'queued',
    label: '4 queued · 1 skipped',
  })
  assert.equal(jobBatchPollInterval(), 3000)
  assert.equal(jobBatchPollInterval(queued), 3000)
  assert.deepEqual(jobBatchFeedback(queued), {
    phase: 'queued',
    label: '4 queued',
  })
  const running = { ...queued, queued: 1, running: 1, succeeded: 2 }
  assert.equal(jobBatchPollInterval(running), 3000)
  assert.deepEqual(jobBatchFeedback(running), {
    phase: 'running',
    label: '2/4 finished',
  })
})

test('a terminal batch reports mixed outcomes and stops polling', () => {
  const partial = {
    ...queued,
    queued: 0,
    succeeded: 2,
    failed: 1,
    cancelled: 1,
  }
  assert.deepEqual(jobBatchFeedback(partial), {
    phase: 'partial',
    label: '2 completed · 1 failed · 1 cancelled',
  })
  assert.equal(jobBatchPollInterval(partial), false)
  const complete = { ...partial, succeeded: 4, failed: 0, cancelled: 0 }
  assert.deepEqual(jobBatchFeedback(complete), {
    phase: 'done',
    label: '4 completed',
  })
  assert.equal(jobBatchPollInterval(complete), false)
})
