import type { Job } from '@repo/schemas/job'
import type { MediaScope } from './media-scope'

export function jobMediaScope(job: Job): MediaScope | null {
  return (
    job.items.find((item) => item.mediaType)?.mediaType ?? job.scope.mediaType
  )
}

export function jobMatchesScope(job: Job, scope: MediaScope) {
  const typed = job.items.filter((item) => item.mediaType !== null)
  return typed.length
    ? typed.some((item) => item.mediaType === scope)
    : job.scope.mediaType === scope
}
