import { describe, expect, it } from 'vitest'
import { JobListQuerySchema, getJobDismissal } from '../src/job'

describe('job history contracts', () => {
  it('retains a media filter without implicitly selecting a status', () => {
    expect(JobListQuerySchema.parse({ mediaItemId: 'film-1' })).toEqual({
      mediaItemId: 'film-1',
      page: 1,
      size: 25,
    })
    expect(JobListQuerySchema.safeParse({ mediaItemId: '' }).success).toBe(
      false,
    )
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
