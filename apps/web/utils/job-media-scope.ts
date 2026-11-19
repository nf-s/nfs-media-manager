import type { Job } from '@repo/schemas/job'
import {
  isArtistEnrichmentJob,
  isMixSyncJob,
  isSubscriptionSyncJob,
} from './job-selection'
import type { Library, MediaScope } from './media-scope'

/** Task identity preserves the library of artist, subscription and mix jobs with legacy album scopes. */
export function jobMediaScope(job: Job): Library | null {
  if (isSubscriptionSyncJob(job)) return 'subscription'
  if (isMixSyncJob(job)) return 'mix'
  if (isArtistEnrichmentJob(job)) return 'artist'
  return (
    job.items.find((item) => item.mediaType)?.mediaType ?? job.scope.mediaType
  )
}

export function jobMatchesScope(job: Job, scope: Library) {
  if (isSubscriptionSyncJob(job)) return scope === 'subscription'
  if (isMixSyncJob(job)) return scope === 'mix'
  if (isArtistEnrichmentJob(job)) return scope === 'artist'
  if (scope === 'subscription' || scope === 'artist' || scope === 'mix')
    return false
  const typed = job.items.filter((item) => item.mediaType !== null)
  return typed.length
    ? typed.some((item) => item.mediaType === scope)
    : job.scope.mediaType === scope
}

/**
 * The library Metadata selects from: Albums, Films, Artists or Tracks. A link's
 * `mediaType` wins, then the library open in the rail, then Albums.
 */
export function metadataLibrary(
  value: string | null,
  fallback: string | null = null,
): MediaScope | 'artist' | 'track' {
  for (const candidate of [value, fallback])
    if (
      candidate === 'album' ||
      candidate === 'film' ||
      candidate === 'artist' ||
      candidate === 'track'
    )
      return candidate
  return 'album'
}
