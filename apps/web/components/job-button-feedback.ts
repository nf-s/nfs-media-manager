import { useQuery } from '@tanstack/react-query'
import { JobEntryPageSchema, type Job, type JobEntry } from '@repo/schemas/job'
import type { ButtonFeedback } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { jobDetailOptions } from '@/utils/job-data'
import { batchDone, batchStatus, jobStatus } from '@/utils/job-entries'

export function queueReceipt(queued: number, skipped: number): ButtonFeedback {
  if (!queued)
    return {
      phase: 'done',
      label: skipped ? 'No eligible jobs' : 'No jobs queued',
    }
  return {
    phase: 'queued',
    label: skipped
      ? `${formatCount(queued)} queued · ${formatCount(skipped)} skipped`
      : `${formatCount(queued)} queued`,
  }
}

export function submissionFeedback(receipt?: ButtonFeedback): ButtonFeedback {
  return receipt && receipt.phase !== 'unconfirmed'
    ? { phase: 'partial', label: `${receipt.label} · submission unconfirmed` }
    : { phase: 'unconfirmed', label: 'Submission unconfirmed' }
}

export function jobButtonFeedback(
  job: Pick<Job, 'status'> & Partial<Pick<Job, 'waiting'>>,
  completed = 'Completed',
): ButtonFeedback {
  const state = jobStatus({ status: job.status, waiting: job.waiting })
  switch (state) {
    case 'queued':
      return { phase: state, label: 'Queued' }
    case 'running':
      return { phase: state, label: 'Running…' }
    case 'waiting':
      return { phase: state, label: 'Waiting' }
    case 'done':
      return { phase: state, label: completed }
    case 'cancelled':
      return { phase: state, label: 'Cancelled' }
    default:
      return { phase: 'failed', label: 'Failed' }
  }
}

export function useSyncButtonFeedback(
  apiBaseUrl: string,
  data?: {
    state: 'never' | 'running' | 'stopped' | 'failed' | 'complete' | 'paused'
    job: Pick<Job, 'id' | 'status'> | null
  },
): ButtonFeedback | undefined {
  const queued = data?.state === 'running' && data.job?.status === 'queued'
  const currentJob = useQuery({
    ...jobDetailOptions(apiBaseUrl, data?.job?.id ?? ''),
    enabled: queued,
  })
  if (!data) return undefined
  switch (data.state) {
    case 'running':
      if (queued && currentJob.data && jobStatus(currentJob.data) === 'waiting')
        return { phase: 'waiting', label: 'Waiting to sync' }
      return data.job?.status === 'queued'
        ? { phase: 'queued', label: 'Sync queued' }
        : { phase: 'running', label: 'Syncing…' }
    case 'paused':
      return { phase: 'waiting', label: 'Waiting to sync' }
    case 'complete':
      return { phase: 'done', label: 'Synced' }
    case 'stopped':
      return { phase: 'cancelled', label: 'Sync stopped' }
    case 'failed':
      return { phase: 'failed', label: 'Sync failed' }
    case 'never':
      return undefined
  }
}

export function jobBatchFeedback(entry: JobEntry): ButtonFeedback {
  if (entry.kind === 'job') return jobButtonFeedback(entry.job)
  const state = batchStatus(entry)
  const done = batchDone(entry)
  if (state === 'waiting') return { phase: state, label: 'Waiting' }
  if (state === 'queued')
    return { phase: state, label: `${formatCount(entry.queued)} queued` }
  if (state === 'running')
    return {
      phase: state,
      label: `${formatCount(done)}/${formatCount(entry.total)} finished`,
    }
  const results = [
    entry.succeeded && `${formatCount(entry.succeeded)} completed`,
    entry.failed && `${formatCount(entry.failed)} failed`,
    entry.cancelled && `${formatCount(entry.cancelled)} cancelled`,
  ]
    .filter(Boolean)
    .join(' · ')
  const outcomes =
    Number(entry.succeeded > 0) +
    Number(entry.failed > 0) +
    Number(entry.cancelled > 0)
  const phase = outcomes > 1 ? 'partial' : state
  return {
    phase:
      phase === 'done' || phase === 'partial' || phase === 'cancelled'
        ? phase
        : 'failed',
    label: results,
  }
}

export function jobBatchPollInterval(entry?: JobEntry) {
  const phase = entry && jobBatchFeedback(entry).phase
  return !phase ||
    phase === 'queued' ||
    phase === 'running' ||
    phase === 'waiting'
    ? 3000
    : false
}

/** Read the aggregate for the exact accepted batch, including one-job batches. */
export function useJobBatchFeedback(apiBaseUrl: string, batchId?: string) {
  const result = useQuery({
    queryKey: ['jobs', 'button-batch', batchId],
    enabled: Boolean(batchId),
    retry: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/entries?${new URLSearchParams({ batchId: batchId ?? '', size: '1' })}`,
        JobEntryPageSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      jobBatchPollInterval(query.state.data?.items[0]),
  })
  const entry = result.data?.items[0]
  if (!batchId) return undefined
  if (result.isError && jobBatchPollInterval(entry))
    return {
      phase: 'unconfirmed',
      label: 'Job status unconfirmed',
    } satisfies ButtonFeedback
  return entry ? jobBatchFeedback(entry) : undefined
}
