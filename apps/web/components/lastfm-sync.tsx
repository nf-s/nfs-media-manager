'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
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
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { dispatchJobCancellation } from '@/utils/job-bulk-actions'
import { canCancelJob } from '@/utils/job-selection'
import {
  lastfmScheduleLabels,
  lastfmSyncPollInterval,
  lastfmSyncStateLabels,
} from '@/utils/lastfm-sync'
import { scopedHref } from '@/utils/media-scope'

const ErrorMessageSchema = z.object({ message: z.string().min(1) })

export function errorMessage(failure: unknown, fallback: string) {
  const parsed = ErrorMessageSchema.safeParse(failure)
  return parsed.success ? parsed.data.message : fallback
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

/** Refreshes everything derived from scrobble links. */
export function invalidateScrobbleLinks(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) =>
      [
        'albums',
        'album',
        'album-listening',
        'lastfm-links',
        'tracks',
        'track',
        'playlists',
        'playlist',
        'album-playlists',
      ].includes(String(query.queryKey[0])),
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
    staleTime: 0,
    refetchInterval: (query) =>
      lastfmSyncPollInterval(query.state.data?.state ?? null),
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/lastfm/sync', LastfmSyncStatusSchema),
  })
}

export default function LastfmSync() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [confirmingStop, setConfirmingStop] = useState(false)
  const status = useLastfmSyncStatus()
  const update = (next: LastfmSyncStatus) =>
    client.setQueryData(['lastfm-sync'], next)
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
      setConfirmingStop(false)
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
      <p role="status" className="muted">
        Loading Last.fm sync...
      </p>
    )
  if (status.isError)
    return (
      <p role="alert">
        Could not load Last.fm sync.{' '}
        <button onClick={() => status.refetch()}>Retry</button>
      </p>
    )
  const data = status.data
  const running = data.state === 'running'
  const resumable = data.state === 'failed' || data.state === 'stopped'
  const stopJob =
    running && data.job && canCancelJob(data.job) ? data.job : null
  const actionError = sync.error ?? stop.error ?? schedule.error
  return (
    <section className="film-import-workflow">
      {!data.configured && (
        <p role="alert">
          Add the Last.fm API key and username in{' '}
          <Link href="/providers?provider=lastfm&mediaType=album">
            Last.fm provider settings
          </Link>
          .
        </p>
      )}
      <dl className="detail-metrics">
        <div>
          <dt>State</dt>
          <dd>{lastfmSyncStateLabels[data.state]}</dd>
        </div>
        <div>
          <dt>Pages fetched</dt>
          <dd>
            {data.pagesFetched.toLocaleString()}
            {data.totalPages === null
              ? ''
              : ` of ${data.totalPages.toLocaleString()}`}
          </dd>
        </div>
        <div>
          <dt>New scrobbles this run</dt>
          <dd>{data.newScrobbles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Stored scrobbles</dt>
          <dd>{data.storedScrobbles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Linked scrobbles</dt>
          <dd>
            {data.matchedScrobbles.toLocaleString()} of{' '}
            {data.storedScrobbles.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Last completed</dt>
          <dd>{formatDateTime(data.lastCompletedAt)}</dd>
        </div>
      </dl>
      {running && (
        <progress
          className="w-full max-w-md"
          value={data.pagesFetched}
          max={data.totalPages ?? undefined}
          aria-label="Sync progress"
        />
      )}
      {data.state === 'failed' && data.errorMessage && (
        <p role="alert">{data.errorMessage}</p>
      )}
      {actionError && (
        <p role="alert">
          {errorMessage(actionError, 'Could not update the Last.fm sync.')}
        </p>
      )}
      <div className="form-actions">
        <Button
          disabled={!data.configured || running || sync.isPending}
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
            <span>Stop the sync job? Stored scrobbles are kept.</span>
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
              'album',
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
          </select>
        </label>
        {data.nextScheduledAt && (
          <span>Next sync {formatDateTime(data.nextScheduledAt)}</span>
        )}
      </div>
      <p className="muted">
        The schedule does not start the first sync or resume a failed or stopped
        one.
      </p>
    </section>
  )
}
