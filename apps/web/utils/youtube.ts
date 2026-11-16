import type { SubscriptionSyncStatus } from '@repo/schemas/subscriptions'
import type { YoutubeSyncSchedule } from '@repo/schemas/youtube'
import { syncStatusLabel } from './run-status'

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

/** h:mm:ss, or m:ss under an hour. */
export function formatVideoDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`
}

export function formatCount(value: number | null) {
  return value === null ? 'Hidden' : value.toLocaleString()
}
