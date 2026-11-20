'use client'

import Link from 'next/link'
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
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SPOTIFY_TRACK_SEARCH_MARKET_REQUIRED,
  SpotifyTrackSearchAcceptInputSchema,
  SpotifyTrackSearchAcceptResultSchema,
  SpotifyTrackSearchInputSchema,
  SpotifyTrackSearchMarketSchema,
  SpotifyTrackSearchQuerySchema,
  SpotifyTrackSearchSchema,
  SpotifyTrackSearchStatusInputSchema,
  SpotifyTrackSearchStatusSchema,
  SpotifyTrackSearchTargetConflictSchema,
  type SpotifyTrackSearchCandidate,
  type SpotifyTrackSearchFreshness,
  type SpotifyTrackSearchInput,
  type SpotifyTrackSearchJob,
} from '@repo/schemas/spotify-track-search'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
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

function queueSpotifyTrackSearch(
  apiBaseUrl: string,
  input: SpotifyTrackSearchInput,
) {
  return fetchApiData(apiBaseUrl, spotifySearchPath, EnrichmentResultSchema, {
    method: 'POST',
    body: JSON.stringify(SpotifyTrackSearchInputSchema.parse(input)),
  })
}

const tabMarketKey = 'spotify-track-search:market'

function rememberedMarket() {
  try {
    return window.sessionStorage.getItem(tabMarketKey)
  } catch {
    return null
  }
}

/** Offer a market in place when the installation only has Spotify app credentials. */
export function useQueueSpotifyTrackSearch() {
  const { apiBaseUrl } = useConfig()
  const [market, setMarket] = useState<string | null>(null)
  const [failureMessage, setFailureMessage] = useState('')
  const marketNeeded = market !== null
  async function queue(input: SpotifyTrackSearchInput) {
    setFailureMessage('')
    const selected = SpotifyTrackSearchMarketSchema.safeParse(
      market ?? rememberedMarket(),
    )
    try {
      const result = await queueSpotifyTrackSearch(apiBaseUrl, {
        ...input,
        ...(selected.success ? { market: selected.data } : {}),
      })
      if (marketNeeded && selected.success) {
        try {
          window.sessionStorage.setItem(tabMarketKey, selected.data)
        } catch {
          // Searching also works when the browser disables session storage.
        }
        setMarket(null)
      }
      return result
    } catch (failure) {
      const message = errorMessage(
        failure,
        'Could not queue the Spotify search.',
      )
      if (message === SPOTIFY_TRACK_SEARCH_MARKET_REQUIRED)
        setMarket((value) => value ?? '')
      else setFailureMessage(message)
      throw failure
    }
  }
  return {
    queue,
    failureMessage,
    marketNeeded,
    invalidMarket:
      marketNeeded && !SpotifyTrackSearchMarketSchema.safeParse(market).success,
    marketField: marketNeeded && (
      <label className="ds-field">
        <span className="ds-label">Spotify market</span>
        <Input
          aria-label="Spotify market"
          value={market}
          placeholder="AU"
          maxLength={2}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setMarket(event.target.value.toUpperCase())}
        />
        <span className="ds-help">
          Enter a two-letter country code, then search again. This tab will
          remember it.
        </span>
      </label>
    ),
  }
}

export function invalidateSpotifySearchJobs(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['tracks'] }),
    client.invalidateQueries({ queryKey: ['jobs'] }),
    client.invalidateQueries({ queryKey: ['job-activity'] }),
  ])
}

/** The stored search remains readable by its original ID after an exact match reuses a library recording. */
export function useSavedSpotifyTrackSearch(trackId: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: [...spotifySearchKey, trackId],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${spotifySearchPath}/${encodeURIComponent(trackId)}`,
        SpotifyTrackSearchSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      isActiveSpotifyTrackSearch(query.state.data?.job)
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
}

export function isActiveSpotifyTrackSearch(
  job: SpotifyTrackSearchJob | null | undefined,
) {
  return job?.status === 'queued' || job?.status === 'running'
}

export function useSpotifyTrackSearchStatus(trackIds: readonly string[]) {
  return useSpotifyTrackSearchStatusGroups([trackIds])
}

export function useSpotifyTrackSearchStatusForPages(
  pages: readonly (readonly { track?: Pick<TrackListItem, 'id'> | null }[])[],
) {
  // Keep each page's batch stable as the visible rows change around it.
  return useSpotifyTrackSearchStatusGroups(
    pages.map((items) =>
      items.flatMap(({ track }) => (track ? [track.id] : [])),
    ),
  )
}

function useSpotifyTrackSearchStatusGroups(
  groups: readonly (readonly string[])[],
) {
  const { apiBaseUrl } = useConfig()
  const chunks = groups.flatMap((group) => {
    const ids = [...new Set(group)]
    return Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
      ids.slice(index * 100, (index + 1) * 100),
    )
  })
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
  const search = useQueueSpotifyTrackSearch()
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
          search.queue({
            trackIds: chunk,
            batchId: batch,
            confirmBroadRun: ids.length > 5,
            freshness,
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
        await invalidateSpotifySearchJobs(client)
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
        {search.marketField}
        {search.failureMessage && (
          <span role="alert">{search.failureMessage}</span>
        )}
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
        {queue.data &&
          ((!search.marketNeeded && !search.failureMessage) ||
            queue.data.completed.length > 0) && (
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
              details="Each track uses one search job. Unique exact matches link automatically."
              confirmLabel="Search Spotify tracks"
              disabled={disabled || queue.isPending || search.invalidMarket}
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

export function SpotifyTrackSearchJobStatus({
  job,
}: {
  job: SpotifyTrackSearchJob
}) {
  return (
    <DetailLink kind="job" id={job.jobId}>
      <Status
        state={job.status === 'succeeded' ? 'done' : job.status}
        title={job.errorMessage ?? undefined}
      />
    </DetailLink>
  )
}

export function SpotifyTrackSearchResult({
  job,
  onReview,
  disabled,
  currentTrackId,
}: {
  job: SpotifyTrackSearchJob
  onReview?: () => void
  disabled?: boolean
  currentTrackId?: string
}) {
  if (job.status !== 'succeeded') return null
  if (job.acceptedTrackId) {
    if (job.acceptedTrackId === currentTrackId) return null
    return (
      <DetailLink kind="track" id={job.acceptedTrackId} tab="sources">
        {job.matchMethod === 'automatic'
          ? 'Matched automatically'
          : 'Matched track'}
      </DetailLink>
    )
  }
  if (!job.resultCount)
    return (
      <span className="ds-muted">
        {job.resultCount === null ? 'Search skipped' : 'No matches'}
      </span>
    )
  return (
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
  )
}

export function SpotifyTrackSearchJobCell(props: {
  job: SpotifyTrackSearchJob | null | undefined
  onReview?: () => void
  disabled?: boolean
}) {
  if (!props.job) return <Status state="never" />
  return (
    <div className="secondary-cell-actions">
      <SpotifyTrackSearchJobStatus job={props.job} />
      <SpotifyTrackSearchResult
        job={props.job}
        onReview={props.onReview}
        disabled={props.disabled}
      />
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

const targetConflictStatus = 409
const TargetConflictErrorSchema = z.object({
  statusCode: z.literal(targetConflictStatus),
  data: SpotifyTrackSearchTargetConflictSchema,
})

export function SpotifyTrackSearchConfirmation({
  candidate,
  failure,
  pending,
  onConfirm,
  onChooseAnother,
  onClose,
}: {
  candidate: SpotifyTrackSearchCandidate
  failure: unknown
  pending: boolean
  onConfirm: () => void
  onChooseAnother: () => void
  onClose: () => void
}) {
  const parsed = TargetConflictErrorSchema.safeParse(failure)
  const conflict = parsed.success ? parsed.data.data : undefined
  return (
    <>
      <Section title="Spotify track to link">
        <TrackIdentity track={candidate} />
        {!conflict && (
          <p className="ds-help">
            Link this Spotify track to the recording and keep its listening
            history.
          </p>
        )}
      </Section>
      {failure != null && (
        <Notice tone="danger">
          {errorMessage(failure, 'Could not save the Spotify match.')}
          {conflict && (
            <>
              {' '}
              <DetailLink
                kind="track"
                id={conflict.trackId}
                tab="sources"
                className="underline break-words"
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.shiftKey
                  )
                    onClose()
                }}
              >
                Open Sources for {conflict.title}
              </DetailLink>
            </>
          )}
        </Notice>
      )}
      <div className="ds-actions flex-wrap">
        <Button
          variant="primary"
          disabled={pending || Boolean(conflict)}
          onClick={onConfirm}
        >
          {pending ? 'Saving...' : 'Confirm Spotify match'}
        </Button>
        <Button disabled={pending} onClick={onChooseAnother}>
          Choose another track
        </Button>
      </div>
    </>
  )
}

export function SpotifyTrackSearchReview({
  track,
  onClose,
  onMatched,
  onSearchLibrary,
  searchMode,
}: {
  track: SearchTrack
  onClose: () => void
  onMatched: (targetId: string) => void
  onSearchLibrary?: () => void
  searchMode?: 'edit-query' | 'review-results'
}) {
  const { apiBaseUrl } = useConfig()
  const catalog = useQueueSpotifyTrackSearch()
  const client = useQueryClient()
  const path = `${spotifySearchPath}/${encodeURIComponent(track.id)}`
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState(() =>
    [track.title, ...track.artists].join(' ').slice(0, 200).trim(),
  )
  const [chosen, setChosen] = useState<{
    jobId: string
    candidate: SpotifyTrackSearchCandidate
  } | null>(null)
  const search = useSavedSpotifyTrackSearch(track.id)
  const queue = useMutation({
    retry: false,
    mutationFn: (query: string) =>
      catalog.queue({ trackIds: [track.id], query }),
    onSuccess: () => setChosen(null),
    onSettled: () => invalidateSpotifySearchJobs(client),
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
          errorData: {
            status: targetConflictStatus,
            schema: SpotifyTrackSearchTargetConflictSchema,
          },
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
      await invalidateScrobbleLinks(
        client,
        track.id !== targetId ? track.id : undefined,
      )
    },
  })
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    if (searchMode === 'edit-query') searchInput.current?.focus()
    else closeButton.current?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [searchMode])
  const job = search.data?.job
  const candidates = search.data?.candidates ?? []
  const query = SpotifyTrackSearchQuerySchema.safeParse(draft)
  const canSubmit =
    query.success &&
    !catalog.invalidMarket &&
    !search.isPending &&
    !queue.isPending &&
    !accept.isPending &&
    !isActiveSpotifyTrackSearch(job)
  return (
    <dialog
      ref={dialog}
      className={searchMode ? 'sec-drawer' : 'dtl-dialog'}
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
      <div className={searchMode ? 'ds-inspector' : 'dtl-dialog-inner'}>
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
        <div className={searchMode ? 'ds-inspector-body' : 'dtl-dialog-body'}>
          <Section title="Library track" flush>
            <TrackIdentity track={track} />
          </Section>
          {searchMode && (
            <Section>
              <form
                className="data-stack"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (canSubmit && query.success) queue.mutate(query.data)
                }}
              >
                <label className="ds-field">
                  <span className="ds-label">Search Spotify</span>
                  <Input
                    ref={searchInput}
                    type="search"
                    value={draft}
                    maxLength={200}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </label>
                {catalog.marketField}
                <div className="ds-actions">
                  <Button type="submit" disabled={!canSubmit}>
                    {queue.isPending ? 'Queueing…' : 'Search'}
                  </Button>
                  {onSearchLibrary && (
                    <Button
                      type="button"
                      disabled={accept.isPending}
                      onClick={onSearchLibrary}
                    >
                      Search library tracks
                    </Button>
                  )}
                </div>
              </form>
              {catalog.failureMessage && (
                <Notice tone="danger">{catalog.failureMessage}</Notice>
              )}
              {queue.data?.skipped ? (
                <p role="status" className="ds-help">
                  {queue.data.warnings.join(' ')}
                </p>
              ) : null}
            </Section>
          )}
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
          {queue.isPending ? (
            <Skeleton height={48} />
          ) : job?.acceptedTrackId ? (
            <SpotifyTrackSearchResult job={job} />
          ) : chosen && chosen.jobId === job?.jobId ? (
            <SpotifyTrackSearchConfirmation
              candidate={chosen.candidate}
              failure={accept.error}
              pending={accept.isPending}
              onConfirm={() => accept.mutate(chosen)}
              onChooseAnother={() => setChosen(null)}
              onClose={onClose}
            />
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
                        <button
                          type="button"
                          title={candidate.title}
                          aria-label={`Review ${candidate.title}${candidate.albumName ? ` from ${candidate.albumName}` : ''}`}
                          onClick={() => {
                            accept.reset()
                            setChosen({ jobId: job.jobId, candidate })
                          }}
                        >
                          {candidate.title}
                        </button>
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
                      <ServiceIconLinks
                        links={[
                          {
                            provider: 'spotify',
                            label: 'Spotify',
                            url: candidate.spotifyUrl,
                          },
                        ]}
                      />
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
