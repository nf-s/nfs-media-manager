import type {
  BulkCancelJobsInput,
  BulkCancelJobsResult,
  Job,
} from '@repo/schemas/job'
import { canCancelJob } from './job-selection'

export async function dispatchJobCancellation(
  jobs: Job[],
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

export interface JobActionResult {
  jobId: string
  status: 'queued' | 'dismissed' | 'cancelled' | 'skipped' | 'failed'
  message?: string
  retryJobId?: string
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
