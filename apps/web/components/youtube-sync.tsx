'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { BulkCancelJobsResultSchema } from '@repo/schemas/job'
import {
  YoutubeDisconnectResultSchema,
  YoutubeSyncScheduleSchema,
  YoutubeSyncStatusSchema,
  type YoutubeSyncSchedule,
  type YoutubeSyncStatus,
} from '@repo/schemas/youtube'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { fetchApiData } from '@/utils/api'
import { dispatchJobCancellation } from '@/utils/job-bulk-actions'
import { canCancelJob } from '@/utils/job-selection'
import { scopedHref } from '@/utils/media-scope'
import {
  youtubeChannelProgress,
  youtubeScheduleLabels,
  youtubeSyncPollInterval,
  youtubeSyncStateLabels,
} from '@/utils/youtube'
import { youtubeAuthorizationUrl } from '@/utils/youtube-authorize'

export const YOUTUBE_PROVIDER_SETTINGS_HREF =
  '/providers?provider=youtube&section=credentials'

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

/** Refreshes everything a sync can change. */
export function invalidateYoutubeLibrary(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) =>
      ['youtube-channels', 'youtube-videos'].includes(
        String(query.queryKey[0]),
      ),
  })
}

export function useYoutubeSyncStatus() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['youtube-sync'],
    staleTime: 0,
    refetchInterval: (query) =>
      youtubeSyncPollInterval(query.state.data?.state ?? null),
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/youtube/sync', YoutubeSyncStatusSchema),
  })
}

export function YoutubeAccount({ status }: { status: YoutubeSyncStatus }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const outcome = useSearchParams().get('youtube')
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const authorize = useMutation({
    mutationFn: () => youtubeAuthorizationUrl(apiBaseUrl),
    onSuccess: (url) => window.location.assign(url),
  })
  const disconnect = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/youtube/account',
        YoutubeDisconnectResultSchema,
        { method: 'DELETE' },
      ),
    onSettled: async () => {
      setConfirmingDisconnect(false)
      await client.invalidateQueries({ queryKey: ['youtube-sync'] })
    },
  })
  const { account } = status
  return (
    <section className="film-import-workflow" aria-labelledby="youtube-account">
      <h2 id="youtube-account">Account</h2>
      {!account.configured && (
        <p role="alert">
          Add the OAuth client ID, client secret and redirect URI in{' '}
          <Link href={YOUTUBE_PROVIDER_SETTINGS_HREF}>
            YouTube provider settings
          </Link>
          .
        </p>
      )}
      {account.configured && !account.connected && (
        <div className="form-actions">
          <Button
            disabled={authorize.isPending}
            onClick={() => authorize.mutate()}
          >
            {authorize.isPending ? 'Opening Google...' : 'Connect YouTube'}
          </Button>
          <span className="muted">
            Requests read-only access to your subscriptions.
          </span>
        </div>
      )}
      {account.connected && (
        <div className="form-actions">
          <span>Connected.</span>
          {!confirmingDisconnect && (
            <>
              <Button
                variant="outline"
                disabled={authorize.isPending || disconnect.isPending}
                onClick={() => authorize.mutate()}
              >
                {authorize.isPending ? 'Opening Google...' : 'Reconnect'}
              </Button>
              <Button
                variant="outline"
                disabled={authorize.isPending || disconnect.isPending}
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </Button>
            </>
          )}
          {confirmingDisconnect && (
            <>
              <span>
                Disconnect YouTube? Stored channels and videos are kept.
              </span>
              <Button
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {disconnect.isPending
                  ? 'Disconnecting...'
                  : 'Confirm disconnect'}
              </Button>
              <Button
                variant="ghost"
                disabled={disconnect.isPending}
                onClick={() => setConfirmingDisconnect(false)}
              >
                Back
              </Button>
            </>
          )}
        </div>
      )}
      {account.configured && account.redirectUri && !account.connected && (
        <p className="muted">
          Redirect URI: <code>{account.redirectUri}</code>
        </p>
      )}
      {authorize.isError && (
        <p role="alert">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </p>
      )}
      {disconnect.isError && (
        <p role="alert">
          {errorMessage(disconnect.error, 'Could not disconnect YouTube.')}
        </p>
      )}
      {outcome === 'connected' && <p role="status">YouTube connected.</p>}
      {outcome === 'error' && (
        <p role="alert">YouTube did not connect. Try again.</p>
      )}
    </section>
  )
}

export function YoutubeSync({ status: data }: { status: YoutubeSyncStatus }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [confirmingStop, setConfirmingStop] = useState(false)
  const update = (next: YoutubeSyncStatus) =>
    client.setQueryData(['youtube-sync'], next)
  const sync = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/youtube/sync',
        YoutubeSyncStatusSchema,
        {
          method: 'POST',
          body: '{}',
        },
      ),
    onSuccess: update,
  })
  const schedule = useMutation({
    mutationFn: (value: YoutubeSyncSchedule) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/youtube/sync/settings',
        YoutubeSyncStatusSchema,
        { method: 'PUT', body: JSON.stringify({ schedule: value }) },
      ),
    onSuccess: update,
  })
  const stop = useMutation({
    mutationFn: async (job: NonNullable<YoutubeSyncStatus['job']>) => {
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
      await client.invalidateQueries({ queryKey: ['youtube-sync'] })
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
    <section className="film-import-workflow" aria-labelledby="youtube-sync">
      <h2 id="youtube-sync">Sync</h2>
      <dl className="detail-metrics">
        <div>
          <dt>State</dt>
          <dd>{youtubeSyncStateLabels[data.state]}</dd>
        </div>
        <div>
          <dt>Channels read</dt>
          <dd>{youtubeChannelProgress(data)}</dd>
        </div>
        <div>
          <dt>New videos this run</dt>
          <dd>{data.newVideos.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Stored channels</dt>
          <dd>{data.storedChannels.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Stored videos</dt>
          <dd>{data.storedVideos.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last completed</dt>
          <dd>{formatDateTime(data.lastCompletedAt)}</dd>
        </div>
      </dl>
      {running && (
        <progress
          className="w-full max-w-md"
          value={data.phase === 'videos' ? data.channelsDone : undefined}
          max={
            data.phase === 'videos' && data.channelsTotal
              ? data.channelsTotal
              : undefined
          }
          aria-label="Sync progress"
        />
      )}
      {data.state === 'paused' && (
        <p role="status">
          Paused: the daily YouTube API quota is used up.
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
          {errorMessage(actionError, 'Could not update the YouTube sync.')}
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
            <span>Stop the sync job? Stored channels and videos are kept.</span>
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
            disabled={!data.account.configured || schedule.isPending}
            onChange={(event) => {
              const parsed = YoutubeSyncScheduleSchema.safeParse(
                event.target.value,
              )
              if (parsed.success) schedule.mutate(parsed.data)
            }}
          >
            {YoutubeSyncScheduleSchema.options.map((value) => (
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

/** Account connection and sync status; refreshes channels and videos when a run ends. */
export default function YoutubeSyncPanel() {
  const client = useQueryClient()
  const status = useYoutubeSyncStatus()
  const state = status.data?.state ?? null
  const previousState = useRef(state)
  useEffect(() => {
    if (previousState.current === 'running' && state && state !== 'running')
      void invalidateYoutubeLibrary(client)
    previousState.current = state
  }, [state, client])

  if (status.isPending)
    return (
      <p role="status" className="muted">
        Loading YouTube sync...
      </p>
    )
  if (status.isError)
    return (
      <p role="alert">
        Could not load YouTube sync.{' '}
        <button onClick={() => status.refetch()}>Retry</button>
      </p>
    )
  return (
    <>
      <YoutubeAccount status={status.data} />
      <YoutubeSync status={status.data} />
    </>
  )
}
