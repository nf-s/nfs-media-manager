'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  SPOTIFY_TRACK_SEARCH_MARKET_REQUIRED,
  SpotifyInteractiveTrackSearchInputSchema,
  SpotifyInteractiveTrackSearchResultSchema,
  SpotifyTrackSearchAcceptInputSchema,
  SpotifyTrackSearchAcceptResultSchema,
  SpotifyTrackSearchInputSchema,
  SpotifyTrackSearchMarketSchema,
  SpotifyTrackSearchQuerySchema,
  SpotifyTrackSearchSchema,
  SpotifyTrackSearchStatusInputSchema,
  SpotifyTrackSearchStatusSchema,
  SpotifyTrackSearchTargetConflictSchema,
  type SpotifyTrackSearch,
  type SpotifyTrackSearchCandidate,
  type SpotifyTrackSearchFreshness,
  type SpotifyTrackSearchInput,
  type SpotifyTrackSearchJob,
  type SpotifyTrackSearchStatus,
} from '@repo/schemas/spotify-track-search'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
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
function useSpotifyTrackSearchMarket() {
  const [market, setMarket] = useState<string | null>(null)
  const [failureMessage, setFailureMessage] = useState('')
  const marketNeeded = market !== null
  async function withMarket<T>(
    search: (market: string | undefined) => Promise<T>,
    fallback: string,
  ) {
    setFailureMessage('')
    const selected = SpotifyTrackSearchMarketSchema.safeParse(
      market ?? rememberedMarket(),
    )
    try {
      const result = await search(selected.data)
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
      const message = errorMessage(failure, fallback)
      if (message === SPOTIFY_TRACK_SEARCH_MARKET_REQUIRED)
        setMarket((value) => value ?? '')
      else setFailureMessage(message)
      throw failure
    }
  }
  return {
    withMarket,
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

export function useQueueSpotifyTrackSearch() {
  const { apiBaseUrl } = useConfig()
  const market = useSpotifyTrackSearchMarket()
  return {
    ...market,
    queue: (input: SpotifyTrackSearchInput) =>
      market.withMarket(
        (selected) =>
          queueSpotifyTrackSearch(apiBaseUrl, {
            ...input,
            ...(selected ? { market: selected } : {}),
          }),
        'Could not queue the Spotify search.',
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

/** Read saved direct results and the legacy job history for the recording. */
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
  catalogScope,
  disabled = false,
  total,
  otherStatus,
  otherActions,
}: {
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onPendingChange: (pending: boolean) => void
  freshness?: SpotifyTrackSearchFreshness
  catalogScope?: CatalogScopeQuery
  disabled?: boolean
  total?: number
  /** Another provider's queueing status and actions for the same selection. */
  otherStatus?: ReactNode
  otherActions?: ReactNode
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
            catalogScope,
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
  if (
    !selectedIds.length &&
    !queue.isPending &&
    !queue.isError &&
    !queue.data &&
    !otherStatus
  )
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
        {otherStatus}
        {selectedIds.length > 0 && (
          <span className="ds-actions flex-wrap">
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
            {otherActions}
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
  return (
    <SpotifyTrackSearchResultAction
      resultCount={job.resultCount}
      disabled={disabled}
      onReview={onReview}
    />
  )
}

function SpotifyTrackSearchResultAction({
  resultCount,
  onReview,
  disabled,
}: {
  resultCount: number | null
  onReview?: () => void
  disabled?: boolean
}) {
  if (!resultCount)
    return (
      <span className="ds-muted">
        {resultCount === null ? 'Search skipped' : 'No matches'}
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
  interactive?: SpotifyTrackSearchStatus['items'][number]['interactive']
  onReview?: () => void
  disabled?: boolean
}) {
  const { interactive } = props
  if (interactive && !isActiveSpotifyTrackSearch(props.job)) {
    const succeeded = interactive.status === 'succeeded'
    return (
      <div className="secondary-cell-actions">
        <Status state={succeeded ? 'done' : 'failed'} />
        {succeeded && (
          <SpotifyTrackSearchResultAction
            resultCount={interactive.resultCount}
            onReview={props.onReview}
            disabled={props.disabled}
          />
        )}
      </div>
    )
  }
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
> & { isrc?: string | null }

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

type SearchReceipt = { jobId: string } | { searchId: string }
export type SpotifyTrackSearchSelection = SearchReceipt & {
  candidate: SpotifyTrackSearchCandidate
}

export function searchReceiptId(receipt: SearchReceipt) {
  return 'searchId' in receipt ? receipt.searchId : receipt.jobId
}

export function spotifyTrackSearchSavedResults(
  search: SpotifyTrackSearch | undefined,
) {
  if (
    !search ||
    search.job?.acceptedTrackId ||
    search.resultJob?.acceptedTrackId ||
    search.interactiveResults?.some((result) => result.acceptedTrackId)
  )
    return []
  const primary = search.resultJob === undefined ? search.job : search.resultJob
  const legacy = [
    ...(primary
      ? [{ job: primary, query: search.query, candidates: search.candidates }]
      : []),
    ...(search.earlierResults ?? []),
  ].flatMap(({ job, candidates }) =>
    job.status === 'succeeded' && !job.acceptedTrackId
      ? [
          {
            receipt: { jobId: job.jobId },
            searchedAt: job.finishedAt ?? job.createdAt,
            candidates,
          },
        ]
      : [],
  )
  const interactive = (search.interactiveResults ?? []).map(
    ({ searchId, searchedAt, candidates }) => ({
      receipt: { searchId },
      searchedAt,
      candidates,
    }),
  )
  const seen = new Set<string>()
  return [...interactive, ...legacy]
    .sort((first, second) => second.searchedAt.localeCompare(first.searchedAt))
    .flatMap((result) => {
      const candidates = result.candidates.filter(({ spotifyTrackId }) => {
        if (seen.has(spotifyTrackId)) return false
        seen.add(spotifyTrackId)
        return true
      })
      return candidates.length ? [{ ...result, candidates }] : []
    })
}

export function SpotifyTrackSearchCandidates({
  candidates,
  disabled,
  onSelect,
}: {
  candidates: readonly SpotifyTrackSearchCandidate[]
  disabled?: boolean
  onSelect?: (candidate: SpotifyTrackSearchCandidate) => void
}) {
  return (
    <List compact aria-label="Spotify track matches">
      {candidates.map((candidate) => (
        <ListRow
          key={candidate.spotifyTrackId}
          thumb={
            <MediaThumb kind="track" src={candidate.artworkUrl} size={40} />
          }
          title={
            candidate.catalogMediaItemId ? (
              <RowTitle>
                <DetailLink
                  kind="track"
                  id={candidate.catalogMediaItemId}
                  title={candidate.title}
                >
                  {candidate.title}
                </DetailLink>
              </RowTitle>
            ) : onSelect ? (
              <RowTitle>
                <button
                  type="button"
                  title={candidate.title}
                  aria-label={`Review ${candidate.title}${candidate.albumName ? ` from ${candidate.albumName}` : ''}`}
                  disabled={disabled}
                  onClick={() => onSelect(candidate)}
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
          by={[
            candidate.artists.join(', '),
            candidate.albumName,
            candidate.durationSec !== null
              ? formatTrackDuration(candidate.durationSec)
              : null,
            candidate.inLibrary === undefined
              ? null
              : candidate.inLibrary
                ? 'In library'
                : 'Outside library',
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
              {candidate.catalogMediaItemId && onSelect && (
                <Button
                  size="xs"
                  disabled={disabled}
                  aria-label={`Review ${candidate.title}${candidate.albumName ? ` from ${candidate.albumName}` : ''}`}
                  onClick={() => onSelect(candidate)}
                >
                  Review
                </Button>
              )}
            </span>
          }
        />
      ))}
    </List>
  )
}

export function SpotifyTrackSearchReview({
  track,
  onClose,
  onMatched,
  onSearchLibrary,
  searchMode,
  initialSelection,
}: {
  track: SearchTrack
  onClose: () => void
  onMatched: (targetId: string) => void
  onSearchLibrary?: () => void
  searchMode?: 'edit-query' | 'review-results'
  initialSelection?: SpotifyTrackSearchSelection
}) {
  const { apiBaseUrl } = useConfig()
  const catalog = useSpotifyTrackSearchMarket()
  const client = useQueryClient()
  const path = `${spotifySearchPath}/${encodeURIComponent(track.id)}`
  const savedKey = [...spotifySearchKey, track.id]
  const acceptanceKey = [...savedKey, 'accept']
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState(() =>
    [track.title, ...track.artists].join(' ').slice(0, 200).trim(),
  )
  const [chosen, setChosen] = useState<SpotifyTrackSearchSelection | null>(
    initialSelection ?? null,
  )
  const search = useSavedSpotifyTrackSearch(track.id)
  const lookup = useMutation({
    retry: false,
    mutationFn: (query: string) =>
      catalog.withMarket(
        (market) =>
          fetchApiData(
            apiBaseUrl,
            path,
            SpotifyInteractiveTrackSearchResultSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                SpotifyInteractiveTrackSearchInputSchema.parse({
                  query,
                  market,
                }),
              ),
            },
          ),
        'Could not search Spotify.',
      ),
    onMutate: () => client.cancelQueries({ queryKey: savedKey, exact: true }),
    onSuccess: (result) => {
      setChosen(null)
      client.setQueryData<SpotifyTrackSearch>(savedKey, (previous) => ({
        ...previous,
        job: previous?.job ?? null,
        query: previous?.query ?? result.query,
        candidates: previous?.candidates ?? [],
        interactiveResults: [
          result,
          ...(previous?.interactiveResults ?? []).filter(
            ({ searchId }) => searchId !== result.searchId,
          ),
        ],
      }))
    },
    onSettled: () => {
      void client.invalidateQueries({
        queryKey: [...spotifySearchKey, 'status'],
        predicate: ({ queryKey }) => {
          const trackIds = queryKey[3]
          return Array.isArray(trackIds) && trackIds.includes(track.id)
        },
      })
      void client.invalidateQueries({
        queryKey: ['tracks', 'metadata-selection'],
      })
    },
  })
  const accept = useMutation({
    mutationKey: acceptanceKey,
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
              ...('jobId' in input
                ? { jobId: input.jobId }
                : { searchId: input.searchId }),
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
  const latestInteractive = search.data?.interactiveResults?.[0]
  const jobTime = job?.finishedAt ?? job?.startedAt ?? job?.createdAt
  const directWasLatest =
    latestInteractive && (!jobTime || latestInteractive.searchedAt >= jobTime)
  const savedResults = spotifyTrackSearchSavedResults(search.data)
  const searchActive = isActiveSpotifyTrackSearch(job)
  const confirmation =
    !searchActive &&
    chosen &&
    savedResults.some(
      (result) =>
        searchReceiptId(result.receipt) === searchReceiptId(chosen) &&
        result.candidates.some(
          (candidate) =>
            candidate.spotifyTrackId === chosen.candidate.spotifyTrackId,
        ),
    )
      ? chosen
      : null
  const query = SpotifyTrackSearchQuerySchema.safeParse(draft)
  const canSubmit =
    query.success &&
    !catalog.invalidMarket &&
    !search.isPending &&
    !lookup.isPending &&
    !accept.isPending &&
    !searchActive
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
                  if (canSubmit && query.success) lookup.mutate(query.data)
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
                    {lookup.isPending ? 'Searching…' : 'Search'}
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
              {!lookup.isPending &&
                directWasLatest &&
                latestInteractive.candidates.length === 0 && (
                  <p role="status" className="ds-help">
                    No matches
                  </p>
                )}
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
          {lookup.isPending ? (
            <Skeleton height={48} />
          ) : job?.acceptedTrackId ? (
            <SpotifyTrackSearchResult job={job} />
          ) : confirmation ? (
            <SpotifyTrackSearchConfirmation
              candidate={confirmation.candidate}
              failure={accept.error}
              pending={accept.isPending}
              onConfirm={() => {
                if (
                  !client.isMutating({
                    mutationKey: acceptanceKey,
                    exact: true,
                  })
                )
                  accept.mutate(confirmation)
              }}
              onChooseAnother={() => setChosen(null)}
              onClose={onClose}
            />
          ) : savedResults.length > 0 ? (
            savedResults.map(({ receipt, searchedAt, candidates }, index) => (
              <Section
                key={searchReceiptId(receipt)}
                title={formatItemCount(candidates.length, MATCHES)}
                note={
                  index > 0 ||
                  ('jobId' in receipt && receipt.jobId !== job?.jobId)
                    ? formatDateTime(searchedAt)
                    : undefined
                }
              >
                <SpotifyTrackSearchCandidates
                  candidates={candidates}
                  disabled={searchActive}
                  onSelect={(candidate) => {
                    accept.reset()
                    setChosen({ ...receipt, candidate })
                  }}
                />
              </Section>
            ))
          ) : (
            search.isSuccess &&
            (!directWasLatest || searchActive) && (
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
