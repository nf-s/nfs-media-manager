'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CloudDispatchControlSchema,
  CloudDispatchStatusSchema,
} from '@repo/schemas/job'
import type {
  ProviderLocalWorkerStatus,
  ProviderSummary,
} from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'
import { formatUntil } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import {
  createProviderDispatchInput,
  providerDispatchPollInterval,
  type ProviderDispatchAction,
} from '@/utils/provider-job-dispatch'
import { useConfig } from './providers'
import type {
  useProviderLocalWorkerMode,
  useProviderLocalWorkerPair,
} from './provider-local-worker'
import { ConfirmAction } from './confirm-action'

type DispatchProvider = Pick<
  ProviderSummary,
  'id' | 'displayName' | 'supportsJobDispatchControl' | 'safety'
>

/**
 * The cloud dispatcher of one provider: its status, and Pause, Resume and
 * Restart behind a review step. Every action is reviewed against the status
 * it was started from; a change in between asks for a new review.
 */
export function useProviderDispatch(provider: DispatchProvider) {
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
    staleTime: 3000,
    refetchInterval: (query) => providerDispatchPollInterval(query.state.data),
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
  const resumeLabel =
    data?.paused || data?.stopped
      ? restricted
        ? 'Resume selected jobs'
        : 'Resume queue'
      : restricted
        ? 'Restart selected jobs'
        : 'Restart queue'
  return {
    provider,
    status,
    data,
    restricted,
    active,
    waitingToResume,
    reviewing,
    update,
    resumeLabel,
    actionLabel:
      reviewing === 'pause'
        ? 'Pause queue'
        : reviewing === 'resume-all'
          ? 'Resume all queued jobs'
          : resumeLabel,
    startReview(action: ProviderDispatchAction) {
      if (!data) return
      update.reset()
      setReview({
        action,
        state,
        input: createProviderDispatchInput(action, data),
      })
    },
    cancelReview() {
      setReview(null)
    },
  }
}

export type ProviderDispatch = ReturnType<typeof useProviderDispatch>

/** One line naming the dispatcher state. */
export function dispatchStateLabel(dispatch: ProviderDispatch) {
  const { data, active } = dispatch
  if (!dispatch.provider.supportsJobDispatchControl || !data) return null
  const state = data.stopped
    ? data.paused
      ? 'Paused and stopped'
      : 'Stopped'
    : data.paused
      ? 'Paused'
      : 'Enabled'
  return active > 0
    ? `${state} · ${active} active ${active === 1 ? 'dispatch' : 'dispatches'}`
    : state
}

/**
 * Resume or restart, Resume all and Pause; each opens the review. `compact`
 * (table rows) offers only Resume for a held queue and Pause for a running one.
 */
export function ProviderDispatchActions({
  dispatch,
  compact = false,
  busy = false,
}: {
  dispatch: ProviderDispatch
  compact?: boolean
  busy?: boolean
}) {
  const { data, reviewing, update, waitingToResume, restricted, active } =
    dispatch
  if (!dispatch.provider.supportsJobDispatchControl || !data || reviewing)
    return null
  const disabled = busy || update.isPending
  const size = compact ? 'xs' : 'md'
  const held = data.paused || data.stopped
  return (
    <>
      {(!compact || held) && (
        <Button
          size={size}
          disabled={disabled || waitingToResume}
          onClick={() => dispatch.startReview('resume')}
        >
          {dispatch.resumeLabel}
        </Button>
      )}
      {restricted && !compact && (
        <Button
          size={size}
          disabled={disabled || active > 0}
          onClick={() => dispatch.startReview('resume-all')}
        >
          Resume all queued jobs
        </Button>
      )}
      {!data.paused && (
        <Button
          size={size}
          variant="ghost"
          disabled={disabled}
          onClick={() => dispatch.startReview('pause')}
        >
          Pause queue
        </Button>
      )}
    </>
  )
}

/** What the reviewed action does, with Confirm and Back, and its result. */
export function ProviderDispatchReview({
  dispatch,
  busy = false,
}: {
  dispatch: ProviderDispatch
  busy?: boolean
}) {
  const {
    provider,
    status,
    reviewing,
    restricted,
    update,
    waitingToResume,
    active,
  } = dispatch
  if (!provider.supportsJobDispatchControl) return null
  return (
    <>
      {status.isError && (
        <p role="alert">
          Could not load queue status.{' '}
          <Button size="xs" variant="ghost" onClick={() => status.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {reviewing && (
        <div
          className="providers-confirm"
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
          <span className="ds-actions">
            <Button
              size="xs"
              variant="primary"
              disabled={
                busy ||
                update.isPending ||
                (reviewing !== 'pause' && waitingToResume) ||
                (reviewing === 'resume-all' && active > 0)
              }
              onClick={() => update.mutate(reviewing)}
            >
              Confirm {dispatch.actionLabel.toLowerCase()}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || update.isPending}
              onClick={dispatch.cancelReview}
            >
              Back
            </Button>
          </span>
        </div>
      )}
      {update.isError && <p role="alert">{update.error.message}</p>}
      {update.isSuccess && (
        <p role="status">
          {update.data.paused
            ? 'Queue paused.'
            : 'Queue restart requested. Provider limits remain enforced.'}
        </p>
      )}
    </>
  )
}

/** Failures, a restricted selection and blocks that a restart does not clear. */
export function ProviderDispatchNotes({
  dispatch,
}: {
  dispatch: ProviderDispatch
}) {
  const { provider, status, data, restricted, waitingToResume } = dispatch
  if (!provider.supportsJobDispatchControl) return null
  if (status.isSuccess && !data)
    return <p className="ds-help">Queue status is unavailable.</p>
  if (!data) return null
  const cooldownUntil = provider.safety?.cooldownUntil
  return (
    <>
      {(data.failures > 0 || data.infrastructureFailures > 0) && (
        <p className="ds-help">
          {data.failures} job failures · {data.infrastructureFailures} queue
          errors. Review failed job details before restarting.
        </p>
      )}
      {restricted && (
        <p className="ds-help">
          Dispatch is limited to {data.allowedJobIds?.length ?? 0} previously
          selected {data.allowedJobIds?.length === 1 ? 'job' : 'jobs'}. Other
          queued jobs will wait.
        </p>
      )}
      {waitingToResume && (
        <p className="ds-help">
          Waiting for active work to finish before restarting.
        </p>
      )}
      {provider.safety?.halted ? (
        <p className="ds-help">
          Provider access is blocked. Restarting the queue does not clear this
          block.
        </p>
      ) : cooldownUntil && Date.parse(cooldownUntil) > Date.now() ? (
        <p className="ds-help">
          Provider cooldown until {formatUntil(cooldownUntil)}.
        </p>
      ) : null}
    </>
  )
}

/** Moves the provider between the cloud and its local worker once the queue is paused and drained. */
export function ProviderWorkerModeSwitch({
  worker,
  dispatch,
  changeMode,
  busy = false,
}: {
  worker?: ProviderLocalWorkerStatus
  dispatch: ProviderDispatch
  changeMode: ReturnType<typeof useProviderLocalWorkerMode>
  busy?: boolean
}) {
  if (!worker?.supportsModeSwitch) return null
  const { reviewing, update, status } = dispatch
  const nextMode = worker.mode === 'local' ? 'cloud' : 'local'
  const restriction = workerControlRestriction(worker, dispatch, 'switching')
  return (
    <>
      <span className="ds-actions">
        <Button
          disabled={
            busy ||
            update.isPending ||
            changeMode.isPending ||
            !!reviewing ||
            !!restriction ||
            status.isError
          }
          onClick={() => changeMode.mutate(nextMode)}
        >
          {changeMode.isPending
            ? 'Switching...'
            : nextMode === 'cloud'
              ? 'Switch to Cloudflare'
              : 'Switch to Local'}
        </Button>
        {restriction && <span className="ds-help">{restriction}</span>}
      </span>
      {changeMode.isError && (
        <p role="alert">
          {changeMode.error.message || 'Could not switch transport.'}
        </p>
      )}
    </>
  )
}

function workerControlRestriction(
  worker: ProviderLocalWorkerStatus,
  dispatch: ProviderDispatch,
  action: 'switching' | 'pairing',
) {
  if (worker.blocked) return `Review the local request before ${action}.`
  if (!dispatch.data?.paused || dispatch.active > 0 || worker.active)
    return 'Pause the queue and wait for active work to finish.'
  return null
}

export function ProviderWorkerPairing({
  worker,
  dispatch,
  pairing,
  busy,
}: {
  worker?: ProviderLocalWorkerStatus
  dispatch: ProviderDispatch
  pairing: ReturnType<typeof useProviderLocalWorkerPair>
  busy: boolean
}) {
  if (!worker) return null
  const { request, canDownload, download } = pairing
  const restriction = workerControlRestriction(worker, dispatch, 'pairing')
  const disabled =
    busy ||
    request.isPending ||
    dispatch.update.isPending ||
    !!dispatch.reviewing ||
    dispatch.status.isError ||
    !!restriction
  return (
    <>
      {canDownload ? (
        <span className="ds-actions">
          <Button type="button" onClick={download}>
            Download worker token
          </Button>
          <span className="ds-help">
            Use the token in the worker’s private configuration.
          </span>
        </span>
      ) : (
        <span className="ds-actions">
          <ConfirmAction
            question={
              worker.paired
                ? 'Replace the worker pairing?'
                : 'Pair the local worker?'
            }
            details={
              worker.paired
                ? 'The previous token stops working immediately. Download the new token to reconnect the worker.'
                : 'Download the token after pairing to connect the worker.'
            }
            confirmLabel={worker.paired ? 'Replace pairing' : 'Pair worker'}
            disabled={disabled}
            onConfirm={() => {
              if (!disabled) request.mutate()
            }}
          >
            {request.isPending
              ? 'Pairing...'
              : worker.paired
                ? 'Replace pairing'
                : 'Pair worker'}
          </ConfirmAction>
          {restriction && !worker.supportsModeSwitch && (
            <span className="ds-help">{restriction}</span>
          )}
        </span>
      )}
      {request.isError && <p role="alert">{request.error.message}</p>}
    </>
  )
}
