import { describe, expect, it } from 'vitest'
import {
  JobActivitySchema,
  JobListQuerySchema,
  getJobDismissal,
} from '../src/job'

describe('job history contracts', () => {
  it('retains a media filter without implicitly selecting a status', () => {
    expect(JobListQuerySchema.parse({ mediaItemId: 'film-1' })).toEqual({
      mediaItemId: 'film-1',
      sortBy: 'createdAt',
      direction: 'desc',
      page: 1,
      size: 25,
    })
    expect(JobListQuerySchema.safeParse({ mediaItemId: '' }).success).toBe(
      false,
    )
  })

  it('accepts supported sorts and rejects invalid sort controls', () => {
    expect(
      JobListQuerySchema.parse({ sortBy: 'result', direction: 'asc' }).sortBy,
    ).toBe('result')
    expect(JobListQuerySchema.safeParse({ sortBy: 'unknown' }).success).toBe(
      false,
    )
    expect(
      JobListQuerySchema.safeParse({ direction: 'sideways' }).success,
    ).toBe(false)
  })

  it('scopes jobs to albums, films or the Subscriptions library', () => {
    for (const mediaType of ['album', 'film', 'subscription'])
      expect(JobListQuerySchema.parse({ mediaType }).mediaType).toBe(mediaType)
    expect(JobListQuerySchema.safeParse({ mediaType: 'youtube' }).success).toBe(
      false,
    )
    const counts = { queued: 1, running: 0, failed: 0, imports: 0 }
    expect(
      JobActivitySchema.parse({
        queued: 1,
        running: 0,
        failed: 0,
        imports: 0,
        completed: 0,
        completedImports: 0,
        libraries: [{ mediaType: 'subscription', ...counts }],
      }).libraries,
    ).toEqual([{ mediaType: 'subscription', ...counts }])
  })

  it('reads dismissal metadata independently from benign error reviews', () => {
    const dismissal = {
      dismissedAt: '2026-10-27T00:00:00.000Z',
      userId: 'reviewer',
    }
    expect(getJobDismissal({ dismissal, benignReviewed: false })).toEqual(
      dismissal,
    )
    expect(getJobDismissal({ benignReviewed: true })).toBeNull()
  })

  it('handles old, invalid and reset dismissal state', () => {
    for (const dismissal of [
      null,
      {},
      true,
      { dismissedAt: 'not a date', userId: 'reviewer' },
    ]) {
      expect(getJobDismissal({ dismissal })).toBeNull()
    }
  })
})
