import type { Job } from '@repo/schemas/job'
import { isSubscriptionSyncJob } from './job-selection'
import type { WorkspaceScope } from './media-scope'

/** Subscription syncs belong to Subscriptions, including ones stored with the album scope. */
export function jobMediaScope(job: Job): WorkspaceScope | null {
  if (isSubscriptionSyncJob(job)) return 'subscription'
  return (
    job.items.find((item) => item.mediaType)?.mediaType ?? job.scope.mediaType
  )
}

export function jobMatchesScope(job: Job, scope: WorkspaceScope) {
  if (isSubscriptionSyncJob(job)) return scope === 'subscription'
  if (scope === 'subscription') return false
  const typed = job.items.filter((item) => item.mediaType !== null)
  return typed.length
    ? typed.some((item) => item.mediaType === scope)
    : job.scope.mediaType === scope
}
