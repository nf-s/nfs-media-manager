import type {
  SubscriptionSyncSchedule,
  SubscriptionSyncStatus,
  SubscriptionType,
} from '@repo/schemas/subscriptions'
import {
  getSpotifyPodcastSyncStatus,
  setSpotifyPodcastSyncSchedule,
} from './spotify-podcast-sync'
import { queueSpotifyPodcastSync } from './spotify-podcast-sync-jobs'
import {
  getYoutubeSubscriptionSyncStatus,
  setYoutubeSyncSchedule,
} from './youtube-sync'
import { queueYoutubeSync } from './youtube-sync-jobs'

/** What the Subscriptions sync endpoints need from each provider. */
export type SubscriptionSyncProvider = {
  /** Stored state only; no provider requests. */
  status: (userId: string) => Promise<SubscriptionSyncStatus>
  /** Queues a sync job, or resumes an unfinished or paused run. */
  queue: (userId: string) => Promise<SubscriptionSyncStatus>
  setSchedule: (
    userId: string,
    schedule: SubscriptionSyncSchedule,
  ) => Promise<SubscriptionSyncStatus>
}

const providers: Record<SubscriptionType, SubscriptionSyncProvider> = {
  youtube: {
    status: getYoutubeSubscriptionSyncStatus,
    queue: queueYoutubeSync,
    setSchedule: setYoutubeSyncSchedule,
  },
  spotify: {
    status: getSpotifyPodcastSyncStatus,
    queue: queueSpotifyPodcastSync,
    setSchedule: setSpotifyPodcastSyncSchedule,
  },
}

export async function getSubscriptionSyncStatus(
  type: SubscriptionType,
  userId: string,
) {
  return providers[type].status(userId)
}

export async function queueSubscriptionSync(
  type: SubscriptionType,
  userId: string,
) {
  return providers[type].queue(userId)
}

export async function setSubscriptionSyncSchedule(
  type: SubscriptionType,
  userId: string,
  schedule: SubscriptionSyncSchedule,
) {
  return providers[type].setSchedule(userId, schedule)
}
