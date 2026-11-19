'use client'

import { DetailLink } from './detail-link'
import { useEffect, useId, useRef, type ReactNode } from 'react'
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
  subscriptionLibraryOf,
  subscriptionTypeLabels,
  type SubscriptionLibrary,
  type SubscriptionSyncSchedule,
  type SubscriptionSyncStatus,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { Button } from '@repo/ui/components/ui/button'
import { Label } from '@repo/ui/components/ui/label'
import { Facts, Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import { EMPTY_VALUE, formatCount, formatDateTime } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { fetchApiData } from '@/utils/api'
import { dispatchJobCancellation } from '@/utils/job-bulk-actions'
import { canCancelJob } from '@/utils/job-selection'
import { youtubeScheduleLabels, youtubeSyncPollInterval } from '@/utils/youtube'
import { syncStatusStates } from '@/utils/run-status'
import { subscriptionLibraryPages } from '@/utils/subscriptions'
import { ConfirmAction } from './confirm-action'

type SyncWording = {
  name: string
  sources: string
  items: string
  listing: string
  paused: string
}

/** A station's archive is its shows, then their mixes. */
function stationWording(name: string): SyncWording {
  return {
    name,
    sources: 'shows',
    items: 'mixes',
    listing: 'Reading shows',
    paused: `Paused: the ${name} request limit was reached.`,
  }
}

/** How each provider's sync names its sources and items. */
export const subscriptionSyncWording: Record<SubscriptionType, SyncWording> = {
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
  rinse: stationWording(subscriptionTypeLabels.rinse),
  nts: stationWording(subscriptionTypeLabels.nts),
  lotradio: stationWording(subscriptionTypeLabels.lotradio),
}

const NotAvailableSchema = z.object({ statusCode: z.literal(404) })

function capitalized(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

export function subscriptionSyncQueryKey(provider: SubscriptionType) {
  return ['subscription-sync', provider]
}

type SyncProgress = Pick<
  SubscriptionSyncStatus,
  'provider' | 'state' | 'phase' | 'sourcesDone' | 'sourcesTotal'
>

/**
 * A station run that reads its mixes from a feed has no show total: it
 * counts the feed pages read instead.
 */
function isFeedRun(status: SyncProgress) {
  return (
    status.phase === 'items' &&
    status.sourcesTotal === 0 &&
    subscriptionLibraryOf(status.provider) === 'mixes'
  )
}

/** "12 of 40", the source-list step before sources are counted, or the number of feed pages read. */
export function subscriptionSourceProgress(status: SyncProgress) {
  if (status.state === 'running' && status.phase === 'sources')
    return subscriptionSyncWording[status.provider].listing
  if (status.phase === null) return EMPTY_VALUE
  if (isFeedRun(status)) return formatCount(status.sourcesDone)
  return `${formatCount(status.sourcesDone)} of ${formatCount(status.sourcesTotal)}`
}

/** Refreshes everything a sync can change in its library. */
export function invalidateSubscriptionLibrary(
  client: QueryClient,
  library: SubscriptionLibrary = 'subscriptions',
) {
  return client.invalidateQueries({
    queryKey: [subscriptionLibraryPages[library].collection],
  })
}

/** The provider's sync status, or null when this server has no sync for it. */
export function useSubscriptionSyncStatus(provider: SubscriptionType) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: subscriptionSyncQueryKey(provider),
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
  const scheduleId = useId()
  const wording = subscriptionSyncWording[data.provider]
  const queryKey = subscriptionSyncQueryKey(data.provider)
  const path = `/api/v1/subscriptions/sync/${data.provider}`
  const update = async (next: SubscriptionSyncStatus) => {
    client.setQueryData(queryKey, next)
    await Promise.all([
      client.invalidateQueries({ queryKey: ['jobs'] }),
      client.invalidateQueries({ queryKey: ['job-activity'] }),
    ])
  }
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
  return (
    <Section title="Sync">
      <Facts
        items={[
          {
            label: 'State',
            value: <Status state={syncStatusStates[data.state]} />,
          },
          {
            label: isFeedRun(data)
              ? 'Pages read'
              : `${capitalized(wording.sources)} read`,
            value: subscriptionSourceProgress(data),
          },
          {
            label: `New ${wording.items} this run`,
            value: formatCount(data.newItems),
          },
          {
            label: `Stored ${wording.sources}`,
            value: formatCount(data.storedSources),
          },
          {
            label: `Stored ${wording.items}`,
            value: formatCount(data.storedItems),
          },
          {
            label: 'Last completed',
            value: formatDateTime(data.lastCompletedAt),
          },
        ]}
      />
      {running && data.phase === 'items' && data.sourcesTotal > 0 && (
        <Progress done={data.sourcesDone} total={data.sourcesTotal} />
      )}
      {data.state === 'paused' && (
        <Notice tone="attention">
          {wording.paused}
          {data.resumeAfter &&
            (data.schedule === 'off'
              ? ` Resume after ${formatDateTime(data.resumeAfter)}.`
              : ` The schedule resumes it after ${formatDateTime(data.resumeAfter)}.`)}
        </Notice>
      )}
      {data.state === 'failed' && data.errorMessage && (
        <Notice tone="danger">{data.errorMessage}</Notice>
      )}
      {actionError && (
        <Notice tone="danger">
          {errorMessage(
            actionError,
            `Could not update the ${wording.name} sync.`,
          )}
        </Notice>
      )}
      <span className="ds-actions">
        <Button
          size="md"
          variant="primary"
          disabled={!data.account.connected || running || sync.isPending}
          onClick={() => sync.mutate()}
        >
          {sync.isPending
            ? 'Starting...'
            : resumable
              ? 'Resume sync'
              : 'Sync now'}
        </Button>
        {stopJob && (
          <ConfirmAction
            size="md"
            confirmVariant="danger"
            question="Stop the sync job?"
            details={`Stored ${wording.sources} and ${wording.items} are kept.`}
            confirmLabel="Stop"
            disabled={stop.isPending}
            onConfirm={() => stop.mutate(stopJob)}
          >
            {stop.isPending ? 'Stopping...' : 'Stop'}
          </ConfirmAction>
        )}
        {data.job && (
          <DetailLink kind="job" id={data.job.id}>
            {running ? 'View current job' : 'View last job'}
          </DetailLink>
        )}
      </span>
      <p className="ds-help">
        The sync runs as a background job; this page can be closed.
      </p>
      <div className="sec-form-row">
        <div className="ds-field">
          <Label htmlFor={scheduleId}>Schedule</Label>
          <Select
            id={scheduleId}
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
          </Select>
        </div>
        {data.nextScheduledAt && (
          <span className="ds-help">
            Next sync {formatDateTime(data.nextScheduledAt)}
          </span>
        )}
      </div>
    </Section>
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
      void invalidateSubscriptionLibrary(
        client,
        subscriptionLibraryOf(provider),
      )
    previousState.current = state
  }, [state, client, provider])

  if (status.isPending)
    return (
      <div className="ds-panelpad">
        <Skeleton width="60%" height={40} />
      </div>
    )
  if (status.data === undefined)
    return (
      <div className="sec-notices">
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => status.refetch()}>
              Retry
            </Button>
          }
        >
          Could not load {wording.name} sync.
        </Notice>
      </div>
    )
  if (status.data === null)
    return (
      <div className="sec-notices">
        <Notice>
          {capitalized(wording.name)} sync is not available on this server.
        </Notice>
      </div>
    )
  return (
    <div className="ds-panelpad">
      {account?.(status.data)}
      <SubscriptionSync status={status.data} />
    </div>
  )
}
