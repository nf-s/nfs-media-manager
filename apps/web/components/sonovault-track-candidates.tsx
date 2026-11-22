'use client'

import { useEffect, useId, useRef, useState } from 'react'
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { X } from 'lucide-react'
import type { SonovaultTrackLookupJob } from '@repo/schemas/sonovault'
import {
  SonovaultCandidateAcceptResultSchema,
  SonovaultCandidateDecisionInputSchema,
  SonovaultCandidateStatusInputSchema,
  SonovaultCandidateStatusListSchema,
  SonovaultTrackCandidateReviewSchema,
  type SonovaultTrackCandidate,
  type SonovaultTrackCandidateReview,
} from '@repo/schemas/sonovault-candidates'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatDate, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'
import { formatTrackDuration } from '@/utils/track-browse'
import { DetailLink } from './detail-link'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { invalidateSpotifySearchJobs } from './spotify-track-search'
import { TidalTrackIdentity, type TidalReviewTrack } from './tidal-track-match'

const candidatesPath = '/api/v1/sonovault/tracks/candidates'
const candidatesKey = ['tracks', 'sonovault-candidates']
const CANDIDATES = { one: 'candidate', other: 'candidates' }

type CandidateTrack = TidalReviewTrack

function isActiveLookup(job: SonovaultTrackLookupJob | null | undefined) {
  return job?.status === 'queued' || job?.status === 'running'
}

const pending = (review: SonovaultTrackCandidateReview) =>
  review.candidates.filter(({ status }) => status === 'pending')

/** Each page's candidate reviews in batches of at most 100 tracks. */
export function useSonovaultCandidatesForPages(
  pages: readonly (readonly { track?: Pick<TrackListItem, 'id'> | null }[])[],
) {
  const { apiBaseUrl } = useConfig()
  const chunks = pages.flatMap((items) => {
    const ids = [
      ...new Set(items.flatMap(({ track }) => (track ? [track.id] : []))),
    ]
    return Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
      ids.slice(index * 100, (index + 1) * 100),
    )
  })
  const queries = useQueries({
    queries: chunks.map((trackIds) =>
      queryOptions({
        queryKey: [...candidatesKey, 'status', trackIds],
        queryFn: ({ signal }) =>
          fetchApiData(
            apiBaseUrl,
            `${candidatesPath}/status`,
            SonovaultCandidateStatusListSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                SonovaultCandidateStatusInputSchema.parse({ trackIds }),
              ),
              signal,
            },
          ),
        refetchInterval: (query) =>
          query.state.data?.items.some(({ job }) => isActiveLookup(job))
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
    isError: queries.some((query) => query.isError),
  }
}

function useSonovaultCandidates(trackId: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: [...candidatesKey, trackId],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${candidatesPath}/${encodeURIComponent(trackId)}`,
        SonovaultTrackCandidateReviewSchema,
        { signal },
      ),
  })
}

function invalidateCandidates(client: QueryClient) {
  return client.invalidateQueries({ queryKey: candidatesKey })
}

function LookupJobStatus({ job }: { job: SonovaultTrackLookupJob }) {
  return (
    <DetailLink kind="job" id={job.jobId}>
      <Status
        state={job.status === 'succeeded' ? 'done' : job.status}
        title={job.errorMessage ?? undefined}
      />
    </DetailLink>
  )
}

function acceptedLabel(candidate: SonovaultTrackCandidate) {
  return candidate.acceptedBy === 'automatic'
    ? 'Accepted automatically'
    : 'Accepted'
}

/**
 * A table cell: the latest lookup by artist and title, then Review for a
 * candidate waiting for the owner, or what became of the candidates. A dash
 * for a track with a Spotify ID or ISRC, which is looked up by ID instead.
 */
export function SonovaultCandidateCell({
  review,
  track,
  onReview,
}: {
  review: SonovaultTrackCandidateReview
  track: Pick<TrackListItem, 'spotifyTrackId' | 'isrc'>
  onReview: () => void
}) {
  const { job, candidates, notFound } = review
  const accepted = candidates.find(({ status }) => status === 'accepted')
  const waiting = pending(review)
  if (!job && !candidates.length && !notFound)
    return track.spotifyTrackId || track.isrc ? (
      <EmptyValue />
    ) : (
      <Status state="never" />
    )
  return (
    <div className="secondary-cell-actions">
      {job && <LookupJobStatus job={job} />}
      {accepted ? (
        <DetailLink
          kind="track"
          id={review.trackId}
          tab="sources"
          view={{ sourceProvider: 'sonovault' }}
        >
          {acceptedLabel(accepted)}
        </DetailLink>
      ) : waiting.length ? (
        <Button size="xs" aria-haspopup="dialog" onClick={onReview}>
          Review
        </Button>
      ) : candidates.length ? (
        <Status state="attention">Incorrect</Status>
      ) : notFound ? (
        <span className="ds-muted">Not found</span>
      ) : null}
    </div>
  )
}

const decisionLabels = {
  pending: null,
  rejected: 'Incorrect',
} as const

/** What the row says under its title: the decision first, as it may be cut. */
function candidateDetails(candidate: SonovaultTrackCandidate) {
  return [
    candidate.status === 'accepted'
      ? acceptedLabel(candidate)
      : decisionLabels[candidate.status],
    candidate.artists.join(', ') || 'Unknown artist',
    candidate.release
      ? [
          candidate.release,
          candidate.releaseDate ? formatDate(candidate.releaseDate) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Release unknown',
    candidate.durationSec !== null
      ? formatTrackDuration(candidate.durationSec)
      : 'Duration unknown',
    `ISRC ${candidate.isrc ?? 'unknown'}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The candidates, as the TIDAL review lists its tracks: choose a waiting
 * candidate by its title, then accept it or mark it incorrect. A single
 * waiting candidate is chosen already.
 */
function SonovaultCandidates({
  track,
  candidates,
}: {
  track: CandidateTrack
  candidates: readonly SonovaultTrackCandidate[]
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [chosenId, setChosenId] = useState<string | null>(null)
  const waiting = candidates.filter(({ status }) => status === 'pending')
  const chosen =
    waiting.find(({ sonovaultTrackId }) => sonovaultTrackId === chosenId) ??
    (waiting.length === 1 ? waiting[0] : undefined)
  const decide = useMutation({
    retry: false,
    mutationFn: async ({
      candidate,
      decision,
    }: {
      candidate: SonovaultTrackCandidate
      decision: 'accept' | 'reject'
    }) => {
      const init = {
        method: 'POST',
        body: JSON.stringify(
          SonovaultCandidateDecisionInputSchema.parse({
            sonovaultTrackId: candidate.sonovaultTrackId,
          }),
        ),
      }
      const path = `${candidatesPath}/${encodeURIComponent(track.id)}/${decision}`
      if (decision === 'reject')
        return {
          review: await fetchApiData(
            apiBaseUrl,
            path,
            SonovaultTrackCandidateReviewSchema,
            init,
          ),
          spotifyWarning: null,
        }
      return fetchApiData(
        apiBaseUrl,
        path,
        SonovaultCandidateAcceptResultSchema,
        init,
      )
    },
    onSuccess: ({ review }) => {
      setChosenId(null)
      client.setQueryData([...candidatesKey, track.id], review)
    },
    onSettled: async () => {
      await invalidateCandidates(client)
      invalidateSpotifySearchJobs(client)
      await invalidateScrobbleLinks(client)
    },
  })
  const shown = chosen ? [chosen] : candidates
  return (
    <>
      <List compact aria-label="Sonovault candidates">
        {shown.map((candidate) => (
          <ListRow
            key={candidate.sonovaultTrackId}
            thumb={<MediaThumb kind="track" src={null} size={40} />}
            title={
              candidate.status === 'pending' && !chosen ? (
                <RowTitle>
                  <button
                    type="button"
                    title={candidate.title}
                    aria-label={`Review ${candidate.title}${candidate.release ? ` from ${candidate.release}` : ''}`}
                    disabled={decide.isPending}
                    onClick={() => {
                      decide.reset()
                      setChosenId(candidate.sonovaultTrackId)
                    }}
                  >
                    {candidate.title}
                  </button>
                </RowTitle>
              ) : (
                <span className="ds-row-title" title={candidate.title}>
                  {candidate.title}
                </span>
              )
            }
            by={candidateDetails(candidate)}
            action={
              candidate.spotifyUrl ? (
                <ServiceIconLinks
                  links={[
                    {
                      provider: 'spotify',
                      label: 'Spotify',
                      url: candidate.spotifyUrl,
                    },
                  ]}
                />
              ) : undefined
            }
          />
        ))}
      </List>
      {chosen && (
        <div className="dtl-identity">
          <strong>{chosen.title}</strong>
          <span>{chosen.artists.join(', ') || 'Unknown artist'}</span>
          <span className="ds-muted">
            {chosen.release ?? 'Release unknown'}
            {chosen.releaseDate && ` · ${formatDate(chosen.releaseDate)}`}
          </span>
          <span className="ds-muted">
            {chosen.durationSec !== null
              ? formatTrackDuration(chosen.durationSec)
              : 'Duration unknown'}
            {` · ISRC ${chosen.isrc ?? 'unknown'}`}
          </span>
        </div>
      )}
      {chosen && (
        <div className="ds-actions flex-wrap">
          <Button
            variant="primary"
            size="xs"
            aria-label={`Accept ${chosen.title}`}
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate({ candidate: chosen, decision: 'accept' })
            }
          >
            {decide.isPending && decide.variables.decision === 'accept'
              ? 'Saving...'
              : 'Accept'}
          </Button>
          <Button
            size="xs"
            aria-label={`Mark ${chosen.title} as incorrect`}
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate({ candidate: chosen, decision: 'reject' })
            }
          >
            {decide.isPending && decide.variables.decision === 'reject'
              ? 'Saving...'
              : 'Mark incorrect'}
          </Button>
          {waiting.length > 1 && (
            <Button
              size="xs"
              disabled={decide.isPending}
              onClick={() => setChosenId(null)}
            >
              Back
            </Button>
          )}
        </div>
      )}
      {chosen && (
        <p className="ds-help">
          A candidate marked incorrect is not offered again for this track.
        </p>
      )}
      {decide.data?.spotifyWarning && (
        <Notice tone="attention">{decide.data.spotifyWarning}</Notice>
      )}
      {decide.isError && (
        <Notice tone="danger">
          {errorMessage(decide.error, 'Could not save the decision.')}
        </Notice>
      )}
    </>
  )
}

/** A dialog to accept or reject the Sonovault candidates of a track. */
export function SonovaultCandidateReviewDialog({
  track,
  onClose,
}: {
  track: CandidateTrack
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const review = useSonovaultCandidates(track.id)
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
  const accepted = review.data?.candidates.find(
    ({ status }) => status === 'accepted',
  )
  return (
    <dialog
      ref={dialog}
      className="dtl-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="dtl-dialog-inner">
        <div className="ds-inspector-bar">
          <div className="ds-crumbs">
            <b id={titleId}>Sonovault candidates</b>
          </div>
          <Button
            ref={closeButton}
            variant="ghost"
            icon
            aria-label="Close Sonovault candidates"
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="dtl-dialog-body">
          <Section title="Library track" flush>
            <TidalTrackIdentity track={track} />
          </Section>
          {review.isPending && <Skeleton height={48} />}
          {review.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={() => review.refetch()}>
                  Retry
                </Button>
              }
            >
              Could not load the Sonovault candidates.
            </Notice>
          )}
          {review.data && (
            <Section
              title={formatItemCount(review.data.candidates.length, CANDIDATES)}
              note={
                review.data.job ? (
                  <LookupJobStatus job={review.data.job} />
                ) : undefined
              }
            >
              {review.data.candidates.length ? (
                <SonovaultCandidates
                  track={track}
                  candidates={review.data.candidates}
                />
              ) : (
                <p className="ds-muted">No Sonovault candidates.</p>
              )}
              {accepted?.spotifyJobId && (
                <p className="ds-help">
                  The Spotify track is read and matched in{' '}
                  <DetailLink kind="job" id={accepted.spotifyJobId}>
                    a Spotify track job
                  </DetailLink>
                  . A conflict leaves it for review in Sources.
                </p>
              )}
            </Section>
          )}
        </div>
      </div>
    </dialog>
  )
}
