import type { Job, JobBatchEntry, JobEntry } from '@repo/schemas/job'
import type { StatusState } from '@repo/ui/components/ds/status'
import {
  formatCount,
  formatDate,
  formatItemCount,
  formatTime,
} from '@repo/ui/lib/format'
import { isSpotifyTrackSearchJob, jobTaskTitle } from './job-selection'
import { isBlockingWait, waitingLabel } from './provider-health'

/** A job's name: its task, else the items it targets. */
export function jobTitle(job: Pick<Job, 'options' | 'items'>) {
  return (
    jobTaskTitle(job) ??
    (job.items
      .map((item) => item.mediaTitle ?? 'Unavailable item')
      .join(', ') ||
      'Job')
  )
}

/** The Jobs list of a job's batch, where its siblings are; null outside a batch. */
export function jobBatchHref(job: Pick<Job, 'options'>) {
  const batchId = job.options.batchId
  return typeof batchId === 'string'
    ? `/jobs?batchId=${encodeURIComponent(batchId)}${isSpotifyTrackSearchJob(job) ? '&mediaType=track' : ''}`
    : null
}

const batchNouns: Record<string, { one: string; other: string }> = {
  album: { one: 'album', other: 'albums' },
  track: { one: 'track', other: 'tracks' },
  film: { one: 'film', other: 'films' },
  artist: { one: 'artist', other: 'artists' },
  subscription: { one: 'subscription sync', other: 'subscription syncs' },
  mix: { one: 'mix sync', other: 'mix syncs' },
}

/** `Library import`, else `Batch`; the target says how many items. */
export function batchTitle(batch: Pick<JobBatchEntry, 'label'>) {
  return batch.label ?? 'Batch'
}

export function batchTarget(batch: Pick<JobBatchEntry, 'total' | 'mediaType'>) {
  const noun = (batch.mediaType && batchNouns[batch.mediaType]) || {
    one: 'job',
    other: 'jobs',
  }
  return `${formatCount(batch.total)} ${batch.total === 1 ? noun.one : noun.other}`
}

/** A batch's status: running, waiting, queued, failed, cancelled or done. */
export function batchStatus(batch: JobBatchEntry): StatusState {
  if (batch.running > 0) return 'running'
  if (batch.queued > 0)
    return batch.waiting && isBlockingWait(batch.waiting.reason)
      ? 'waiting'
      : 'queued'
  if (batch.failed > 0) return 'failed'
  if (batch.cancelled > 0) return 'cancelled'
  return 'done'
}

/** A job's status in the shared vocabulary; a blocked queued job is waiting. */
export function jobStatus(job: Pick<Job, 'status' | 'waiting'>): StatusState {
  if (job.status === 'succeeded') return 'done'
  if (
    job.status === 'queued' &&
    job.waiting &&
    isBlockingWait(job.waiting.reason)
  )
    return 'waiting'
  return job.status
}

/** Finished jobs of a batch: succeeded, failed and cancelled. */
export function batchDone(batch: JobBatchEntry) {
  return batch.succeeded + batch.failed + batch.cancelled
}

/** Result cell of a batch: when it resumes, and how many failed. */
export function batchResult(batch: JobBatchEntry, now: Date = new Date()) {
  return [
    batch.waiting && batch.queued > 0 ? waitingLabel(batch.waiting, now) : '',
    batch.failed ? `${formatCount(batch.failed)} failed` : '',
    batch.cancelled ? `${formatCount(batch.cancelled)} cancelled` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Result cell of a job: the wait, the error or what the provider returned. */
export function jobResult(
  job: Pick<Job, 'status' | 'waiting' | 'errorMessage' | 'items' | 'options'>,
  mediaItemId?: string,
  now: Date = new Date(),
) {
  if (job.status === 'queued' && job.waiting)
    return waitingLabel(job.waiting, now)
  const searchResult = spotifyTrackSearchResult(job)
  if (searchResult) return searchResult
  const item = mediaItemId
    ? job.items.find((candidate) => candidate.mediaItemId === mediaItemId)
    : undefined
  const message =
    item?.message ??
    job.errorMessage ??
    job.items
      .map((entry) => entry.message)
      .filter(Boolean)
      .join(' · ')
  return item && item.status !== job.status
    ? `This item: ${item.status}${message ? ` · ${message}` : ''}`
    : message
}

export function spotifyTrackSearchResult(job: Pick<Job, 'options' | 'status'>) {
  if (!isSpotifyTrackSearchJob(job) || job.status !== 'succeeded') return null
  if (
    typeof job.options.acceptedTrackId === 'string' &&
    job.options.acceptedTrackId
  )
    return job.options.matchMethod === 'automatic'
      ? 'Matched automatically'
      : 'Match confirmed'
  const count = job.options.resultCount
  return typeof count === 'number' && Number.isInteger(count) && count >= 0
    ? formatItemCount(count, { one: 'Spotify match', other: 'Spotify matches' })
    : 'Search skipped'
}

/** A past time: the clock time today, the ISO date before that. */
export function formatWhen(value: string, now: Date = new Date()) {
  return formatDate(value) === formatDate(now)
    ? formatTime(value)
    : formatDate(value)
}

export function entryKey(entry: JobEntry) {
  return entry.kind === 'batch' ? `batch:${entry.batchId}` : entry.job.id
}
