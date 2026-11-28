import type { SubscriptionSyncStatus } from '@repo/schemas/subscriptions'
import type { YoutubeSyncSchedule } from '@repo/schemas/youtube'
import { syncStatusLabel } from './run-status'

export { formatVideoDuration } from '@repo/schemas/youtube'

/** How often the page re-reads status while a sync job is queued or running. */
export const YOUTUBE_SYNC_POLL_MS = 3000

/** Sync states in the shared status vocabulary. */
export const youtubeSyncStateLabels: Record<
  SubscriptionSyncStatus['state'],
  string
> = {
  never: syncStatusLabel('never'),
  running: syncStatusLabel('running'),
  paused: syncStatusLabel('paused'),
  stopped: syncStatusLabel('stopped'),
  failed: syncStatusLabel('failed'),
  complete: syncStatusLabel('complete'),
}

export const youtubeScheduleLabels: Record<YoutubeSyncSchedule, string> = {
  off: 'Off',
  '1h': 'Every hour',
  '3h': 'Every 3 hours',
  '6h': 'Every 6 hours',
  daily: 'Daily',
  weekly: 'Weekly',
}

export function youtubeSyncPollInterval(
  state: SubscriptionSyncStatus['state'] | null,
) {
  return state === 'running' ? YOUTUBE_SYNC_POLL_MS : false
}

export function formatCount(value: number | null) {
  return value === null ? 'Hidden' : value.toLocaleString()
}
