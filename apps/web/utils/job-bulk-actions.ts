import type {
  BulkCancelJobsInput,
  BulkCancelJobsResult,
  CancelJobBatchInput,
  Job,
  JobBatchEntry,
} from '@repo/schemas/job'
import { formatItemCount } from '@repo/ui/lib/format'
import { canCancelJob, unfinishedJobItems } from './job-selection'

export async function dispatchJobCancellation(
  jobs: Array<Pick<Job, 'id' | 'status'>>,
  confirmedRunning: boolean,
  send: (input: BulkCancelJobsInput) => Promise<BulkCancelJobsResult>,
  onProgress: (processed: number) => void,
) {
  const cancellable = jobs.filter(canCancelJob)
  const hasRunning = cancellable.some((job) => job.status === 'running')
  if (hasRunning && !confirmedRunning)
    throw new Error('Confirm stopping running jobs before continuing.')
  // Freeze consent for every chunk. A queued-to-running race must be skipped,
  // never automatically resubmitted with broader consent.
  const confirmRunning = hasRunning && confirmedRunning
  return dispatchJobAction(
    cancellable.map((job) => job.id),
    (jobIds) => send({ jobIds, confirmRunning }),
    onProgress,
  )
}

/**
 * What a review was opened for. Any change resets the review, so Confirm acts
 * only on what the owner saw: each job's status and, for a batch, how many of
 * its jobs were running.
 */
export function jobReviewKey(
  action: string | null,
  selectedJobs: Job[],
  targetJobs: Array<Pick<Job, 'id'>>,
  selectedBatches: Array<Pick<JobBatchEntry, 'batchId' | 'running'>>,
) {
  return JSON.stringify([
    action,
    selectedJobs.map((job) => [job.id, job.status, unfinishedJobItems(job)]),
    targetJobs.map((job) => job.id),
    selectedBatches.map((batch) => [batch.batchId, batch.running]),
  ])
}

/**
 * Cancels each batch's unfinished jobs, one batch per request. Running jobs
 * are cancelled only when the review showed them and was confirmed. A failed
 * request is recorded and the remaining batches are still sent.
 */
export async function dispatchBatchCancellation(
  batches: Array<Pick<JobBatchEntry, 'batchId' | 'running'>>,
  confirmedRunning: boolean,
  send: (
    batchId: string,
    input: CancelJobBatchInput,
  ) => Promise<BulkCancelJobsResult>,
  onProgress: (processed: number) => void,
): Promise<JobActionOutcome> {
  const results: JobActionResult[] = []
  const failedBatches: BatchActionFailure[] = []
  for (const batch of batches) {
    try {
      const result = await send(batch.batchId, {
        confirmRunning: confirmedRunning && batch.running > 0,
      })
      results.push(...result.results)
      onProgress(results.length)
    } catch {
      failedBatches.push({
        batchId: batch.batchId,
        message:
          'Could not confirm this action. Check batch status before trying again.',
      })
    }
  }
  return { results, failedBatches }
}

export interface JobActionResult {
  jobId: string
  status: 'queued' | 'dismissed' | 'cancelled' | 'skipped' | 'failed'
  message?: string
  retryJobId?: string
}

export interface BatchActionFailure {
  batchId: string
  message: string
}

export interface JobActionOutcome {
  results: JobActionResult[]
  failedBatches: BatchActionFailure[]
}

const resultStatuses: JobActionResult['status'][] = [
  'queued',
  'dismissed',
  'cancelled',
  'skipped',
  'failed',
]

/** `2 cancelled · 1 need review · 1 batch not cancelled.` */
export function jobActionSummary(outcome: JobActionOutcome) {
  const parts = resultStatuses.flatMap((status) => {
    const count = outcome.results.filter(
      (entry) => entry.status === status,
    ).length
    return count
      ? [`${count} ${status === 'failed' ? 'need review' : status}`]
      : []
  })
  if (outcome.failedBatches.length)
    parts.push(
      `${formatItemCount(outcome.failedBatches.length, { one: 'batch', other: 'batches' })} not cancelled`,
    )
  return `${parts.join(' · ')}.`
}

export async function dispatchJobAction(
  jobIds: string[],
  send: (ids: string[]) => Promise<{ results: JobActionResult[] }>,
  onProgress: (processed: number) => void,
): Promise<{ results: JobActionResult[] }> {
  const results: JobActionResult[] = []
  const ids = [...new Set(jobIds)]
  // Bound each HTTP request, not the user's selection. Never dispatch in parallel.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100)
    try {
      const result = await send(chunk)
      results.push(...result.results)
      onProgress(Math.min(offset + chunk.length, ids.length))
    } catch {
      results.push(
        ...ids.slice(offset).map<JobActionResult>((jobId) => ({
          jobId,
          status: 'failed',
          message: chunk.includes(jobId)
            ? 'Could not confirm this action. Check job status before trying again.'
            : 'Not submitted because the previous request failed.',
        })),
      )
      break
    }
  }
  return { results }
}
