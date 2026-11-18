'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { X } from 'lucide-react'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SpotifyTrackSearchAcceptInputSchema,
  SpotifyTrackSearchAcceptResultSchema,
  SpotifyTrackSearchInputSchema,
  SpotifyTrackSearchSchema,
  SpotifyTrackSearchStatusInputSchema,
  SpotifyTrackSearchStatusSchema,
  type SpotifyTrackSearchCandidate,
  type SpotifyTrackSearchFreshness,
  type SpotifyTrackSearchJob,
} from '@repo/schemas/spotify-track-search'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'
import { scopedHref } from '@/utils/media-scope'
import { formatTrackDuration } from '@/utils/track-browse'
import { ConfirmAction } from './confirm-action'
import { DetailLink } from './detail-link'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import { useConfig } from './providers'
import { SecondaryTableSelectionBar } from './secondary-table'
import ServiceIconLinks from './service-icon-links'

const TRACKS = { one: 'track', other: 'tracks' }
const MATCHES = { one: 'match', other: 'matches' }
const spotifySearchPath = '/api/v1/spotify/tracks/search'
const spotifySearchKey = ['tracks', 'spotify-track-search']

export function isActiveSpotifyTrackSearch(
  job: SpotifyTrackSearchJob | null | undefined,
) {
  return job?.status === 'queued' || job?.status === 'running'
}

export function useSpotifyTrackSearchStatus(trackIds: readonly string[]) {
  const { apiBaseUrl } = useConfig()
  const ids = [...new Set(trackIds)]
  const chunks = Array.from(
    { length: Math.ceil(ids.length / 100) },
    (_, index) => ids.slice(index * 100, (index + 1) * 100),
  )
  const queries = useQueries({
    queries: chunks.map((trackIds) =>
      queryOptions({
        queryKey: [...spotifySearchKey, 'status', trackIds],
        queryFn: ({ signal }) =>
          fetchApiData(
            apiBaseUrl,
            `${spotifySearchPath}/status`,
            SpotifyTrackSearchStatusSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                SpotifyTrackSearchStatusInputSchema.parse({ trackIds }),
              ),
              signal,
            },
          ),
        refetchInterval: (query) =>
          query.state.data?.items.some(({ job }) =>
            isActiveSpotifyTrackSearch(job),
          )
            ? LASTFM_SYNC_POLL_MS
            : false,
      }),
    ),
  })
  return {
    byId: new Map(
      queries.flatMap(({ data }) =>
        (data?.items ?? []).map((item) => [item.trackId, item]),
      ),
    ),
    isPending: queries.some((query) => query.isPending),
    isError: queries.some((query) => query.isError),
    retry: () => void Promise.all(queries.map((query) => query.refetch())),
  }
}

export function SpotifyTrackSearchSelectionBar({
  selectedIds,
  onSelect,
  onPendingChange,
  freshness,
  disabled = false,
  total,
}: {
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onPendingChange: (pending: boolean) => void
  freshness?: SpotifyTrackSearchFreshness
  disabled?: boolean
  total?: number
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [batchId, setBatchId] = useState('')
  const [progress, setProgress] = useState(0)
  const broad = selectedIds.length > 5
  const queue = useMutation({
    retry: false,
    mutationFn: (ids: string[]) => {
      const batch = crypto.randomUUID()
      setBatchId(batch)
      return dispatchFilmSelection(
        ids,
        (chunk) =>
          fetchApiData(apiBaseUrl, spotifySearchPath, EnrichmentResultSchema, {
            method: 'POST',
            body: JSON.stringify(
              SpotifyTrackSearchInputSchema.parse({
                trackIds: chunk,
                batchId: batch,
                confirmBroadRun: ids.length > 5,
                freshness,
              }),
            ),
          }),
        setProgress,
      )
    },
    onMutate: () => {
      setProgress(0)
      onPendingChange(true)
    },
    onSuccess: (result, ids) => {
      const completed = new Set(result.completed)
      onSelect(ids.filter((id) => !completed.has(id)))
    },
    onSettled: async () => {
      try {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['tracks'] }),
          client.invalidateQueries({ queryKey: ['jobs'] }),
          client.invalidateQueries({ queryKey: ['job-activity'] }),
        ])
      } finally {
        onPendingChange(false)
      }
    },
  })
  if (!selectedIds.length && !queue.isPending && !queue.isError && !queue.data)
    return null
  return (
    <SecondaryTableSelectionBar
      selectedCount={selectedIds.length}
      total={total}
      hideWhenEmpty
    >
      <div className="sec-selectbar-actions">
        {queue.isPending && (
          <span role="status">
            Queueing searches · {formatCount(progress)} confirmed
          </span>
        )}
        {queue.isError && (
          <span role="alert">
            {errorMessage(
              queue.error,
              'Could not queue Spotify track searches.',
            )}
          </span>
        )}
        {queue.data && (
          <span role="status">
            {formatCount(queue.data.queued)} queued ·{' '}
            {formatCount(queue.data.skipped)} skipped.{' '}
            {batchId && (queue.data.queued > 0 || queue.data.interrupted) && (
              <Link
                href={scopedHref(
                  `/jobs?batchId=${encodeURIComponent(batchId)}`,
                  'track',
                )}
              >
                View search jobs
              </Link>
            )}
            {queue.data.warnings.map((warning) => (
              <span key={warning} className="block">
                {warning}
              </span>
            ))}
          </span>
        )}
        {selectedIds.length > 0 && (
          <span className="ds-actions">
            <Button
              size="xs"
              variant="ghost"
              disabled={queue.isPending}
              onClick={() => onSelect([])}
            >
              Clear selection
            </Button>
            <ConfirmAction
              variant="primary"
              confirm={broad}
              question={`Search Spotify for ${formatItemCount(selectedIds.length, TRACKS)}?`}
              details="Each search uses Spotify's request limits. Review the saved matches before linking a track."
              confirmLabel="Search Spotify tracks"
              disabled={disabled || queue.isPending}
              onConfirm={() => queue.mutate(selectedIds)}
            >
              Search Spotify tracks
            </ConfirmAction>
          </span>
        )}
      </div>
    </SecondaryTableSelectionBar>
  )
}

export function SpotifyTrackSearchJobCell({
  job,
  onReview,
  disabled,
}: {
  job: SpotifyTrackSearchJob | null | undefined
  onReview?: () => void
  disabled?: boolean
}) {
  if (!job) return <Status state="never" />
  const succeeded = job.status === 'succeeded'
  return (
    <div className="secondary-cell-actions">
      <DetailLink kind="job" id={job.jobId}>
        <Status
          state={job.status === 'succeeded' ? 'done' : job.status}
          title={job.errorMessage ?? undefined}
        />
      </DetailLink>
      {job.acceptedTrackId && (
        <DetailLink kind="track" id={job.acceptedTrackId} tab="sources">
          Matched track
        </DetailLink>
      )}
      {succeeded &&
        !job.acceptedTrackId &&
        (job.resultCount ? (
          onReview && (
            <Button
              size="xs"
              aria-haspopup="dialog"
              disabled={disabled}
              onClick={onReview}
            >
              Review matches
            </Button>
          )
        ) : (
          <span className="ds-muted">
            {job.resultCount === null ? 'Search skipped' : 'No matches'}
          </span>
        ))}
    </div>
  )
}

type SearchTrack = Pick<
  TrackListItem,
  'id' | 'title' | 'artists' | 'albumName' | 'durationSec'
>

function TrackIdentity({
  track,
}: {
  track: Omit<SearchTrack, 'id'> & { spotifyUrl?: string; isrc?: string | null }
}) {
  return (
    <div className="dtl-identity">
      <span className="ds-cell-id">
        <strong>{track.title}</strong>
        {track.spotifyUrl && (
          <ServiceIconLinks
            links={[
              { provider: 'spotify', label: 'Spotify', url: track.spotifyUrl },
            ]}
          />
        )}
      </span>
      <span>{track.artists.join(', ') || 'Unknown artist'}</span>
      <span className="ds-muted">
        {track.albumName ?? 'Album unknown'}
        {track.durationSec !== null &&
          ` · ${formatTrackDuration(track.durationSec)}`}
      </span>
      {track.isrc && <span className="ds-muted">ISRC {track.isrc}</span>}
    </div>
  )
}

export function SpotifyTrackSearchReview({
  track,
  onClose,
  onMatched,
}: {
  track: SearchTrack
  onClose: () => void
  onMatched: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const path = `${spotifySearchPath}/${encodeURIComponent(track.id)}`
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [chosen, setChosen] = useState<{
    jobId: string
    candidate: SpotifyTrackSearchCandidate
  } | null>(null)
  const search = useQuery({
    queryKey: [...spotifySearchKey, track.id],
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, path, SpotifyTrackSearchSchema, { signal }),
    refetchInterval: (query) =>
      isActiveSpotifyTrackSearch(query.state.data?.job)
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
  const accept = useMutation({
    retry: false,
    mutationFn: (input: NonNullable<typeof chosen>) =>
      fetchApiData(
        apiBaseUrl,
        `${path}/accept`,
        SpotifyTrackSearchAcceptResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            SpotifyTrackSearchAcceptInputSchema.parse({
              jobId: input.jobId,
              spotifyTrackId: input.candidate.spotifyTrackId,
            }),
          ),
        },
      ),
    onSuccess: async ({ targetId }) => {
      onMatched(targetId)
      onClose()
      await invalidateScrobbleLinks(client)
    },
  })
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    closeButton.current?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  const job = search.data?.job
  const candidates = search.data?.candidates ?? []
  return (
    <dialog
      ref={dialog}
      className="dtl-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!accept.isPending) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!accept.isPending && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="dtl-dialog-inner">
        <div className="ds-inspector-bar">
          <div className="ds-crumbs">
            <b id={titleId}>Spotify track search</b>
          </div>
          <Button
            ref={closeButton}
            variant="ghost"
            icon
            aria-label="Close Spotify track search"
            disabled={accept.isPending}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="dtl-dialog-body">
          <Section title="Library track" flush>
            <TrackIdentity track={track} />
          </Section>
          {search.isPending && <Skeleton height={48} />}
          {search.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={() => search.refetch()}>
                  Retry
                </Button>
              }
            >
              Could not load the saved Spotify search.
            </Notice>
          )}
          {accept.isError && (
            <Notice tone="danger">
              {errorMessage(accept.error, 'Could not save the Spotify match.')}
            </Notice>
          )}
          {chosen ? (
            <>
              <Section title="Spotify track to link">
                <TrackIdentity track={chosen.candidate} />
                <p className="ds-help">
                  Link this Spotify track to the recording and keep its
                  listening history.
                </p>
              </Section>
              <div className="ds-actions">
                <Button
                  variant="primary"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate(chosen)}
                >
                  {accept.isPending ? 'Saving...' : 'Confirm Spotify match'}
                </Button>
                <Button
                  disabled={accept.isPending}
                  onClick={() => {
                    setChosen(null)
                    accept.reset()
                  }}
                >
                  Choose another track
                </Button>
              </div>
            </>
          ) : job?.status === 'succeeded' && candidates.length > 0 ? (
            <Section title={formatItemCount(candidates.length, MATCHES)}>
              <List compact aria-label="Spotify track matches">
                {candidates.map((candidate) => (
                  <ListRow
                    key={candidate.spotifyTrackId}
                    thumb={
                      <MediaThumb
                        kind="track"
                        src={candidate.artworkUrl}
                        size={40}
                      />
                    }
                    title={
                      <RowTitle>
                        <span title={candidate.title}>{candidate.title}</span>
                      </RowTitle>
                    }
                    by={[
                      candidate.artists.join(', '),
                      candidate.albumName,
                      candidate.durationSec !== null
                        ? formatTrackDuration(candidate.durationSec)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    action={
                      <span className="ds-actions">
                        <ServiceIconLinks
                          links={[
                            {
                              provider: 'spotify',
                              label: 'Spotify',
                              url: candidate.spotifyUrl,
                            },
                          ]}
                        />
                        <Button
                          size="xs"
                          aria-label={`Review ${candidate.title}${candidate.albumName ? ` from ${candidate.albumName}` : ''}`}
                          onClick={() =>
                            setChosen({ jobId: job.jobId, candidate })
                          }
                        >
                          Review
                        </Button>
                      </span>
                    }
                  />
                ))}
              </List>
            </Section>
          ) : (
            search.isSuccess && (
              <Section>
                {job ? (
                  <SpotifyTrackSearchJobCell job={job} />
                ) : (
                  <p>No saved Spotify search.</p>
                )}
              </Section>
            )
          )}
        </div>
      </div>
    </dialog>
  )
}
