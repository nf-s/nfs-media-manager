import { describe, expect, it } from 'vitest'
import { getJobProgress, shouldPollJobList, type Job } from '../src/job'

function createJob(status: Job['status']): Job {
  return {
    id: `job-${status}`,
    provider: 'discogs',
    status,
    createdAt: '2026-04-03T06:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    scope: {
      mediaItemIds: [],
      mediaType: 'album',
      limit: 1,
    },
    options: {},
    confirmBroadRun: false,
    items: [],
    logs: [],
  }
}

describe('shouldPollJobList', () => {
  it('returns false when there are no jobs', () => {
    expect(shouldPollJobList([])).toBe(false)
  })

  it('returns false when all jobs are terminal', () => {
    expect(
      shouldPollJobList([createJob('succeeded'), createJob('failed')]),
    ).toBe(false)
  })

  it('returns true when a queued or running job is present', () => {
    expect(
      shouldPollJobList([createJob('succeeded'), createJob('queued')]),
    ).toBe(true)
    expect(shouldPollJobList([createJob('running')])).toBe(true)
  })
})

describe('getJobProgress', () => {
  it('reads the progress a task job records', () => {
    expect(
      getJobProgress({ progress: { pagesRead: 2, totalPages: 5 } }),
    ).toEqual({ pagesRead: 2, totalPages: 5 })
    expect(
      getJobProgress({ progress: { pagesRead: 0, totalPages: null } }),
    ).toEqual({ pagesRead: 0, totalPages: null })
  })

  it('is null for a job without valid progress', () => {
    expect(getJobProgress({})).toBeNull()
    expect(getJobProgress({ progress: { pagesRead: -1 } })).toBeNull()
  })
})
