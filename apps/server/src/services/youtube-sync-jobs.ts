import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import { ServerError } from '@/lib/error'
import { createTaskJob } from './jobs'
import {
  dueYoutubeSyncUsers,
  getYoutubeSubscriptionSyncStatus,
} from './youtube-sync'

/** Queues a sync job, or resumes an unfinished or paused run from its checkpoint. */
export async function queueYoutubeSync(userId: string) {
  const { job } = await getYoutubeSubscriptionSyncStatus(userId)
  // Linking the unresolved job clears it from the jobs needing attention.
  await createTaskJob(
    YOUTUBE_SYNC_TASK,
    userId,
    job?.status === 'failed' || job?.status === 'cancelled'
      ? { retryOf: job.id }
      : {},
  )
  return getYoutubeSubscriptionSyncStatus(userId)
}

/**
 * Queues a sync when the schedule is due, and resumes a run that paused on the
 * daily quota. The first sync and a failed or stopped run wait for the owner.
 */
export async function queueDueYoutubeSync(now = Date.now()): Promise<boolean> {
  let queued = false
  for (const userId of await dueYoutubeSyncUsers(now)) {
    try {
      await createTaskJob(YOUTUBE_SYNC_TASK, userId, { scheduled: true })
      queued = true
    } catch (error) {
      // A cooldown, halt or disconnected account defers the sync to a later check.
      if (!(error instanceof ServerError)) throw error
    }
  }
  return queued
}
