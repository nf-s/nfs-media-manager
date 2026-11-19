import {
  MIX_STATION_SYNC_TASKS,
  MixStationSchema,
  type MixStation,
} from '@repo/schemas/subscriptions'
import { ServerError } from '@/lib/error'
import { createTaskJob } from './jobs'
import {
  dueMixStationSyncUsers,
  getMixStationSyncStatus,
} from './mix-station-sync'

/** Queues a sync job, or resumes an unfinished or paused run from its checkpoint. */
export async function queueMixStationSync(station: MixStation, userId: string) {
  const { job } = await getMixStationSyncStatus(station, userId)
  // Linking the unresolved job clears it from the jobs needing attention.
  await createTaskJob(
    MIX_STATION_SYNC_TASKS[station],
    userId,
    job?.status === 'failed' || job?.status === 'cancelled'
      ? { retryOf: job.id }
      : {},
  )
  return getMixStationSyncStatus(station, userId)
}

/**
 * Queues each station's sync when its schedule is due, and resumes a run that
 * paused on a rate limit, was interrupted or got no answer from the station.
 * The first sync, a run that failed on the station's answer and a stopped run
 * wait for the owner.
 */
export async function queueDueMixStationSync(
  now = Date.now(),
): Promise<boolean> {
  let queued = false
  for (const station of MixStationSchema.options)
    for (const userId of await dueMixStationSyncUsers(station, now)) {
      try {
        const { job } = await getMixStationSyncStatus(station, userId)
        await createTaskJob(MIX_STATION_SYNC_TASKS[station], userId, {
          scheduled: true,
          // Linking the failed job clears it from the jobs needing attention.
          ...(job?.status === 'failed' ? { retryOf: job.id } : {}),
        })
        queued = true
      } catch (error) {
        // A cooldown or halt defers the sync to a later check.
        if (!(error instanceof ServerError)) throw error
      }
    }
  return queued
}
