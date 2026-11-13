'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { BulkCancelJobsResultSchema } from '@repo/schemas/job'
import {
  SubscriptionSyncScheduleSchema,
  SubscriptionSyncStatusSchema,
  type SubscriptionSyncSchedule,
  type SubscriptionSyncStatus,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { fetchApiData } from '@/utils/api'
import { dispatchJobCancellation } from '@/utils/job-bulk-actions'
import { canCancelJob } from '@/utils/job-selection'
import { scopedHref } from '@/utils/media-scope'
import {
  youtubeScheduleLabels,
  youtubeSyncPollInterval,
  youtubeSyncStateLabels,
} from '@/utils/youtube'

/** How each provider's sync names its sources and items. */
export const subscriptionSyncWording: Record<
  SubscriptionType,
  {
    name: string
    sources: string
    items: string
    listing: string
    paused: string
  }
> = {
  youtube: {
    name: 'YouTube',
    sources: 'channels',
    items: 'videos',
    listing: 'Reading subscriptions',
    paused: 'Paused: the daily YouTube API quota is used up.',
  },
  spotify: {
    name: 'podcast',
    sources: 'podcasts',
    items: 'episodes',
    listing: 'Reading saved podcasts',
    paused: 'Paused: the Spotify request limit was reached.',
  },
}

const NotAvailableSchema = z.object({ statusCode: z.literal(404) })

function capitalized(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

export function subscriptionSyncQueryKey(provider: SubscriptionType) {
  return ['subscription-sync', provider]
}

/** "12 of 40", or the source-list step before sources are counted. */
export function subscriptionSourceProgress(
  status: Pick<
    SubscriptionSyncStatus,
    'provider' | 'state' | 'phase' | 'sourcesDone' | 'sourcesTotal'
  >,
) {
  if (status.state === 'running' && status.phase === 'sources')
    return subscriptionSyncWording[status.provider].listing
  if (status.phase === null) return '-'
  return `${status.sourcesDone.toLocaleString()} of ${status.sourcesTotal.toLocaleString()}`
}

/** Refreshes everything a sync can change. */
export function invalidateSubscriptionLibrary(client: QueryClient) {
  return client.invalidateQueries({ queryKey: ['subscriptions'] })
}

/** The provider's sync status, or null when this server has no sync for it. */
export function useSubscriptionSyncStatus(provider: SubscriptionType) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: subscriptionSyncQueryKey(provider),
    staleTime: 0,
    refetchInterval: (query) =>
      youtubeSyncPollInterval(query.state.data?.state ?? null),
    queryFn: async (): Promise<SubscriptionSyncStatus | null> => {
      try {
        return await fetchApiData(
          apiBaseUrl,
          `/api/v1/subscriptions/sync/${provider}`,
          SubscriptionSyncStatusSchema,
        )
      } catch (failure) {
        if (NotAvailableSchema.safeParse(failure).success) return null
        throw failure
      }
    },
  })
}

export function SubscriptionSync({
  status: data,
}: {
  status: SubscriptionSyncStatus
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [confirmingStop, setConfirmingStop] = useState(false)
  const wording = subscriptionSyncWording[data.provider]
  const queryKey = subscriptionSyncQueryKey(data.provider)
  const path = `/api/v1/subscriptions/sync/${data.provider}`
  const update = (next: SubscriptionSyncStatus) =>
    client.setQueryData(queryKey, next)
  const sync = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, path, SubscriptionSyncStatusSchema, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: update,
  })
  const schedule = useMutation({
    mutationFn: (value: SubscriptionSyncSchedule) =>
      fetchApiData(
        apiBaseUrl,
        `${path}/settings`,
        SubscriptionSyncStatusSchema,
        { method: 'PUT', body: JSON.stringify({ schedule: value }) },
      ),
    onSuccess: update,
  })
  const stop = useMutation({
    mutationFn: async (job: NonNullable<SubscriptionSyncStatus['job']>) => {
      const result = await dispatchJobCancellation(
        [job],
        true,
        (input) =>
          fetchApiData(
            apiBaseUrl,
            '/api/v1/scrape/jobs/cancel',
            BulkCancelJobsResultSchema,
            { method: 'POST', body: JSON.stringify(input) },
          ),
        () => {},
      )
      const failure = result.results.find(
        (entry) => entry.status !== 'cancelled',
      )
      if (failure)
        throw new Error(failure.message ?? 'The sync job was not cancelled.')
    },
    onSettled: async () => {
      setConfirmingStop(false)
      await client.invalidateQueries({ queryKey })
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
    },
  })
  const running = data.state === 'running'
  const resumable =
    data.state === 'paused' ||
    data.state === 'failed' ||
    data.state === 'stopped'
  const stopJob =
    running && data.job && canCancelJob(data.job) ? data.job : null
  const actionError = sync.error ?? stop.error ?? schedule.error
  const headingId = `${data.provider}-sync`
  return (
    <section className="film-import-workflow" aria-labelledby={headingId}>
      <h2 id={headingId}>Sync</h2>
      <dl className="detail-metrics">
        <div>
          <dt>State</dt>
          <dd>{youtubeSyncStateLabels[data.state]}</dd>
        </div>
        <div>
          <dt>{capitalized(wording.sources)} read</dt>
          <dd>{subscriptionSourceProgress(data)}</dd>
        </div>
        <div>
          <dt>New {wording.items} this run</dt>
          <dd>{data.newItems.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Stored {wording.sources}</dt>
          <dd>{data.storedSources.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Stored {wording.items}</dt>
          <dd>{data.storedItems.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last completed</dt>
          <dd>{formatDateTime(data.lastCompletedAt)}</dd>
        </div>
      </dl>
      {running && (
        <progress
          className="w-full max-w-md"
          value={data.phase === 'items' ? data.sourcesDone : undefined}
          max={
            data.phase === 'items' && data.sourcesTotal
              ? data.sourcesTotal
              : undefined
          }
          aria-label="Sync progress"
        />
      )}
      {data.state === 'paused' && (
        <p role="status">
          {wording.paused}
          {data.resumeAfter &&
            (data.schedule === 'off'
              ? ` Resume after ${formatDateTime(data.resumeAfter)}.`
              : ` The schedule resumes it after ${formatDateTime(data.resumeAfter)}.`)}
        </p>
      )}
      {data.state === 'failed' && data.errorMessage && (
        <p role="alert">{data.errorMessage}</p>
      )}
      {actionError && (
        <p role="alert">
          {errorMessage(
            actionError,
            `Could not update the ${wording.name} sync.`,
          )}
        </p>
      )}
      <div className="form-actions">
        <Button
          disabled={!data.account.connected || running || sync.isPending}
          onClick={() => sync.mutate()}
        >
          {sync.isPending
            ? 'Starting...'
            : resumable
              ? 'Resume sync'
              : 'Sync now'}
        </Button>
        {stopJob && !confirmingStop && (
          <Button
            variant="outline"
            disabled={stop.isPending}
            onClick={() => setConfirmingStop(true)}
          >
            Stop
          </Button>
        )}
        {stopJob && confirmingStop && (
          <>
            <span>
              Stop the sync job? Stored {wording.sources} and {wording.items}{' '}
              are kept.
            </span>
            <Button
              variant="outline"
              disabled={stop.isPending}
              onClick={() => stop.mutate(stopJob)}
            >
              {stop.isPending ? 'Stopping...' : 'Confirm stop'}
            </Button>
            <Button
              variant="ghost"
              disabled={stop.isPending}
              onClick={() => setConfirmingStop(false)}
            >
              Back
            </Button>
          </>
        )}
        {data.job && (
          <Link
            href={scopedHref(
              `/jobs?jobId=${encodeURIComponent(data.job.id)}`,
              'subscription',
            )}
          >
            {running ? 'View current job' : 'View last job'}
          </Link>
        )}
      </div>
      <p className="muted">
        The sync runs as a background job; this page can be closed.
      </p>
      <div className="form-actions">
        <label className="flex items-center gap-2">
          Schedule
          <select
            value={data.schedule}
            disabled={!data.account.configured || schedule.isPending}
            onChange={(event) => {
              const parsed = SubscriptionSyncScheduleSchema.safeParse(
                event.target.value,
              )
              if (parsed.success) schedule.mutate(parsed.data)
            }}
          >
            {SubscriptionSyncScheduleSchema.options.map((value) => (
              <option key={value} value={value}>
                {youtubeScheduleLabels[value]}
              </option>
            ))}
          </select>
        </label>
        {data.nextScheduledAt && (
          <span>Next sync {formatDateTime(data.nextScheduledAt)}</span>
        )}
      </div>
    </section>
  )
}

/**
 * Sync status for one provider, with an optional account section above it;
 * refreshes the library when a run ends.
 */
export default function SubscriptionSyncPanel({
  provider,
  account,
}: {
  provider: SubscriptionType
  account?: (status: SubscriptionSyncStatus) => ReactNode
}) {
  const client = useQueryClient()
  const status = useSubscriptionSyncStatus(provider)
  const wording = subscriptionSyncWording[provider]
  const state = status.data?.state ?? null
  const previousState = useRef(state)
  useEffect(() => {
    if (previousState.current === 'running' && state && state !== 'running')
      void invalidateSubscriptionLibrary(client)
    previousState.current = state
  }, [state, client])

  if (status.isPending)
    return (
      <p role="status" className="muted">
        Loading {wording.name} sync...
      </p>
    )
  if (status.isError)
    return (
      <p role="alert">
        Could not load {wording.name} sync.{' '}
        <button onClick={() => status.refetch()}>Retry</button>
      </p>
    )
  if (status.data === null)
    return (
      <p role="status" className="muted">
        {capitalized(wording.name)} sync is not available on this server.
      </p>
    )
  return (
    <>
      {account?.(status.data)}
      <SubscriptionSync status={status.data} />
    </>
  )
}
