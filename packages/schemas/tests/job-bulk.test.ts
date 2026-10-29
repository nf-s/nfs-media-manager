import { describe, expect, it } from 'vitest'
import {
  BulkRetryJobsSchema,
  BulkRetryJobsResultSchema,
  BulkDismissJobsSchema,
  BulkDismissJobsResultSchema,
  BulkCancelJobsSchema,
  BulkCancelJobsResultSchema,
} from '../src/job'

describe('bulk job contracts', () => {
  it('defaults cancellation to queued-only and accepts explicit running confirmation', () => {
    expect(BulkCancelJobsSchema.parse({ jobIds: ['one'] })).toEqual({
      jobIds: ['one'],
      confirmRunning: false,
    })
    for (const confirmRunning of [undefined, false])
      expect(
        BulkCancelJobsSchema.parse({ jobIds: ['one'], confirmRunning }),
      ).toEqual({ jobIds: ['one'], confirmRunning: false })
    for (const confirmRunning of ['true', 'false', 1, 0, null])
      expect(
        BulkCancelJobsSchema.safeParse({ jobIds: ['one'], confirmRunning })
          .success,
      ).toBe(false)
    expect(
      BulkCancelJobsSchema.parse({ jobIds: ['one'], confirmRunning: true }),
    ).toEqual({ jobIds: ['one'], confirmRunning: true })
    for (const jobIds of [
      [],
      ['one', 'one'],
      Array.from({ length: 101 }, (_, i) => `job-${i}`),
    ])
      expect(
        BulkCancelJobsSchema.safeParse({ jobIds, confirmRunning: true })
          .success,
      ).toBe(false)
    expect(
      BulkRetryJobsSchema.safeParse({ jobIds: ['one'], confirmRunning: 'true' })
        .success,
    ).toBe(false)
    expect(
      BulkRetryJobsSchema.parse({ jobIds: ['one'], confirmRunning: true })
        .confirmRunning,
    ).toBe(true)
  })

  it('validates partial cancellation outcomes separately from retry/dismissal', () => {
    expect(
      BulkCancelJobsResultSchema.safeParse({
        cancelled: 1,
        skipped: 1,
        results: [
          { jobId: 'one', status: 'cancelled' },
          { jobId: 'two', status: 'skipped' },
          { jobId: 'three', status: 'failed', message: 'Unable to update.' },
        ],
      }).success,
    ).toBe(true)
    expect(
      BulkCancelJobsResultSchema.safeParse({
        cancelled: 1,
        skipped: 0,
        results: [{ jobId: 'one', status: 'queued' }],
      }).success,
    ).toBe(false)
  })
  it('defaults retry confirmation to false', () => {
    expect(BulkRetryJobsSchema.parse({ jobIds: ['one'] })).toEqual({
      jobIds: ['one'],
      confirmBroadRun: false,
    })
  })

  it.each([BulkRetryJobsSchema, BulkDismissJobsSchema, BulkCancelJobsSchema])(
    'requires a unique selection of 1 to 100 nonempty IDs',
    (schema) => {
      for (const jobIds of [
        [],
        [''],
        ['one', 'one'],
        Array.from({ length: 101 }, (_, index) => `job-${index}`),
      ]) {
        expect(schema.safeParse({ jobIds }).success).toBe(false)
      }
      expect(
        schema.safeParse({
          jobIds: Array.from({ length: 100 }, (_, index) => `job-${index}`),
        }).success,
      ).toBe(true)
    },
  )

  it('accepts partial retry outcomes with optional messages and retry links', () => {
    expect(
      BulkRetryJobsResultSchema.safeParse({
        queued: 1,
        skipped: 1,
        results: [
          { jobId: 'one', status: 'queued', retryJobId: 'new-job' },
          { jobId: 'two', status: 'skipped' },
          {
            jobId: 'three',
            status: 'failed',
            message: 'Provider is cooling down.',
          },
        ],
      }).success,
    ).toBe(true)
  })

  it('accepts partial dismiss outcomes and rejects retry statuses', () => {
    expect(
      BulkDismissJobsResultSchema.safeParse({
        dismissed: 1,
        skipped: 0,
        results: [
          { jobId: 'one', status: 'dismissed' },
          { jobId: 'two', status: 'failed', message: 'Unable to update.' },
        ],
      }).success,
    ).toBe(true)
    expect(
      BulkDismissJobsResultSchema.safeParse({
        dismissed: 1,
        skipped: 0,
        results: [{ jobId: 'one', status: 'queued' }],
      }).success,
    ).toBe(false)
  })
})
