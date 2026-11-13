import type { z } from 'zod'
import type { JobStatusSchema } from '@repo/schemas/job'
import type { PlaylistSyncSchedule } from '@repo/schemas/tracks'

const SCHEDULE_MINUTES: Record<PlaylistSyncSchedule, number | null> = {
  off: null,
  '1h': 60,
  '3h': 3 * 60,
  '6h': 6 * 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
}

/**
 * When a playlist's schedule next queues an import, measured from the last
 * completed check. Like the YouTube and Last.fm schedules, it waits while an
 * import is queued or running and after a failed or cancelled one, until
 * the owner imports the playlist again.
 */
export function nextPlaylistSyncAt(input: {
  syncable: boolean
  schedule: PlaylistSyncSchedule
  checkedAt: Date | null
  importedAt: Date | null
  jobStatus: z.infer<typeof JobStatusSchema> | null
}): Date | null {
  const minutes = SCHEDULE_MINUTES[input.schedule]
  const from = input.checkedAt ?? input.importedAt
  if (!input.syncable || minutes === null || !from) return null
  if (input.jobStatus !== null && input.jobStatus !== 'succeeded') return null
  return new Date(from.getTime() + minutes * 60 * 1000)
}
