'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CloudDispatchControlSchema,
  CloudDispatchStatusSchema,
} from '@repo/schemas/job'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import {
  createProviderDispatchInput,
  type ProviderDispatchAction,
} from '@/utils/provider-job-dispatch'
import { useConfig } from './providers'

export default function ProviderJobDispatch({
  provider,
}: {
  provider: ProviderSummary
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [review, setReview] = useState<{
    action: ProviderDispatchAction
    state: string
    input: ReturnType<typeof createProviderDispatchInput>
  } | null>(null)
  const path = `/api/v1/cloud/providers/${encodeURIComponent(provider.id)}/dispatch`
  const status = useQuery({
    queryKey: ['jobs', 'dispatch', provider.id],
    enabled: provider.supportsJobDispatchControl,
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, path, CloudDispatchStatusSchema.nullable(), {
        signal,
      }),
    staleTime: 0,
    refetchInterval: 3000,
  })
  const data = status.data
  const restricted =
    data?.allowedJobIds !== null && data?.allowedJobIds !== undefined
  const active = data?.slots.length ?? 0
  const waitingToResume = Boolean(data?.stopped && active > 0)
  const state = JSON.stringify([
    provider.id,
    data?.paused,
    data?.stopped,
    data?.allowedJobIds,
  ])
  const reviewing = review?.state === state ? review.action : null
  const update = useMutation({
    mutationFn: (action: ProviderDispatchAction) => {
      if (!data || !review || action !== reviewing)
        throw new Error('Review the current queue settings before continuing.')
      if (
        (action !== 'pause' && waitingToResume) ||
        (action === 'resume-all' && active > 0)
      )
        throw new Error('Wait for active work to finish before restarting.')
      return fetchApiData(apiBaseUrl, path, CloudDispatchControlSchema, {
        method: 'POST',
        body: JSON.stringify(review.input),
      })
    },
    onSuccess: () => setReview(null),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  if (!provider.supportsJobDispatchControl) return null
  const resumeLabel =
    data?.paused || data?.stopped
      ? restricted
        ? 'Resume selected jobs'
        : 'Resume queue'
      : restricted
        ? 'Restart selected jobs'
        : 'Restart queue'
  const actionLabel =
    reviewing === 'pause'
      ? 'Pause queue'
      : reviewing === 'resume-all'
        ? 'Resume all queued jobs'
        : resumeLabel
  const cooldownUntil = provider.safety?.cooldownUntil
  function startReview(action: ProviderDispatchAction) {
    if (!data) return
    update.reset()
    setReview({
      action,
      state,
      input: createProviderDispatchInput(action, data),
    })
  }
  return (
    <section className="grid shrink-0 gap-2" aria-label="Job dispatch">
      {status.isPending && <p role="status">Loading queue status...</p>}
      {status.isError && (
        <p role="alert">
          Could not load queue status.{' '}
          <Button size="sm" variant="ghost" onClick={() => status.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {status.isSuccess && !data && <p>Queue status is unavailable.</p>}
      {data && (
        <>
          <p>
            <strong>
              {data.stopped
                ? data.paused
                  ? 'Queue paused and stopped'
                  : 'Queue stopped'
                : data.paused
                  ? 'Queue paused'
                  : 'Queue enabled'}
            </strong>
            {active > 0 &&
              ` · ${active} active ${active === 1 ? 'dispatch' : 'dispatches'}`}
          </p>
          {(data.failures > 0 || data.infrastructureFailures > 0) && (
            <p className="muted">
              {data.failures} job failures · {data.infrastructureFailures} queue
              errors. Review failed job details before restarting.
            </p>
          )}
          {restricted && (
            <p className="muted">
              Dispatch is limited to {data.allowedJobIds?.length ?? 0}{' '}
              previously selected{' '}
              {data.allowedJobIds?.length === 1 ? 'job' : 'jobs'}. Other queued
              jobs will wait.
            </p>
          )}
          {waitingToResume && (
            <p className="muted">
              Waiting for active work to finish before restarting.
            </p>
          )}
          {provider.safety?.halted ? (
            <p className="muted">
              Provider access is blocked. Restarting the queue does not clear
              this block.
            </p>
          ) : cooldownUntil && Date.parse(cooldownUntil) > Date.now() ? (
            <p className="muted">
              Provider cooldown until {new Date(cooldownUntil).toLocaleString()}
              .
            </p>
          ) : null}
          {reviewing ? (
            <div
              className="grid gap-2"
              role="region"
              aria-label="Review queue action"
            >
              <p>
                {reviewing === 'pause'
                  ? 'Stop starting queued jobs. Active requests may finish.'
                  : reviewing === 'resume-all' || !restricted
                    ? `Resume all queued ${provider.displayName} jobs across libraries. Failed jobs still need Retry. Provider limits, cooldowns and access blocks apply.`
                    : `Resume only the previously selected ${provider.displayName} jobs. Other queued jobs will wait. Provider limits, cooldowns and access blocks apply.`}
              </p>
              <div className="form-actions">
                <Button
                  size="sm"
                  disabled={
                    update.isPending ||
                    (reviewing !== 'pause' && waitingToResume) ||
                    (reviewing === 'resume-all' && active > 0)
                  }
                  onClick={() => update.mutate(reviewing)}
                >
                  Confirm {actionLabel.toLowerCase()}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => setReview(null)}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="form-actions">
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending || waitingToResume}
                onClick={() => startReview('resume')}
              >
                {resumeLabel}
              </Button>
              {restricted && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.isPending || active > 0}
                  onClick={() => startReview('resume-all')}
                >
                  Resume all queued jobs
                </Button>
              )}
              {!data.paused && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => startReview('pause')}
                >
                  Pause queue
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {update.isError && <p role="alert">{update.error.message}</p>}
      {update.isSuccess && (
        <p role="status">
          {update.data.paused
            ? 'Queue paused.'
            : 'Queue restart requested. Provider limits remain enforced.'}
        </p>
      )}
    </section>
  )
}
