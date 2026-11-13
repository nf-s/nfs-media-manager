import type {
  SubscriptionSyncSchedule,
  SubscriptionSyncStatus,
  SubscriptionType,
} from '@repo/schemas/subscriptions'
import { ServerError } from '@/lib/error'
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

const providers: Partial<Record<SubscriptionType, SubscriptionSyncProvider>> = {
  youtube: {
    status: getYoutubeSubscriptionSyncStatus,
    queue: async (userId) => {
      await queueYoutubeSync(userId)
      return getYoutubeSubscriptionSyncStatus(userId)
    },
    setSchedule: async (userId, schedule) => {
      await setYoutubeSyncSchedule(userId, schedule)
      return getYoutubeSubscriptionSyncStatus(userId)
    },
  },
}

const unavailable: Record<SubscriptionType, string> = {
  youtube: 'YouTube sync is not available.',
  spotify: 'Podcast sync is not available yet.',
}

function syncProvider(type: SubscriptionType) {
  const provider = providers[type]
  if (!provider)
    throw new ServerError({ statusCode: 404, message: unavailable[type] })
  return provider
}

export async function getSubscriptionSyncStatus(
  type: SubscriptionType,
  userId: string,
) {
  return syncProvider(type).status(userId)
}

export async function queueSubscriptionSync(
  type: SubscriptionType,
  userId: string,
) {
  return syncProvider(type).queue(userId)
}

export async function setSubscriptionSyncSchedule(
  type: SubscriptionType,
  userId: string,
  schedule: SubscriptionSyncSchedule,
) {
  return syncProvider(type).setSchedule(userId, schedule)
}
