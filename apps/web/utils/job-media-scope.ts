import type { Job } from '@repo/schemas/job'
import { isArtistEnrichmentJob, isSubscriptionSyncJob } from './job-selection'
import type { MediaScope, WorkspaceScope } from './media-scope'

/** Task identity preserves the library of artist and subscription jobs with legacy album scopes. */
export function jobMediaScope(job: Job): WorkspaceScope | null {
  if (isSubscriptionSyncJob(job)) return 'subscription'
  if (isArtistEnrichmentJob(job)) return 'artist'
  return (
    job.items.find((item) => item.mediaType)?.mediaType ?? job.scope.mediaType
  )
}

export function jobMatchesScope(job: Job, scope: WorkspaceScope) {
  if (isSubscriptionSyncJob(job)) return scope === 'subscription'
  if (isArtistEnrichmentJob(job)) return scope === 'artist'
  if (scope === 'subscription' || scope === 'artist') return false
  const typed = job.items.filter((item) => item.mediaType !== null)
  return typed.length
    ? typed.some((item) => item.mediaType === scope)
    : job.scope.mediaType === scope
}

/**
 * The library Metadata selects from: Albums, Films or Artists. A link's
 * `mediaType` wins, then the library open in the rail, then Albums.
 */
export function metadataLibrary(
  value: string | null,
  fallback: string | null = null,
): MediaScope | 'artist' {
  for (const candidate of [value, fallback])
    if (candidate === 'album' || candidate === 'film' || candidate === 'artist')
      return candidate
  return 'album'
}
