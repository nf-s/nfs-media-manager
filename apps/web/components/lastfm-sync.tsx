'use client'

import { DetailLink } from './detail-link'
import Link from 'next/link'
import { useEffect, useId, useRef } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { BulkCancelJobsResultSchema } from '@repo/schemas/job'
import {
  LastfmSyncScheduleSchema,
  LastfmSyncStatusSchema,
  type LastfmSyncSchedule,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { Label } from '@repo/ui/components/ui/label'
import { Facts, Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { dispatchJobCancellation } from '@/utils/job-bulk-actions'
import { canCancelJob } from '@/utils/job-selection'
import {
  lastfmScheduleLabels,
  lastfmSyncPollInterval,
} from '@/utils/lastfm-sync'
import { syncStatusStates } from '@/utils/run-status'
import { ConfirmAction } from './confirm-action'

const ErrorMessageSchema = z.object({ message: z.string().min(1) })

export function errorMessage(failure: unknown, fallback: string) {
  const parsed = ErrorMessageSchema.safeParse(failure)
  return parsed.success ? parsed.data.message : fallback
}

/** Refreshes derived data without refetching a track just removed by a merge. */
export async function invalidateScrobbleLinks(
  client: QueryClient,
  deletedTrackId?: string,
) {
  if (deletedTrackId !== undefined) {
    const queryKey = ['track', deletedTrackId]
    await client.cancelQueries({ queryKey, exact: true })
    await client.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: 'none',
    })
  }
  return client.invalidateQueries({
    predicate: (query) =>
      !(
        deletedTrackId !== undefined &&
        query.queryKey.length === 2 &&
        query.queryKey[0] === 'track' &&
        query.queryKey[1] === deletedTrackId
      ) &&
      ([
        'albums',
        'album',
        'album-listening',
        'lastfm-links',
        'tracks',
        'track',
        'playlists',
        'playlist',
        'album-playlists',
      ].includes(String(query.queryKey[0])) ||
        // Of an artist's queries only its listening chart counts scrobbles.
        (query.queryKey[0] === 'artist' &&
          query.queryKey[2] === 'listening-series')),
  })
}

/** Relinks stored scrobbles and imports their tracks without provider requests. */
export async function refreshScrobbleLinks(
  apiBaseUrl: string,
  client: QueryClient,
) {
  const next = await fetchApiData(
    apiBaseUrl,
    '/api/v1/lastfm/links/refresh',
    LastfmSyncStatusSchema,
    { method: 'POST', body: '{}' },
  )
  client.setQueryData(['lastfm-sync'], next)
  await invalidateScrobbleLinks(client)
  return next
}

export function useLastfmSyncStatus() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['lastfm-sync'],
    refetchInterval: (query) =>
      lastfmSyncPollInterval(query.state.data?.state ?? null),
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/lastfm/sync', LastfmSyncStatusSchema),
  })
}

export default function LastfmSync({
  trackLibrary = false,
}: {
  trackLibrary?: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const scheduleId = useId()
  const status = useLastfmSyncStatus()
  const update = async (next: LastfmSyncStatus) => {
    client.setQueryData(['lastfm-sync'], next)
    await Promise.all([
      client.invalidateQueries({ queryKey: ['jobs'] }),
      client.invalidateQueries({ queryKey: ['job-activity'] }),
    ])
  }
  const sync = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/lastfm/sync', LastfmSyncStatusSchema, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: update,
  })
  const schedule = useMutation({
    mutationFn: (value: LastfmSyncSchedule) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/lastfm/sync/settings',
        LastfmSyncStatusSchema,
        { method: 'PUT', body: JSON.stringify({ schedule: value }) },
      ),
    onSuccess: update,
  })
  const stop = useMutation({
    mutationFn: async (job: NonNullable<LastfmSyncStatus['job']>) => {
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
      await client.invalidateQueries({ queryKey: ['lastfm-sync'] })
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
    },
  })
  const state = status.data?.state ?? null
  const previousState = useRef(state)
  useEffect(() => {
    if (previousState.current === 'running' && state && state !== 'running')
      void invalidateScrobbleLinks(client)
    previousState.current = state
  }, [state, client])

  if (status.isPending)
    return (
      <div className="ds-panelpad">
        <Skeleton width="60%" height={40} />
      </div>
    )
  if (!status.data)
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
          Could not load Last.fm sync.
        </Notice>
      </div>
    )
  const data = status.data
  const running = data.state === 'running'
  const resumable = data.state === 'failed' || data.state === 'stopped'
  const stopJob =
    running && data.job && canCancelJob(data.job) ? data.job : null
  const actionError = sync.error ?? stop.error ?? schedule.error
  return (
    <div className="ds-panelpad">
      <Section title="Sync" flush>
        {!data.configured && (
          <Notice tone="attention">
            Add the Last.fm API key and username in{' '}
            <Link href="/providers/lastfm">
              {trackLibrary
                ? 'shared Last.fm settings in Albums'
                : 'Last.fm provider settings'}
            </Link>
            .
          </Notice>
        )}
        <Facts
          items={[
            {
              label: 'State',
              value: <Status state={syncStatusStates[data.state]} />,
            },
            {
              label: 'Pages fetched',
              value: `${formatCount(data.pagesFetched)}${
                data.totalPages === null
                  ? ''
                  : ` of ${formatCount(data.totalPages)}`
              }`,
            },
            {
              label: 'New scrobbles this run',
              value: formatCount(data.newScrobbles),
            },
            {
              label: 'Stored scrobbles',
              value: formatCount(data.storedScrobbles),
            },
            ...(trackLibrary
              ? []
              : [
                  {
                    label: 'Album-linked scrobbles',
                    value: `${formatCount(data.matchedScrobbles)} of ${formatCount(data.storedScrobbles)}`,
                  },
                ]),
            {
              label: 'Last completed',
              value: formatDateTime(data.lastCompletedAt),
            },
          ]}
        />
        {running && data.totalPages !== null && (
          <Progress done={data.pagesFetched} total={data.totalPages} />
        )}
        {data.state === 'failed' && data.errorMessage && (
          <Notice tone="danger">{data.errorMessage}</Notice>
        )}
        {actionError && (
          <Notice tone="danger">
            {errorMessage(actionError, 'Could not update the Last.fm sync.')}
          </Notice>
        )}
        <span className="ds-actions">
          <Button
            size="md"
            variant="primary"
            disabled={!data.configured || running || sync.isPending}
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
              details="Stored scrobbles are kept."
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
              disabled={!data.configured || schedule.isPending}
              onChange={(event) => {
                const parsed = LastfmSyncScheduleSchema.safeParse(
                  event.target.value,
                )
                if (parsed.success) schedule.mutate(parsed.data)
              }}
            >
              {LastfmSyncScheduleSchema.options.map((value) => (
                <option key={value} value={value}>
                  {lastfmScheduleLabels[value]}
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
        <p className="ds-help">
          The schedule does not start the first sync or resume a failed or
          stopped one.
        </p>
      </Section>
    </div>
  )
}
