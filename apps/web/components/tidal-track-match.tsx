'use client'

import { useEffect, useId, useRef, useState } from 'react'
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { X } from 'lucide-react'
import { z } from 'zod'
import { AlbumDetailSchema } from '@repo/schemas/media'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  TIDAL_TRACK_MATCH_REQUEST_LIMIT,
  TidalTrackMatchAcceptInputSchema,
  TidalTrackMatchInputSchema,
  TidalTrackMatchReviewSchema,
  TidalTrackMatchRunSchema,
  TidalTrackMatchStatusInputSchema,
  TidalTrackMatchStatusSchema,
  type TidalTrackCandidate,
  type TidalSimilarEdition,
  type TidalTrackMatch,
  type TidalTrackMatchJob,
  type TidalTrackMatchReview,
  type TidalTrackMatchRun,
} from '@repo/schemas/tidal'
import type { TrackDetail, TrackListItem } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { EmptyValue, ProviderMark } from '@repo/ui/components/ds/pill'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { SourceBlock, SourceRow } from '@repo/ui/components/ds/source'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import {
  formatAge,
  formatCount,
  formatDate,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { providerLogoUrl } from '@/utils/provider-logos'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'
import { formatTrackDuration } from '@/utils/track-browse'
import { ConfirmAction } from './confirm-action'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { invalidateSpotifySearchJobs } from './spotify-track-search'

const TRACKS = { one: 'track', other: 'tracks' }
const MATCHES = { one: 'match', other: 'matches' }
const tidalMatchPath = '/api/v1/tidal/tracks/match'
const tidalMatchKey = ['tracks', 'tidal-track-match']
const albumTypeLabels = { ALBUM: 'Album', EP: 'EP', SINGLE: 'Single' }

export type TidalReviewTrack = Pick<
  TrackListItem,
  'id' | 'title' | 'artists' | 'albumName' | 'durationSec' | 'isrc' | 'album'
>

export function isActiveTidalTrackMatch(
  job: TidalTrackMatchJob | null | undefined,
) {
  return job?.status === 'queued' || job?.status === 'running'
}

/** A lookup with several TIDAL tracks left for the owner to choose from. */
export function needsTidalReview(job: TidalTrackMatchJob | null | undefined) {
  return (
    job?.status === 'succeeded' &&
    job.reason === 'ambiguous' &&
    !job.acceptedTidalTrackId
  )
}

export function useTidalTrackMatch(trackId: string, enabled = true) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: [...tidalMatchKey, trackId],
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${tidalMatchPath}/${encodeURIComponent(trackId)}`,
        TidalTrackMatchReviewSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      isActiveTidalTrackMatch(query.state.data?.job)
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
}

/** Each page's statuses in batches of at most 100 tracks. */
export function useTidalTrackMatchStatusForPages(
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
        queryKey: [...tidalMatchKey, 'status', trackIds],
        queryFn: ({ signal }) =>
          fetchApiData(
            apiBaseUrl,
            `${tidalMatchPath}/status`,
            TidalTrackMatchStatusSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                TidalTrackMatchStatusInputSchema.parse({ trackIds }),
              ),
              signal,
            },
          ),
        refetchInterval: (query) =>
          query.state.data?.items.some(({ job }) =>
            isActiveTidalTrackMatch(job),
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
    isError: queries.some((query) => query.isError),
    retry: () => void Promise.all(queries.map((query) => query.refetch())),
  }
}

/**
 * Matches tracks on TIDAL in the request and stores each result with the
 * track's TIDAL match.
 */
export function useMatchTidalTracks() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: {
      trackIds: string[]
      batchId?: string
      catalogScope?: CatalogScopeQuery
    }) =>
      fetchApiData(apiBaseUrl, tidalMatchPath, TidalTrackMatchRunSchema, {
        method: 'POST',
        body: JSON.stringify(
          TidalTrackMatchInputSchema.parse({
            ...input,
            confirmBroadRun: input.trackIds.length > 5,
          }),
        ),
      }),
    onSuccess: (run) => {
      for (const item of run.items)
        client.setQueryData([...tidalMatchKey, item.trackId], item)
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: tidalMatchKey }),
        invalidateSpotifySearchJobs(client),
      ]),
  })
}

type MatchTally = {
  matched: number
  review: number
  unmatched: number
  skipped: number
  warnings: string[]
}

function tallyRun(tally: MatchTally, run: TidalTrackMatchRun): MatchTally {
  const review = run.items.filter(
    (item) => !item.match && needsTidalReview(item.job),
  ).length
  const matched = run.items.filter((item) => item.match).length
  return {
    matched: tally.matched + matched,
    review: tally.review + review,
    unmatched: tally.unmatched + run.items.length - matched - review,
    skipped: tally.skipped + run.skipped,
    warnings: [...new Set([...tally.warnings, ...run.warnings])],
  }
}

/**
 * Matches a table's selection on TIDAL, a few tracks per request: its status
 * for the selection bar and the action that starts it. A rate limit or error
 * stops the rest of the selection, which stays selected.
 */
export function useTidalTrackMatchSelection({
  onSelect,
  onPendingChange,
  catalogScope,
}: {
  onSelect: (ids: string[]) => void
  onPendingChange: (pending: boolean) => void
  catalogScope?: CatalogScopeQuery
}) {
  const match = useMatchTidalTracks()
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const run = useMutation({
    retry: false,
    mutationFn: async (selected: string[]) => {
      const ids = [...new Set(selected)]
      const batchId = crypto.randomUUID()
      let tally: MatchTally = {
        matched: 0,
        review: 0,
        unmatched: 0,
        skipped: 0,
        warnings: [],
      }
      let done = 0
      setProgress({ done, total: ids.length })
      for (
        let offset = 0;
        offset < ids.length;
        offset += TIDAL_TRACK_MATCH_REQUEST_LIMIT
      ) {
        const chunk = ids.slice(
          offset,
          offset + TIDAL_TRACK_MATCH_REQUEST_LIMIT,
        )
        try {
          const result = await match.mutateAsync({
            trackIds: chunk,
            batchId,
            catalogScope,
          })
          tally = tallyRun(tally, result)
          done += chunk.length - result.notRun
          setProgress({ done, total: ids.length })
          if (result.notRun) break
        } catch (error) {
          if (!done) throw error
          tally = {
            ...tally,
            warnings: [
              ...tally.warnings,
              errorMessage(error, 'Could not match the rest on TIDAL.'),
            ],
          }
          break
        }
      }
      return { ...tally, remaining: ids.slice(done) }
    },
    onMutate: () => onPendingChange(true),
    onSuccess: ({ remaining }) => onSelect(remaining),
    onSettled: () => onPendingChange(false),
  })
  const status = run.isPending ? (
    <span role="status">
      Matching on TIDAL · {formatCount(progress.done)} of{' '}
      {formatCount(progress.total)}
    </span>
  ) : run.isError ? (
    <span role="alert">
      {errorMessage(run.error, 'Could not match on TIDAL.')}
    </span>
  ) : run.data ? (
    <span role="status">
      TIDAL: {formatCount(run.data.matched)} matched ·{' '}
      {formatCount(run.data.review)} to review ·{' '}
      {formatCount(run.data.unmatched)} not matched ·{' '}
      {formatCount(run.data.skipped)} skipped
      {run.data.remaining.length > 0 &&
        ` · ${formatCount(run.data.remaining.length)} not started`}
      .
      {run.data.warnings.map((warning) => (
        <span key={warning} className="block">
          {warning}
        </span>
      ))}
    </span>
  ) : null
  return {
    status,
    pending: run.isPending,
    action: (selectedIds: string[], disabled: boolean) => (
      <ConfirmAction
        confirm={selectedIds.length > 5}
        question={`Match ${formatItemCount(selectedIds.length, TRACKS)} on TIDAL?`}
        details="Each track with an ISRC is matched now with one TIDAL request, at most one every 1.5 seconds. Tracks without an ISRC are skipped."
        confirmLabel="Match on TIDAL"
        disabled={disabled || run.isPending || !selectedIds.length}
        onConfirm={() => run.mutate(selectedIds)}
      >
        Match on TIDAL
      </ConfirmAction>
    ),
  }
}

export function TidalTrackMatchJobStatus({ job }: { job: TidalTrackMatchJob }) {
  return (
    <DetailLink kind="job" id={job.jobId}>
      <Status
        state={job.status === 'succeeded' ? 'done' : job.status}
        title={job.errorMessage ?? undefined}
      />
    </DetailLink>
  )
}

const matchSources = {
  'tidal-album': 'Album track list',
  'tidal-track-match': 'ISRC match',
  'tidal-similar': 'Similar suggestion',
}

function SimilarEditionEvidence({ edition }: { edition: TidalSimilarEdition }) {
  return (
    <>
      {edition.code && `ISRC ${edition.code} · `}
      <DetailLink kind="track" id={edition.sourceItemId} tab="similar">
        Source track
      </DetailLink>
      {edition.jobId && (
        <>
          {' '}
          ·{' '}
          <DetailLink
            kind="job"
            id={edition.jobId}
            view={
              edition.responseId
                ? { jobResponse: edition.responseId }
                : undefined
            }
          >
            Source job
          </DetailLink>
        </>
      )}
    </>
  )
}

/** The track's current TIDAL track, with its link and how it was found. */
export function TidalTrackMatchLine({ match }: { match: TidalTrackMatch }) {
  return (
    <span className="ds-cell-id">
      <ServiceIconLinks
        links={[{ provider: 'tidal', label: 'TIDAL', url: match.url }]}
      />
      <span>
        {[
          `TIDAL track ${match.tidalTrackId}`,
          match.version,
          match.durationSec !== null
            ? formatTrackDuration(match.durationSec)
            : null,
          match.matchReason === 'manual'
            ? 'Chosen in review'
            : matchSources[match.source],
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </span>
  )
}

/**
 * A table cell: the latest job's status, then the current match with its
 * TIDAL link, or Review. A dash for a track TIDAL cannot match.
 */
export function TidalTrackMatchCell({
  status,
  isrc,
  onReview,
  disabled,
}: {
  status: TidalTrackMatchReview
  isrc: string | null
  onReview?: () => void
  disabled?: boolean
}) {
  const { job, match, trackId } = status
  if (!job && !match) return isrc ? <Status state="never" /> : <EmptyValue />
  return (
    <div className="secondary-cell-actions">
      {job && <TidalTrackMatchJobStatus job={job} />}
      {match ? (
        <>
          <DetailLink
            kind="track"
            id={trackId}
            tab="sources"
            view={{ sourceProvider: 'tidal' }}
          >
            Matched
          </DetailLink>
          <ServiceIconLinks
            links={[{ provider: 'tidal', label: 'TIDAL', url: match.url }]}
          />
        </>
      ) : needsTidalReview(job) && onReview ? (
        <Button
          size="xs"
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={onReview}
        >
          Review
        </Button>
      ) : null}
    </div>
  )
}

export function libraryAlbumUpcs(album: z.infer<typeof AlbumDetailSchema>) {
  return new Set(
    album.providerReferences.flatMap((reference) =>
      reference.referenceType === 'upc'
        ? [reference.externalId.trim().padStart(14, '0')]
        : [],
    ),
  )
}

/** The UPCs of the track's library album, for marking candidates on it. */
export function useLibraryAlbumUpcs(albumId: string | null | undefined) {
  const { apiBaseUrl } = useConfig()
  const album = useQuery({
    queryKey: ['album', albumId],
    enabled: Boolean(albumId),
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/albums/${encodeURIComponent(albumId ?? '')}`,
        AlbumDetailSchema,
        { signal },
      ),
  })
  return album.data ? libraryAlbumUpcs(album.data) : new Set<string>()
}

function candidateTitle(candidate: TidalTrackCandidate) {
  return candidate.version && !candidate.title.includes(candidate.version)
    ? `${candidate.title} (${candidate.version})`
    : candidate.title
}

export function TidalTrackCandidates({
  candidates,
  upcs,
  disabled,
  onChoose,
}: {
  candidates: readonly TidalTrackCandidate[]
  upcs: ReadonlySet<string>
  disabled?: boolean
  onChoose?: (candidate: TidalTrackCandidate) => void
}) {
  return (
    <List compact aria-label="TIDAL track matches">
      {candidates.map((candidate) => {
        const title = candidateTitle(candidate)
        const onLibraryAlbum = candidate.albums.some(
          (album) =>
            album.barcodeId !== null &&
            upcs.has(album.barcodeId.trim().padStart(14, '0')),
        )
        return (
          <ListRow
            key={candidate.tidalTrackId}
            thumb={<MediaThumb kind="track" src={null} size={40} />}
            title={
              onChoose ? (
                <RowTitle>
                  <button
                    type="button"
                    title={title}
                    aria-label={`Review ${title}${candidate.albums[0] ? ` from ${candidate.albums[0].title}` : ''}`}
                    disabled={disabled}
                    onClick={() => onChoose(candidate)}
                  >
                    {title}
                  </button>
                </RowTitle>
              ) : (
                <span className="ds-row-title" title={title}>
                  {title}
                </span>
              )
            }
            by={[
              onLibraryAlbum ? 'Library album UPC' : null,
              ...candidate.albums.map((album) =>
                [
                  album.title,
                  album.albumType ? albumTypeLabels[album.albumType] : null,
                  album.releaseDate ? formatDate(album.releaseDate) : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              ),
              candidate.durationSec !== null
                ? formatTrackDuration(candidate.durationSec)
                : null,
              candidate.streamable ? null : 'Not streamable',
            ]
              .filter(Boolean)
              .join(' · ')}
            action={
              <ServiceIconLinks
                links={[
                  { provider: 'tidal', label: 'TIDAL', url: candidate.url },
                ]}
              />
            }
          />
        )
      })}
    </List>
  )
}

export function useAcceptTidalTrackMatch(trackId: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...tidalMatchKey, trackId, 'accept'],
    retry: false,
    mutationFn: (input: { jobId: string; tidalTrackId: string }) =>
      fetchApiData(
        apiBaseUrl,
        `${tidalMatchPath}/${encodeURIComponent(trackId)}/accept`,
        TidalTrackMatchReviewSchema,
        {
          method: 'POST',
          body: JSON.stringify(TidalTrackMatchAcceptInputSchema.parse(input)),
        },
      ),
    onSuccess: (review) =>
      client.setQueryData([...tidalMatchKey, trackId], review),
    onSettled: () => invalidateSpotifySearchJobs(client),
  })
}

/** The latest lookup: its candidates to choose from, or the track it chose. */
export function TidalTrackMatchBody({
  track,
  review,
  upcs,
}: {
  track: TidalReviewTrack
  review: TidalTrackMatchReview
  upcs: ReadonlySet<string>
}) {
  const accept = useAcceptTidalTrackMatch(track.id)
  const [chosen, setChosen] = useState<TidalTrackCandidate | null>(null)
  const { job, candidates, match } = review
  if (match)
    return (
      <>
        <TidalTrackMatchLine match={match} />
        {match.recommendation && (
          <p className="ds-help">
            <SimilarEditionEvidence edition={match.recommendation} />
          </p>
        )}
      </>
    )
  if (!job) return <p className="ds-muted">No TIDAL match yet.</p>
  if (isActiveTidalTrackMatch(job))
    return <TidalTrackMatchJobStatus job={job} />
  if (job.status !== 'succeeded')
    return (
      <p className="ds-muted">
        <TidalTrackMatchJobStatus job={job} /> {job.errorMessage}
      </p>
    )
  const reviewing = needsTidalReview(job)
  const confirmation =
    reviewing &&
    chosen &&
    candidates.some(({ tidalTrackId }) => tidalTrackId === chosen.tidalTrackId)
      ? chosen
      : null
  return (
    <>
      <TidalTrackCandidates
        candidates={confirmation ? [confirmation] : candidates}
        upcs={upcs}
        disabled={accept.isPending}
        onChoose={
          reviewing && !confirmation
            ? (candidate) => {
                accept.reset()
                setChosen(candidate)
              }
            : undefined
        }
      />
      {confirmation && (
        <div className="ds-actions flex-wrap">
          <Button
            variant="primary"
            size="xs"
            disabled={accept.isPending}
            onClick={() =>
              accept.mutate({
                jobId: job.jobId,
                tidalTrackId: confirmation.tidalTrackId,
              })
            }
          >
            {accept.isPending ? 'Saving...' : 'Choose'}
          </Button>
          <Button
            size="xs"
            disabled={accept.isPending}
            onClick={() => setChosen(null)}
          >
            Back
          </Button>
        </div>
      )}
      {accept.isError && (
        <Notice tone="danger">
          {errorMessage(accept.error, 'Could not save the TIDAL match.')}
        </Notice>
      )}
    </>
  )
}

export function TidalTrackIdentity({ track }: { track: TidalReviewTrack }) {
  return (
    <div className="dtl-identity">
      <strong>{track.title}</strong>
      <span>{track.artists.join(', ') || 'Unknown artist'}</span>
      <span className="ds-muted">
        {track.albumName ?? 'Album unknown'}
        {track.durationSec !== null &&
          ` · ${formatTrackDuration(track.durationSec)}`}
      </span>
      <span className="ds-muted">ISRC {track.isrc ?? 'unknown'}</span>
    </div>
  )
}

/** A dialog to choose among the TIDAL tracks a lookup left for review. */
export function TidalTrackMatchReviewDialog({
  track,
  onClose,
}: {
  track: TidalReviewTrack
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const review = useTidalTrackMatch(track.id)
  const upcs = useLibraryAlbumUpcs(track.album?.id)
  const match = useMatchTidalTracks()
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
  const job = review.data?.job
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
            <b id={titleId}>TIDAL match</b>
          </div>
          <Button
            ref={closeButton}
            variant="ghost"
            icon
            aria-label="Close TIDAL match"
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
              Could not load the TIDAL match.
            </Notice>
          )}
          {review.data && (
            <Section
              title={
                review.data.candidates.length
                  ? formatItemCount(review.data.candidates.length, MATCHES)
                  : 'TIDAL'
              }
              aside={
                track.isrc &&
                !isActiveTidalTrackMatch(job) &&
                !needsTidalReview(job) &&
                !review.data.match && (
                  <Button
                    size="xs"
                    disabled={match.isPending}
                    onClick={() => match.mutate({ trackIds: [track.id] })}
                  >
                    Match on TIDAL
                  </Button>
                )
              }
            >
              <TidalTrackMatchBody
                track={track}
                review={review.data}
                upcs={upcs}
              />
              {match.isError && (
                <Notice tone="danger">
                  {errorMessage(match.error, 'Could not match on TIDAL.')}
                </Notice>
              )}
            </Section>
          )}
        </div>
      </div>
    </dialog>
  )
}

/** The track's TIDAL row in Sources: its match, or the lookup to review. */
export function TrackTidalSource({ item }: { item: TrackDetail }) {
  const view = useDetailView()
  const [open, setOpen] = useState(
    view.params.get('sourceProvider') === 'tidal',
  )
  const sourceParams = new URLSearchParams(view.params)
  sourceParams.set('sourceProvider', 'tidal')
  sourceParams.set('tab', 'sources')
  const review = useTidalTrackMatch(item.id)
  const match = useMatchTidalTracks()
  const upcs = useLibraryAlbumUpcs(open ? item.album?.id : null)
  const isrc = item.isrc ?? item.isrcs[0]?.isrc ?? null
  const track = { ...item, isrc }
  const job = review.data?.job
  const matched = review.data?.match?.tidalTrackId ?? null
  const reviewing = !matched && needsTidalReview(job)
  const time = job?.finishedAt ?? job?.createdAt
  const label = matched
    ? 'Matched'
    : reviewing
      ? 'Review'
      : isrc
        ? 'Unmatched'
        : 'No ISRC'
  return (
    <>
      <SourceRow
        name="TIDAL"
        open={open}
        onToggle={setOpen}
        summaryProps={workspaceTabLinkProps(
          view.workspaceHref(sourceParams),
          'TIDAL',
        )}
        mark={
          <ProviderMark name="TIDAL" src={providerLogoUrl('tidal')} hidden />
        }
        match={<Status state={matched ? 'done' : 'attention'}>{label}</Status>}
        identifier={matched ?? undefined}
        when={
          time && (
            <time dateTime={time} title={formatDateTime(time)}>
              {formatAge(time)}
            </time>
          )
        }
        state={
          match.isPending ? (
            <Status state="running">Matching</Status>
          ) : (
            job && <TidalTrackMatchJobStatus job={job} />
          )
        }
        actions={
          <>
            {reviewing && (
              <Button
                size="xs"
                aria-expanded={open}
                onClick={() => setOpen(true)}
              >
                Review
              </Button>
            )}
            {isrc &&
              !matched &&
              !reviewing &&
              !isActiveTidalTrackMatch(job) && (
                <Button
                  size="xs"
                  disabled={match.isPending || review.isPending}
                  onClick={() => match.mutate({ trackIds: [item.id] })}
                >
                  Match on TIDAL
                </Button>
              )}
          </>
        }
      >
        <SourceBlock title={reviewing ? 'TIDAL matches' : 'TIDAL match'}>
          {isrc ? (
            <p className="ds-help">ISRC {isrc}</p>
          ) : (
            <p className="ds-help">TIDAL matches tracks by ISRC.</p>
          )}
          {review.isPending && <Skeleton height={48} />}
          {review.data && (
            <TidalTrackMatchBody
              track={track}
              review={review.data}
              upcs={upcs}
            />
          )}
        </SourceBlock>
        {Boolean(review.data?.similarEditions?.length) && (
          <SourceBlock title="Other TIDAL editions from Similar Tracks">
            <List compact aria-label="Other TIDAL editions">
              {review.data?.similarEditions?.map((edition) => (
                <ListRow
                  key={edition.tidalTrackId}
                  thumb={<MediaThumb kind="track" src={null} size={40} />}
                  title={
                    <span className="ds-row-title">
                      TIDAL track {edition.tidalTrackId}
                    </span>
                  }
                  by={<SimilarEditionEvidence edition={edition} />}
                  action={
                    <ServiceIconLinks
                      links={[
                        { provider: 'tidal', label: 'TIDAL', url: edition.url },
                      ]}
                    />
                  }
                />
              ))}
            </List>
          </SourceBlock>
        )}
      </SourceRow>
      {(review.isError || match.isError) && (
        <Notice
          tone="danger"
          action={
            review.isError && (
              <Button size="xs" onClick={() => review.refetch()}>
                Retry
              </Button>
            )
          }
        >
          {review.isError
            ? 'Could not load the TIDAL match.'
            : errorMessage(match.error, 'Could not match on TIDAL.')}
        </Notice>
      )}
    </>
  )
}
