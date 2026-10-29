import {
  getJobDismissal,
  isRetryableJobStatus,
  isUnfinishedJobItem,
  type Job,
} from '@repo/schemas/job'

export function canCancelJob(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running'
}

export function canDismissJob(job: Job): boolean {
  return (
    (job.status === 'failed' || job.status === 'cancelled') &&
    !getJobDismissal(job.options)
  )
}

export function unfinishedJobItems(job: Job): number {
  return job.items.filter(
    (item) => item.mediaItemId && isUnfinishedJobItem(item.status, job.status),
  ).length
}

export function canRetryJob(job: Job): boolean {
  return (
    isRetryableJobStatus(job.status) &&
    typeof job.options.retryJobId !== 'string' &&
    unfinishedJobItems(job) > 0
  )
}

export function updateJobSelection(
  selectedIds: string[],
  orderedIds: string[],
  clickedId: string,
  anchorId: string | null,
  shift: boolean,
  checked: boolean,
): string[] {
  const end = orderedIds.indexOf(clickedId)
  if (end < 0) return selectedIds
  const start = shift && anchorId ? orderedIds.indexOf(anchorId) : -1
  const range =
    start < 0
      ? [clickedId]
      : orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)
  const selected = new Set(selectedIds)
  for (const id of range) {
    if (checked) selected.add(id)
    else selected.delete(id)
  }
  return [...selected]
}
