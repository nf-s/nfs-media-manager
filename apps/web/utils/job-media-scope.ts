import type { Job } from '@repo/schemas/job'
import { isArtistEnrichmentJob, isSubscriptionSyncJob } from './job-selection'
import type { WorkspaceScope } from './media-scope'

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
