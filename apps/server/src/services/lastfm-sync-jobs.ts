import { LASTFM_SCROBBLE_SYNC_TASK } from '@repo/schemas/lastfm'
import { ServerError } from '@/lib/error'
import { createTaskJob } from './jobs'
import { getLastfmSyncStatus } from './lastfm-scrobbles'

/** Queues a sync job, or resumes an unfinished run from its checkpoint. */
export async function queueLastfmSync(userId: string | null) {
  const { job } = await getLastfmSyncStatus()
  // Linking the unresolved job clears it from the jobs needing attention.
  await createTaskJob(
    LASTFM_SCROBBLE_SYNC_TASK,
    userId,
    job?.status === 'failed' || job?.status === 'cancelled'
      ? { retryOf: job.id }
      : {},
  )
  return getLastfmSyncStatus()
}

/**
 * Queues a sync when the schedule is due. Only a completed sync has a next
 * time, so the first sync and a failed or stopped run wait for the owner.
 */
export async function queueDueLastfmSync(now = Date.now()): Promise<boolean> {
  const status = await getLastfmSyncStatus()
  if (!status.nextScheduledAt || Date.parse(status.nextScheduledAt) > now)
    return false
  try {
    await createTaskJob(LASTFM_SCROBBLE_SYNC_TASK, null, { scheduled: true })
    return true
  } catch (error) {
    // A cooldown or halt defers the sync to a later check.
    if (error instanceof ServerError) return false
    throw error
  }
}
