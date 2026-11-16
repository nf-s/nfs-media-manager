'use client'

import { DetailLink } from './detail-link'
import Link from 'next/link'
import { useState } from 'react'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BulkRetryJobsResultSchema,
  BulkDismissJobsResultSchema,
  BulkCancelJobsResultSchema,
  type Job,
  type JobBatchEntry,
} from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { Select } from '@repo/ui/components/ds/toolbar'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  canDismissJob,
  canCancelJob,
  canRetryJob,
  isScrobbleSyncJob,
  isScrobbleSpotifySearchJob,
  isSubscriptionSyncJob,
  jobTaskTitle,
  unfinishedJobItems,
} from '@/utils/job-selection'
import {
  dispatchBatchCancellation,
  dispatchJobAction,
  dispatchJobCancellation,
  jobActionSummary,
  jobReviewKey,
  type JobActionOutcome,
} from '@/utils/job-bulk-actions'
import { batchTitle } from '@/utils/job-entries'

const jobNoun = { one: 'job', other: 'jobs' }
const batchNoun = { one: 'batch', other: 'batches' }

const ActionSchema = z.enum(['retry', 'dismiss', 'cancel'])
type JobAction = z.infer<typeof ActionSchema>

/** A row's Retry or Cancel: choose that action for the row and review it. */
export type JobActionRequest =
  | {
      action: 'retry' | 'cancel'
      jobId: string
      /** Distinguishes repeated requests for the same row. */
      at: number
    }
  | { action: 'cancel'; batchId: string; at: number }

/** Jobs in a batch that have not finished, which Cancel stops. */
export function unfinishedBatchJobs(batch: JobBatchEntry) {
  return batch.queued + batch.running
}

function jobActionTitle(job: Job | undefined) {
  if (!job) return 'View job'
  return jobTaskTitle(job) ?? job.items[0]?.mediaTitle ?? 'View job'
}

export default function JobBulkActions({
  jobs,
  selectedIds,
  onSelect,
  onPending,
  single = false,
  disabled = false,
  request = null,
  batches = [],
  selectedBatchIds = [],
  onSelectBatches,
}: {
  jobs: Job[]
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onPending: (pending: boolean) => void
  single?: boolean
  disabled?: boolean
  request?: JobActionRequest | null
  /** Batch rows that can be selected; Cancel stops their unfinished jobs. */
  batches?: JobBatchEntry[]
  selectedBatchIds?: string[]
  onSelectBatches?: (ids: string[]) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [kind, setKind] = useState('')
  const [reviewedSelection, setReviewedSelection] = useState('')
  const [progress, setProgress] = useState(0)
  const selectedJobs = jobs.filter((job) => selectedIds.includes(job.id))
  const retryJobs = selectedJobs.filter(canRetryJob)
  const dismissJobs = selectedJobs.filter(canDismissJob)
  const selectedBatches = batches.filter(
    (batch) =>
      selectedBatchIds.includes(batch.batchId) &&
      unfinishedBatchJobs(batch) > 0,
  )
  // A selected batch already cancels its own jobs.
  const inSelectedBatch = (job: Job) =>
    selectedBatches.some((batch) => batch.batchId === job.options.batchId)
  const cancelJobs = selectedJobs.filter(
    (job) => canCancelJob(job) && !inSelectedBatch(job),
  )
  const batchJobs = selectedBatches.reduce(
    (total, batch) => total + unfinishedBatchJobs(batch),
    0,
  )
  const batchRunning = selectedBatches.reduce(
    (total, batch) => total + batch.running,
    0,
  )
  const batchFinished = selectedBatches.reduce(
    (total, batch) => total + batch.total - unfinishedBatchJobs(batch),
    0,
  )
  const selectedCount = selectedIds.length + selectedBatches.length
  const parsedAction = ActionSchema.safeParse(kind)
  const selectedAction = parsedAction.success ? parsedAction.data : null
  const targetsFor = (next: JobAction | null) =>
    next === 'retry'
      ? retryJobs
      : next === 'dismiss'
        ? dismissJobs
        : next === 'cancel'
          ? cancelJobs
          : []
  const targetJobs = targetsFor(selectedAction)
  const cancelling = selectedAction === 'cancel'
  const targetCount = targetJobs.length + (cancelling ? batchJobs : 0)
  const runningJobs = targetJobs.filter((job) => job.status === 'running')
  const runningCount = runningJobs.length + (cancelling ? batchRunning : 0)
  const skippedJobs =
    selectedIds.length -
    targetJobs.length -
    (cancelling
      ? selectedJobs.filter((job) => canCancelJob(job) && inSelectedBatch(job))
          .length
      : 0)
  const skippedBatches = cancelling ? 0 : selectedBatches.length
  const retriesRunning = selectedAction === 'retry' && runningJobs.length > 0
  const itemCount = retryJobs.reduce(
    (total, job) => total + unfinishedJobItems(job),
    0,
  )
  const syncRetries = retryJobs.filter(isScrobbleSyncJob).length
  const searchRetries = retryJobs.filter(isScrobbleSpotifySearchJob).length
  const subscriptionRetries = retryJobs.filter(isSubscriptionSyncJob).length
  const reviewKey = (next: JobAction | null) =>
    jobReviewKey(next, selectedJobs, targetsFor(next), selectedBatches)
  const selectionKey = reviewKey(selectedAction)
  // A row's Retry or Cancel picks that action and opens its review.
  const [appliedRequest, setAppliedRequest] = useState<number | null>(null)
  if (
    request &&
    appliedRequest !== request.at &&
    ('batchId' in request
      ? selectedBatches.some((batch) => batch.batchId === request.batchId)
      : selectedIds.includes(request.jobId))
  ) {
    setAppliedRequest(request.at)
    setKind(request.action)
    setReviewedSelection(reviewKey(request.action))
  }
  const reviewing = reviewedSelection === selectionKey && targetCount > 0
  const runningConfirmed = reviewing && runningCount > 0
  const confirmed =
    reviewing &&
    selectedAction === 'retry' &&
    itemCount + syncRetries + searchRetries + subscriptionRetries > 5
  const actionLabel =
    selectedAction === 'retry'
      ? retriesRunning
        ? 'Cancel and retry'
        : 'Retry'
      : selectedAction === 'cancel'
        ? 'Cancel jobs'
        : 'Dismiss'
  const action = useMutation({
    mutationFn: async (
      kind: 'retry' | 'dismiss' | 'cancel',
    ): Promise<JobActionOutcome> => {
      if (!reviewing) throw new Error('Review this action before continuing.')
      if (kind === 'cancel') return cancelSelection()
      if (kind === 'retry' && retriesRunning && !runningConfirmed)
        throw new Error('Confirm stopping running jobs before continuing.')
      const ids = (kind === 'retry' ? retryJobs : dismissJobs).map(
        (job) => job.id,
      )
      const result = await dispatchJobAction(
        ids,
        (jobIds) =>
          kind === 'retry'
            ? fetchApiData(
                apiBaseUrl,
                '/api/v1/scrape/jobs/retry',
                BulkRetryJobsResultSchema,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    jobIds,
                    confirmBroadRun: confirmed,
                    confirmRunning: runningConfirmed,
                  }),
                },
              )
            : fetchApiData(
                apiBaseUrl,
                '/api/v1/scrape/jobs/dismiss',
                BulkDismissJobsResultSchema,
                {
                  method: 'POST',
                  body: JSON.stringify({ jobIds }),
                },
              ),
        setProgress,
      )
      return { results: result.results, failedBatches: [] }
    },
    onMutate: () => {
      setProgress(0)
      onPending(true)
    },
    onSuccess: (result) => {
      const handled = new Set(
        result.results
          .filter((entry) => entry.status !== 'failed')
          .map((entry) => entry.jobId),
      )
      onSelect(selectedIds.filter((id) => !handled.has(id)))
      // Like failed jobs, batches whose request failed stay selected.
      onSelectBatches?.(result.failedBatches.map((entry) => entry.batchId))
      setReviewedSelection('')
      setKind('')
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      onPending(false)
    },
  })
  async function cancelSelection(): Promise<JobActionOutcome> {
    const batchResult = await dispatchBatchCancellation(
      selectedBatches,
      runningConfirmed,
      (batchId, input) =>
        fetchApiData(
          apiBaseUrl,
          `/api/v1/scrape/jobs/batches/${encodeURIComponent(batchId)}/cancel`,
          BulkCancelJobsResultSchema,
          { method: 'POST', body: JSON.stringify(input) },
        ),
      setProgress,
    )
    const done = batchResult.results.length
    const jobResult = cancelJobs.length
      ? await dispatchJobCancellation(
          cancelJobs,
          runningConfirmed,
          (input) =>
            fetchApiData(
              apiBaseUrl,
              '/api/v1/scrape/jobs/cancel',
              BulkCancelJobsResultSchema,
              { method: 'POST', body: JSON.stringify(input) },
            ),
          (processed) => setProgress(done + processed),
        )
      : { results: [] }
    return {
      results: [...batchResult.results, ...jobResult.results],
      failedBatches: batchResult.failedBatches,
    }
  }
  if (single && !retryJobs.length && !dismissJobs.length && !cancelJobs.length)
    return null
  if (!selectedCount && !action.isPending && !action.isError && !action.data)
    return null
  return (
    <div className="ops-bulk">
      {selectedCount > 0 ? (
        <>
          <Select
            aria-label={single ? 'Job action' : 'Selected job action'}
            value={kind}
            disabled={disabled || action.isPending}
            onChange={(event) => {
              setKind(event.target.value)
              setReviewedSelection('')
            }}
          >
            <option value="">Choose action…</option>
            {retryJobs.length > 0 && (
              <option value="retry">
                {retryJobs.some((job) => job.status === 'running')
                  ? 'Cancel and retry'
                  : 'Retry'}{' '}
                ({retryJobs.length})
              </option>
            )}
            {cancelJobs.length + batchJobs > 0 && (
              <option value="cancel">
                Cancel ({formatCount(cancelJobs.length + batchJobs)})
              </option>
            )}
            {dismissJobs.length > 0 && (
              <option value="dismiss">Dismiss ({dismissJobs.length})</option>
            )}
          </Select>
          {!reviewing && (
            <Button
              disabled={disabled || action.isPending || !targetCount}
              onClick={() => setReviewedSelection(selectionKey)}
            >
              Review action
            </Button>
          )}
          {reviewing && (
            <div
              className="ops-review"
              role="region"
              aria-label="Review job action"
            >
              <p>
                <strong>{actionLabel}</strong> ·{' '}
                {formatItemCount(targetCount, jobNoun)}
                {skippedJobs > 0 &&
                  ` · ${skippedJobs} ineligible jobs will be skipped`}
                {skippedBatches > 0 &&
                  ` · ${formatItemCount(skippedBatches, batchNoun)} will be skipped`}
              </p>
              {selectedAction === 'retry' && syncRetries > 0 && (
                <p>
                  Queue {syncRetries} scrobble{' '}
                  {syncRetries === 1 ? 'sync' : 'syncs'}.
                </p>
              )}
              {selectedAction === 'retry' && subscriptionRetries > 0 && (
                <p>
                  Resume {subscriptionRetries} subscription{' '}
                  {subscriptionRetries === 1 ? 'sync' : 'syncs'}. Provider
                  quotas and cooldowns apply.
                </p>
              )}
              {selectedAction === 'retry' && searchRetries > 0 && (
                <p>
                  Queue {searchRetries} Spotify album{' '}
                  {searchRetries === 1 ? 'search' : 'searches'}. Provider limits
                  and cooldowns apply.
                </p>
              )}
              {selectedAction === 'retry' && itemCount > 0 && (
                <p>
                  Queue {itemCount} unfinished{' '}
                  {itemCount === 1 ? 'item' : 'items'}. Completed items stay
                  unchanged; provider limits and cooldowns apply.
                </p>
              )}
              {runningCount > 0 && (
                <p>
                  Stop{' '}
                  {formatItemCount(runningCount, {
                    one: 'running job',
                    other: 'running jobs',
                  })}
                  . In-flight requests may finish; late results are discarded.
                </p>
              )}
              {cancelling && selectedBatches.length > 0 && (
                <p>
                  Cancel{' '}
                  {formatItemCount(batchJobs, {
                    one: 'unfinished job',
                    other: 'unfinished jobs',
                  })}{' '}
                  in{' '}
                  {selectedBatches.length === 1
                    ? 'this batch'
                    : formatItemCount(selectedBatches.length, batchNoun)}
                  , including jobs not loaded here. Keep{' '}
                  {formatItemCount(batchFinished, {
                    one: 'finished job',
                    other: 'finished jobs',
                  })}{' '}
                  and their results.
                </p>
              )}
              {cancelling && cancelJobs.length > 0 && (
                <p>
                  Stop queued and running work. Retain completed items and job
                  history.
                </p>
              )}
              {selectedAction === 'dismiss' && (
                <p>
                  Hide from Needs attention. Keep all errors and history. No
                  retry or provider safety reset.
                </p>
              )}
              <div className="ds-actions">
                <Button
                  variant="primary"
                  disabled={disabled || action.isPending || !selectedAction}
                  onClick={() => {
                    if (selectedAction) action.mutate(selectedAction)
                  }}
                >
                  Confirm {actionLabel.toLowerCase()}
                </Button>
                <Button
                  variant="ghost"
                  disabled={disabled || action.isPending}
                  onClick={() => setReviewedSelection('')}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
        </>
      ) : null}
      {action.isPending && (
        <span role="status">Processing {formatCount(progress)} jobs...</span>
      )}
      {action.isError && (
        <p className="ops-wide" role="alert">
          {action.error.message}
        </p>
      )}
      {action.data && (
        <div className="ops-wide" role="status">
          {jobActionSummary(action.data)}
          {(action.data.failedBatches.length > 0 ||
            action.data.results.some(
              (entry) =>
                entry.status === 'failed' || entry.status === 'skipped',
            )) && (
            <details>
              <summary>Action details</summary>
              <ul>
                {action.data.failedBatches.map((entry) => (
                  <li key={`batch:${entry.batchId}`}>
                    <Link
                      href={`/jobs?batchId=${encodeURIComponent(entry.batchId)}`}
                    >
                      {batchTitle(
                        batches.find(
                          (batch) => batch.batchId === entry.batchId,
                        ) ?? { label: null },
                      )}
                    </Link>
                    : {entry.message}
                  </li>
                ))}
                {action.data.results
                  .filter(
                    (entry) =>
                      entry.status === 'failed' || entry.status === 'skipped',
                  )
                  .map((entry) => (
                    <li key={entry.jobId}>
                      <DetailLink kind="job" id={entry.jobId}>
                        {jobActionTitle(
                          jobs.find((job) => job.id === entry.jobId),
                        )}
                      </DetailLink>
                      : {entry.message ?? entry.status}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
