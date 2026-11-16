import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobBatchEntry } from '@repo/schemas/job'
import { ProviderOverviewItemSchema } from '@repo/schemas/provider'
import {
  batchResult,
  batchStatus,
  batchTarget,
  formatWhen,
  jobBatchHref,
  jobStatus,
} from './job-entries'
import {
  blockedQueuedJobs,
  isBlockingWait,
  providerNeedsAttention,
  providerQueueStatus,
  waitingLabel,
} from './provider-health'

const now = new Date('2026-11-16T12:00:00')
const batch: JobBatchEntry = {
  kind: 'batch',
  batchId: 'batch-1',
  provider: null,
  providers: ['first', 'second'],
  mediaType: null,
  label: null,
  importId: null,
  total: 1,
  matching: 1,
  queued: 1,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  createdAt: '2026-11-16T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  waiting: { reason: 'queued', until: null, detail: 'Waiting its turn' },
}

test('queued work waits only when a provider blocks it', () => {
  assert.equal(isBlockingWait('queued'), false)
  assert.equal(isBlockingWait('concurrency'), false)
  assert.equal(isBlockingWait(null), false)
  assert.equal(isBlockingWait('cooldown'), true)
  assert.equal(batchStatus(batch), 'queued')
  assert.equal(
    batchStatus({
      ...batch,
      waiting: { reason: 'budget', until: null, detail: 'Budget used' },
    }),
    'waiting',
  )
  assert.equal(batchStatus({ ...batch, running: 1 }), 'running')
  assert.equal(batchStatus({ ...batch, queued: 0, failed: 1 }), 'failed')
  assert.equal(batchStatus({ ...batch, queued: 0, succeeded: 1 }), 'done')
  assert.equal(
    jobStatus({
      status: 'queued',
      waiting: { reason: 'paused', until: null, detail: 'Paused' },
    }),
    'waiting',
  )
  assert.equal(jobStatus({ status: 'succeeded', waiting: null }), 'done')
})

test('batch cells name the count and say when work resumes and what failed', () => {
  assert.equal(batchTarget(batch), '1 job')
  assert.equal(batchTarget({ total: 1200, mediaType: 'album' }), '1,200 albums')
  assert.equal(
    batchResult(
      {
        ...batch,
        failed: 2,
        waiting: {
          reason: 'cooldown',
          until: '2026-11-16T14:20:00',
          detail: 'Cooling down',
        },
      },
      now,
    ),
    'Resumes 14:20 · 2 failed',
  )
  assert.equal(
    waitingLabel({
      reason: 'not-configured',
      until: null,
      detail: 'No plugin',
    }),
    'No plugin',
  )
})

test('past times read as clock time today and a date before', () => {
  assert.equal(formatWhen('2026-11-16T09:05:00', now), '09:05')
  assert.equal(formatWhen('2026-11-15T09:05:00', now), '2026-11-15')
})

test('provider health counts blocked queues and providers needing the owner', () => {
  const provider = ProviderOverviewItemSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    description: 'Synthetic',
    group: 'metadata',
    roles: ['album'],
    connection: { state: 'connected', method: 'key', detail: null },
    queue: {
      state: 'waiting',
      reason: 'cooldown',
      until: '2026-11-16T14:20:00.000Z',
      detail: 'Cooling down',
    },
    jobs: { queued: 38, running: 0, failed: 2, attention: 2 },
    lastSuccessAt: null,
    requests24h: Array.from({ length: 24 }, () => 0),
    budget: null,
    runsOn: 'server',
    worker: null,
    concurrency: 1,
  })
  const idle = ProviderOverviewItemSchema.parse({
    ...provider,
    queue: { state: 'idle', reason: null, until: null, detail: null },
    jobs: { queued: 0, running: 0, failed: 0, attention: 0 },
  })
  assert.equal(blockedQueuedJobs([provider, idle]), 38)
  assert.equal(providerQueueStatus(provider, now).state, 'waiting')
  assert.match(providerQueueStatus(provider, now).label, /^Until /)
  assert.deepEqual(providerQueueStatus(idle, now), {
    state: 'done',
    label: 'Idle',
    title: undefined,
  })
  assert.equal(providerNeedsAttention(provider), false)
  assert.equal(
    providerNeedsAttention({
      ...idle,
      connection: { state: 'needs-key', method: 'key', detail: null },
    }),
    true,
  )
})

test('a job links to its batch only when it has one', () => {
  assert.equal(
    jobBatchHref({ options: { batchId: 'batch 1' } }),
    '/jobs?batchId=batch%201',
  )
  assert.equal(jobBatchHref({ options: {} }), null)
  assert.equal(jobBatchHref({ options: { batchId: 7 } }), null)
})
