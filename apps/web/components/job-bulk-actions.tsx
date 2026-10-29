'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BulkRetryJobsResultSchema,
  BulkDismissJobsResultSchema,
  BulkCancelJobsResultSchema,
  type Job,
} from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  canDismissJob,
  canCancelJob,
  canRetryJob,
  unfinishedJobItems,
} from '@/utils/job-selection'
import {
  dispatchJobAction,
  dispatchJobCancellation,
} from '@/utils/job-bulk-actions'

const ActionSchema = z.enum(['retry', 'dismiss', 'cancel'])

export default function JobBulkActions({
  jobs,
  selectedIds,
  onSelect,
  onPending,
  single = false,
  disabled = false,
}: {
  jobs: Job[]
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onPending: (pending: boolean) => void
  single?: boolean
  disabled?: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const selectAll = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState('')
  const [reviewedSelection, setReviewedSelection] = useState('')
  const [progress, setProgress] = useState(0)
  const selectedJobs = jobs.filter((job) => selectedIds.includes(job.id))
  const retryJobs = selectedJobs.filter(canRetryJob)
  const dismissJobs = selectedJobs.filter(canDismissJob)
  const cancelJobs = selectedJobs.filter(canCancelJob)
  const parsedAction = ActionSchema.safeParse(kind)
  const selectedAction = parsedAction.success ? parsedAction.data : null
  const targetJobs =
    selectedAction === 'retry'
      ? retryJobs
      : selectedAction === 'dismiss'
        ? dismissJobs
        : selectedAction === 'cancel'
          ? cancelJobs
          : []
  const runningJobs = targetJobs.filter((job) => job.status === 'running')
  const retriesRunning = selectedAction === 'retry' && runningJobs.length > 0
  const itemCount = retryJobs.reduce(
    (total, job) => total + unfinishedJobItems(job),
    0,
  )
  const selectionKey = JSON.stringify([
    selectedAction,
    selectedJobs.map((job) => [job.id, job.status, unfinishedJobItems(job)]),
    targetJobs.map((job) => job.id),
  ])
  const reviewing = reviewedSelection === selectionKey && targetJobs.length > 0
  const runningConfirmed = reviewing && runningJobs.length > 0
  const confirmed = reviewing && selectedAction === 'retry' && itemCount > 5
  const actionLabel =
    selectedAction === 'retry'
      ? retriesRunning
        ? 'Cancel and retry'
        : 'Retry'
      : selectedAction === 'cancel'
        ? 'Cancel jobs'
        : 'Dismiss'
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        selectedIds.length > 0 && selectedIds.length < jobs.length
  }, [selectedIds.length, jobs.length])
  const action = useMutation({
    mutationFn: (kind: 'retry' | 'dismiss' | 'cancel') => {
      if (!reviewing) throw new Error('Review this action before continuing.')
      if (kind === 'cancel')
        return dispatchJobCancellation(
          cancelJobs,
          runningConfirmed,
          (input) =>
            fetchApiData(
              apiBaseUrl,
              '/api/v1/scrape/jobs/cancel',
              BulkCancelJobsResultSchema,
              { method: 'POST', body: JSON.stringify(input) },
            ),
          setProgress,
        )
      if (kind === 'retry' && retriesRunning && !runningConfirmed)
        throw new Error('Confirm stopping running jobs before continuing.')
      const ids = (kind === 'retry' ? retryJobs : dismissJobs).map(
        (job) => job.id,
      )
      return dispatchJobAction(
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
      setReviewedSelection('')
      setKind('')
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      onPending(false)
    },
  })
  if (single && !retryJobs.length && !dismissJobs.length && !cancelJobs.length)
    return null
  return (
    <div className="job-selection-toolbar">
      {!single && jobs.length > 0 && (
        <label className="check-label">
          <input
            ref={selectAll}
            type="checkbox"
            aria-label="Select all loaded jobs"
            checked={selectedIds.length === jobs.length}
            disabled={disabled || action.isPending}
            onChange={(event) => {
              onSelect(event.target.checked ? jobs.map((job) => job.id) : [])
              setReviewedSelection('')
            }}
          />
          Select loaded
        </label>
      )}
      {!single && selectedIds.length > 0 && (
        <>
          <span>{selectedIds.length} selected</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || action.isPending}
            onClick={() => {
              onSelect([])
              setReviewedSelection('')
            }}
          >
            Clear
          </Button>
        </>
      )}
      {selectedIds.length > 0 ? (
        <>
          <select
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
            {cancelJobs.length > 0 && (
              <option value="cancel">Cancel ({cancelJobs.length})</option>
            )}
            {dismissJobs.length > 0 && (
              <option value="dismiss">Dismiss ({dismissJobs.length})</option>
            )}
          </select>
          {!reviewing && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || action.isPending || !targetJobs.length}
              onClick={() => setReviewedSelection(selectionKey)}
            >
              Review action
            </Button>
          )}
          {reviewing && (
            <div
              className="job-action-review"
              role="region"
              aria-label="Review job action"
            >
              <p>
                <strong>{actionLabel}</strong> · {targetJobs.length}{' '}
                {targetJobs.length === 1 ? 'job' : 'jobs'}
                {selectedIds.length > targetJobs.length &&
                  ` · ${selectedIds.length - targetJobs.length} ineligible jobs will be skipped`}
              </p>
              {selectedAction === 'retry' && (
                <p>
                  Queue {itemCount} unfinished{' '}
                  {itemCount === 1 ? 'item' : 'items'}. Completed items stay
                  unchanged; provider limits and cooldowns apply.
                </p>
              )}
              {runningJobs.length > 0 && (
                <p>
                  Stop {runningJobs.length} running{' '}
                  {runningJobs.length === 1 ? 'job' : 'jobs'}. In-flight
                  requests may finish; late results are discarded.
                </p>
              )}
              {selectedAction === 'cancel' && (
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
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={disabled || action.isPending || !selectedAction}
                  onClick={() => {
                    if (selectedAction) action.mutate(selectedAction)
                  }}
                >
                  Confirm {actionLabel.toLowerCase()}
                </Button>
                <Button
                  size="sm"
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
      ) : jobs.length > 0 ? (
        <span className="muted">Shift-click to select a range.</span>
      ) : null}
      {action.isPending && (
        <span role="status">Processing {progress} jobs...</span>
      )}
      {action.isError && (
        <p className="w-full" role="alert">
          {action.error.message}
        </p>
      )}
      {action.data && (
        <div className="w-full" role="status">
          {['queued', 'dismissed', 'cancelled', 'skipped', 'failed']
            .flatMap((status) => {
              const count = action.data.results.filter(
                (entry) => entry.status === status,
              ).length
              return count
                ? [`${count} ${status === 'failed' ? 'need review' : status}`]
                : []
            })
            .join(' · ')}
          .
          {action.data.results.some(
            (entry) => entry.status === 'failed' || entry.status === 'skipped',
          ) && (
            <details>
              <summary>Action details</summary>
              <ul>
                {action.data.results
                  .filter(
                    (entry) =>
                      entry.status === 'failed' || entry.status === 'skipped',
                  )
                  .map((entry) => (
                    <li key={entry.jobId}>
                      <Link
                        href={`/jobs?jobId=${encodeURIComponent(entry.jobId)}`}
                      >
                        {jobs.find((job) => job.id === entry.jobId)?.items[0]
                          ?.mediaTitle ?? 'View job'}
                      </Link>
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
