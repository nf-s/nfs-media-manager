'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import {
  LastfmSyncStatusSchema,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { driveLastfmSync, lastfmSyncStateLabels } from '@/utils/lastfm-sync'

const ErrorMessageSchema = z.object({ message: z.string().min(1) })

function errorMessage(failure: unknown, fallback: string) {
  const parsed = ErrorMessageSchema.safeParse(failure)
  return parsed.success ? parsed.data.message : fallback
}

function postSync(apiBaseUrl: string, path: string, signal?: AbortSignal) {
  return fetchApiData(apiBaseUrl, path, LastfmSyncStatusSchema, {
    method: 'POST',
    body: '{}',
    signal,
  })
}

function applySyncStatus(client: QueryClient, next: LastfmSyncStatus) {
  client.setQueryData(['lastfm-sync'], next)
  if (next.state !== 'running')
    void client.invalidateQueries({
      predicate: (query) =>
        ['albums', 'album', 'album-listening'].includes(
          String(query.queryKey[0]),
        ),
    })
}

export default function LastfmSync() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [stepError, setStepError] = useState('')
  const status = useQuery({
    queryKey: ['lastfm-sync'],
    staleTime: 0,
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/lastfm/sync', LastfmSyncStatusSchema),
  })
  const update = (next: LastfmSyncStatus) => applySyncStatus(client, next)
  const sync = useMutation({
    mutationFn: () => postSync(apiBaseUrl, '/api/v1/lastfm/sync'),
    onMutate: () => setStepError(''),
    onSuccess: update,
  })
  const stop = useMutation({
    mutationFn: () => postSync(apiBaseUrl, '/api/v1/lastfm/sync/stop'),
    onSuccess: update,
  })
  const running = status.data?.state === 'running'
  useEffect(() => {
    if (!running || stepError) return
    const controller = new AbortController()
    driveLastfmSync({
      signal: controller.signal,
      step: (signal) =>
        postSync(apiBaseUrl, '/api/v1/lastfm/sync/step', signal),
      onStatus: (next) => applySyncStatus(client, next),
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted)
        setStepError(errorMessage(failure, 'Could not continue the sync.'))
    })
    return () => controller.abort()
  }, [running, stepError, apiBaseUrl, client])

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
  const resumable = data.state === 'failed' || data.state === 'stopped'
  const actionError = sync.error ?? stop.error
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
          <dt>Stored scrobbles</dt>
          <dd>{data.storedScrobbles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Linked to library albums</dt>
          <dd>
            {data.matchedScrobbles.toLocaleString()} of{' '}
            {data.storedScrobbles.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Last completed</dt>
          <dd>
            {data.lastCompletedAt
              ? new Date(data.lastCompletedAt).toLocaleString()
              : '-'}
          </dd>
        </div>
      </dl>
      {running && (
        <div role="status">
          <progress
            className="w-full max-w-md"
            value={data.pagesFetched}
            max={data.totalPages ?? undefined}
            aria-label="Sync progress"
          />
          <p className="muted">
            Page {data.pagesFetched.toLocaleString()}
            {data.totalPages === null
              ? ''
              : ` of ${data.totalPages.toLocaleString()}`}{' '}
            · {data.newScrobbles.toLocaleString()} scrobbles added
          </p>
        </div>
      )}
      {data.state === 'failed' && data.errorMessage && (
        <p role="alert">{data.errorMessage}</p>
      )}
      {stepError && (
        <p role="alert">
          {stepError} <button onClick={() => setStepError('')}>Retry</button>
        </p>
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
              : 'Sync scrobbles'}
        </Button>
        {running && (
          <Button
            variant="outline"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            Stop
          </Button>
        )}
      </div>
      <p className="muted">
        The first sync reads the full listening history at about one request per
        second and can take around 20 minutes. On the hosted deployment, keep
        this page open while it runs.
      </p>
    </section>
  )
}
