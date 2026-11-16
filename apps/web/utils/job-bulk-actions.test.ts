import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BulkCancelJobsSchema,
  JobSchema,
  type BulkCancelJobsInput,
  type BulkCancelJobsResult,
  type Job,
} from '@repo/schemas/job'
import {
  dispatchBatchCancellation,
  dispatchJobAction,
  dispatchJobCancellation,
  jobActionSummary,
  jobReviewKey,
  type JobActionResult,
} from './job-bulk-actions'

function job(id: string, status: Job['status']): Job {
  return JobSchema.parse({
    id,
    status,
    provider: 'fixture',
    createdAt: '2026-01-01',
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    scope: {},
    options: {},
    confirmBroadRun: false,
    logs: [],
    items: [],
  })
}

function cancelled(jobIds: string[]): BulkCancelJobsResult {
  return {
    cancelled: jobIds.length,
    skipped: 0,
    results: jobIds.map((jobId) => ({ jobId, status: 'cancelled' })),
  }
}

test('queued cancellation sends the shared false-confirmation contract in serial chunks', async () => {
  const jobs = Array.from({ length: 251 }, (_, i) =>
    job(`queued-${i}`, 'queued'),
  )
  const calls: BulkCancelJobsInput[] = []
  const progress: number[] = []
  const result = await dispatchJobCancellation(
    [...jobs, ...jobs],
    false,
    async (input) => {
      calls.push(BulkCancelJobsSchema.parse(input))
      return cancelled(input.jobIds)
    },
    (processed) => progress.push(processed),
  )
  assert.deepEqual(
    calls.map((input) => input.jobIds.length),
    [100, 100, 51],
  )
  assert.ok(calls.every((input) => input.confirmRunning === false))
  assert.deepEqual(
    calls.flatMap((input) => input.jobIds),
    jobs.map((job) => job.id),
  )
  assert.deepEqual(progress, [100, 200, 251])
  assert.equal(result.results.length, 251)
})

test('running-only and mixed cancellation cannot dispatch without explicit confirmation', async () => {
  for (const jobs of [
    [job('running', 'running')],
    [job('queued', 'queued'), job('running', 'running')],
  ]) {
    let calls = 0
    await assert.rejects(
      dispatchJobCancellation(
        jobs,
        false,
        async (input) => {
          calls += 1
          return cancelled(input.jobIds)
        },
        () => {},
      ),
      /Confirm stopping running jobs/,
    )
    assert.equal(calls, 0)
    const result = await dispatchJobCancellation(
      jobs,
      true,
      async (input) => {
        assert.equal(BulkCancelJobsSchema.parse(input).confirmRunning, true)
        return cancelled(input.jobIds)
      },
      () => {},
    )
    assert.deepEqual(
      result.results.map((entry) => entry.jobId),
      jobs.map((job) => job.id),
    )
  }
})

test('queued-to-running skips remain visible without resubmission or broader consent', async () => {
  const jobs = Array.from({ length: 101 }, (_, i) =>
    job(`queued-${i}`, 'queued'),
  )
  const calls: BulkCancelJobsInput[] = []
  const message = 'Job is now running. Confirm stopping running jobs.'
  const result = await dispatchJobCancellation(
    jobs,
    false,
    async (input) => {
      calls.push(input)
      for (const job of jobs) job.status = 'running'
      return {
        cancelled: 0,
        skipped: input.jobIds.length,
        results: input.jobIds.map((jobId) => ({
          jobId,
          status: 'skipped',
          message,
        })),
      }
    },
    () => {},
  )
  assert.equal(calls.length, 2)
  assert.ok(calls.every((input) => input.confirmRunning === false))
  assert.equal(result.results.length, 101)
  assert.ok(
    result.results.every(
      (entry) => entry.status === 'skipped' && entry.message === message,
    ),
  )
})

test('terminal and empty cancellations send nothing; queued-only never broadens consent', async () => {
  const terminal = [
    job('done', 'succeeded'),
    job('failed', 'failed'),
    job('cancelled', 'cancelled'),
  ]
  for (const jobs of [[], terminal]) {
    let calls = 0
    const result = await dispatchJobCancellation(
      jobs,
      true,
      async (input) => {
        calls += 1
        return cancelled(input.jobIds)
      },
      () => {},
    )
    assert.equal(calls, 0)
    assert.deepEqual(result.results, [])
  }
  await dispatchJobCancellation(
    [...terminal, job('queued', 'queued')],
    true,
    async (input) => {
      assert.deepEqual(input, { jobIds: ['queued'], confirmRunning: false })
      return cancelled(input.jobIds)
    },
    () => {},
  )
})

test('empty selection sends no requests and reports no progress', async () => {
  let calls = 0
  const progress: number[] = []
  const result = await dispatchJobAction(
    [],
    async () => {
      calls += 1
      return { results: [] }
    },
    (processed) => progress.push(processed),
  )
  assert.deepEqual(result, { results: [] })
  assert.equal(calls, 0)
  assert.deepEqual(progress, [])
})

for (const count of [1, 100, 101, 200, 251]) {
  test(`dispatches ${count} jobs in serial chunks of at most 100`, async () => {
    const ids = Array.from({ length: count }, (_, index) => `job-${index}`)
    const calls: string[][] = []
    const events: string[] = []
    const progress: number[] = []
    const result = await dispatchJobAction(
      ids,
      async (chunk) => {
        const index = calls.length
        calls.push([...chunk])
        events.push(`start-${index}`)
        await Promise.resolve()
        events.push(`end-${index}`)
        return {
          results: chunk.map<JobActionResult>((jobId) => ({
            jobId,
            status: 'queued',
            retryJobId: `retry-${jobId}`,
          })),
        }
      },
      (processed) => {
        events.push(`progress-${processed}`)
        progress.push(processed)
      },
    )
    const expectedChunks = []
    const expectedEvents = []
    const expectedProgress = []
    for (let offset = 0; offset < count; offset += 100) {
      expectedChunks.push(ids.slice(offset, offset + 100))
      const processed = Math.min(offset + 100, count)
      expectedProgress.push(processed)
      expectedEvents.push(
        `start-${offset / 100}`,
        `end-${offset / 100}`,
        `progress-${processed}`,
      )
    }
    assert.deepEqual(calls, expectedChunks)
    assert.deepEqual(events, expectedEvents)
    assert.deepEqual(progress, expectedProgress)
    assert.deepEqual(
      result.results,
      ids.map((jobId) => ({
        jobId,
        status: 'queued',
        retryJobId: `retry-${jobId}`,
      })),
    )
  })
}

test('deduplicates IDs across chunk boundaries while preserving first-seen order', async () => {
  const unique = Array.from({ length: 101 }, (_, index) => `job-${index}`)
  const ids = [...unique, ...unique, 'job-0']
  const original = [...ids]
  const calls: string[][] = []
  const progress: number[] = []
  const result = await dispatchJobAction(
    ids,
    async (chunk) => {
      calls.push(chunk)
      return {
        results: chunk.map<JobActionResult>((jobId) => ({
          jobId,
          status: 'dismissed',
        })),
      }
    },
    (processed) => progress.push(processed),
  )
  assert.deepEqual(calls, [unique.slice(0, 100), unique.slice(100)])
  assert.deepEqual(progress, [100, 101])
  assert.deepEqual(
    result.results.map((entry) => entry.jobId),
    unique,
  )
  assert.deepEqual(ids, original)
})

test('per-job failures and skips retain their details and do not stop later chunks', async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `job-${index}`)
  const statuses: JobActionResult['status'][] = [
    'queued',
    'dismissed',
    'cancelled',
    'skipped',
    'failed',
  ]
  const expected = ids.map<JobActionResult>((jobId, index) => ({
    jobId,
    status: statuses[index % statuses.length] ?? 'failed',
    message: `result-${jobId}`,
  }))
  let calls = 0
  const result = await dispatchJobAction(
    ids,
    async (chunk) => {
      calls += 1
      return {
        results: expected.filter((entry) => chunk.includes(entry.jobId)),
      }
    },
    () => {},
  )
  assert.equal(calls, 2)
  assert.deepEqual(result, { results: expected })
})

test('transport errors stop dispatch, retain prior results and distinguish unknown from unsubmitted jobs', async () => {
  const ids = Array.from({ length: 251 }, (_, index) => `job-${index}`)
  const retained: JobActionResult[] = ids
    .slice(0, 100)
    .map((jobId) => ({ jobId, status: 'dismissed' }))
  const calls: string[][] = []
  const progress: number[] = []
  const result = await dispatchJobAction(
    ids,
    async (chunk) => {
      calls.push(chunk)
      if (calls.length === 2) throw new Error('connection lost')
      return { results: retained }
    },
    (processed) => progress.push(processed),
  )
  assert.deepEqual(calls, [ids.slice(0, 100), ids.slice(100, 200)])
  assert.deepEqual(progress, [100])
  assert.deepEqual(result.results.slice(0, 100), retained)
  assert.deepEqual(
    result.results.slice(100, 200),
    ids.slice(100, 200).map((jobId) => ({
      jobId,
      status: 'failed',
      message:
        'Could not confirm this action. Check job status before trying again.',
    })),
  )
  assert.deepEqual(
    result.results.slice(200),
    ids.slice(200).map((jobId) => ({
      jobId,
      status: 'failed',
      message: 'Not submitted because the previous request failed.',
    })),
  )
})

test('batch cancellation sends one request per batch and confirms running work only where the review showed it', async () => {
  const sent: [string, boolean][] = []
  const progress: number[] = []
  const result = await dispatchBatchCancellation(
    [
      { batchId: 'with-running', running: 2 },
      { batchId: 'queued-only', running: 0 },
    ],
    true,
    async (batchId, input) => {
      sent.push([batchId, input.confirmRunning])
      return cancelled([`${batchId}-1`, `${batchId}-2`])
    },
    (processed) => progress.push(processed),
  )
  assert.deepEqual(sent, [
    ['with-running', true],
    ['queued-only', false],
  ])
  assert.deepEqual(progress, [2, 4])
  assert.equal(result.results.length, 4)
  const unconfirmed: boolean[] = []
  await dispatchBatchCancellation(
    [{ batchId: 'with-running', running: 2 }],
    false,
    async (_batchId, input) => {
      unconfirmed.push(input.confirmRunning)
      return cancelled([])
    },
    () => {},
  )
  assert.deepEqual(unconfirmed, [false])
})

test('a review resets when a selected batch starts or stops running jobs', () => {
  const selected = [job('queued', 'queued')]
  const key = (running: number) =>
    jobReviewKey('cancel', selected, selected, [
      { batchId: 'batch-1', running },
    ])
  // Opened with nothing running, Confirm must not stop jobs started since.
  assert.notEqual(key(0), key(2))
  assert.notEqual(key(2), key(1))
  assert.equal(key(2), key(2))
  assert.notEqual(
    jobReviewKey('cancel', selected, selected, []),
    jobReviewKey('cancel', [job('queued', 'running')], selected, []),
  )
  assert.notEqual(
    jobReviewKey('cancel', selected, selected, []),
    jobReviewKey('dismiss', selected, selected, []),
  )
})

test('a failed batch request is reported and the remaining batches are still sent', async () => {
  const sent: string[] = []
  const progress: number[] = []
  const outcome = await dispatchBatchCancellation(
    [
      { batchId: 'first', running: 0 },
      { batchId: 'broken', running: 0 },
      { batchId: 'last', running: 0 },
    ],
    false,
    async (batchId) => {
      sent.push(batchId)
      if (batchId === 'broken') throw new Error('connection lost')
      return cancelled([`${batchId}-1`])
    },
    (processed) => progress.push(processed),
  )
  assert.deepEqual(sent, ['first', 'broken', 'last'])
  assert.deepEqual(progress, [1, 2])
  assert.deepEqual(
    outcome.results.map((entry) => entry.jobId),
    ['first-1', 'last-1'],
  )
  assert.deepEqual(outcome.failedBatches, [
    {
      batchId: 'broken',
      message:
        'Could not confirm this action. Check batch status before trying again.',
    },
  ])
})

test('the result line counts each status and names batches that were not cancelled', () => {
  assert.equal(
    jobActionSummary({
      results: [
        { jobId: 'a', status: 'cancelled' },
        { jobId: 'b', status: 'cancelled' },
        { jobId: 'c', status: 'failed' },
        { jobId: 'd', status: 'skipped' },
      ],
      failedBatches: [],
    }),
    '2 cancelled · 1 skipped · 1 need review.',
  )
  assert.equal(
    jobActionSummary({
      results: [{ jobId: 'a', status: 'cancelled' }],
      failedBatches: [
        { batchId: 'x', message: 'failed' },
        { batchId: 'y', message: 'failed' },
      ],
    }),
    '1 cancelled · 2 batches not cancelled.',
  )
  assert.equal(
    jobActionSummary({
      results: [],
      failedBatches: [{ batchId: 'x', message: 'failed' }],
    }),
    '1 batch not cancelled.',
  )
})
