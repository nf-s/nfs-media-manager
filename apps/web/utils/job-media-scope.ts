import { getJobTask, type Job } from '@repo/schemas/job'
import { SUBSCRIPTION_SYNC_TASKS } from '@repo/schemas/subscriptions'
import type { WorkspaceScope } from './media-scope'

/** Subscription syncs belong to Subscriptions, including ones stored with the album scope. */
function isSubscriptionSyncJob(job: Pick<Job, 'options'>) {
  const task = getJobTask(job.options)
  return SUBSCRIPTION_SYNC_TASKS.some((name) => name === task)
}

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
