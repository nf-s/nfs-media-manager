import type {
  MixStation,
  SubscriptionSyncSchedule,
  SubscriptionSyncStatus,
  SubscriptionType,
} from '@repo/schemas/subscriptions'
import {
  getMixStationSyncStatus,
  setMixStationSyncSchedule,
} from './mix-station-sync'
import { queueMixStationSync } from './mix-station-sync-jobs'
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

/** What the Subscriptions and Mixes sync endpoints need from each provider. */
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

const mixStation = (station: MixStation): SubscriptionSyncProvider => ({
  status: (userId) => getMixStationSyncStatus(station, userId),
  queue: (userId) => queueMixStationSync(station, userId),
  setSchedule: (userId, schedule) =>
    setMixStationSyncSchedule(station, userId, schedule),
})

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
  rinse: mixStation('rinse'),
  nts: mixStation('nts'),
  lotradio: mixStation('lotradio'),
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
