import { SPOTIFY_PODCAST_SYNC_TASK } from '@repo/schemas/subscriptions'
import { ServerError } from '@/lib/error'
import { createTaskJob } from './jobs'
import {
  dueSpotifyPodcastSyncUsers,
  getSpotifyPodcastSyncStatus,
} from './spotify-podcast-sync'

/** Queues a sync job, or resumes an unfinished or paused run from its checkpoint. */
export async function queueSpotifyPodcastSync(userId: string) {
  const { job } = await getSpotifyPodcastSyncStatus(userId)
  // Linking the unresolved job clears it from the jobs needing attention.
  await createTaskJob(
    SPOTIFY_PODCAST_SYNC_TASK,
    userId,
    job?.status === 'failed' || job?.status === 'cancelled'
      ? { retryOf: job.id }
      : {},
  )
  return getSpotifyPodcastSyncStatus(userId)
}

/**
 * Queues a sync when the schedule is due, and resumes a run that paused on a
 * rate limit. The first sync and a failed or stopped run wait for the owner.
 */
export async function queueDueSpotifyPodcastSync(
  now = Date.now(),
): Promise<boolean> {
  let queued = false
  for (const userId of await dueSpotifyPodcastSyncUsers(now)) {
    try {
      await createTaskJob(SPOTIFY_PODCAST_SYNC_TASK, userId, {
        scheduled: true,
      })
      queued = true
    } catch (error) {
      // A cooldown, halt or disconnected account defers the sync to a later check.
      if (!(error instanceof ServerError)) throw error
    }
  }
  return queued
}
