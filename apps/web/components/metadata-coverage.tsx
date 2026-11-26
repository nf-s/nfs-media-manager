'use client'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { ArtistEnrichmentResultSchema } from '@repo/schemas/artist-profiles'
import {
  CoverageSchema,
  type Coverage as CoverageData,
  type CoverageSubject,
  type ProviderCoverage,
} from '@repo/schemas/coverage'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Coverage } from '@repo/ui/components/ds/meter'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { Status } from '@repo/ui/components/ds/status'
import {
  Button,
  ButtonFeedbackLabel,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { queueReceipt, useJobBatchFeedback } from './job-button-feedback'
import { dispatchArtistSelection } from '@/utils/artist-selection'
import {
  ARTIST_JOBS_HREF,
  artistCoverageKey,
  artistCoveragePath,
  artistCoverageQueueRequest,
  artistGapHref,
} from '@/utils/coverage-entries'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { scopedHref } from '@/utils/media-scope'
import {
  BROAD_RUN_JOBS,
  coverageGapIds,
  coverageKey,
  coveragePath,
  coverageQueueRequest,
  coverageUnavailableLabels,
  type CoverageGap,
  type MetadataCoverageKind,
} from '@/utils/metadata-coverage'
import { providerLogoUrl } from '@/utils/provider-logos'
import { useConfig } from './providers'

export type { MetadataCoverageKind }

const nouns: Record<CoverageSubject, { one: string; other: string }> = {
  albums: { one: 'album', other: 'albums' },
  artists: { one: 'artist', other: 'artists' },
}
const libraryAlbumNoun = { one: 'library album', other: 'library albums' }
const skipRules: Record<CoverageSubject, string> = {
  albums:
    'Albums fetched since, with an active job or that the provider cannot look up are skipped.',
  artists: 'Artists fetched since or with an active job are skipped.',
}
const subjectOptions = [
  { value: 'albums', label: 'Albums' },
  { value: 'artists', label: 'Artists' },
] satisfies { value: CoverageSubject; label: string }[]
const DEFAULT_OLDER_THAN_DAYS = 180

/** One provider's gap to queue: at most 100 album or artist IDs of `count`. */
export type CoverageRequest = {
  provider: ProviderCoverage
  gap: CoverageGap
  ids: string[]
  count: number
}

/** What one reviewed queue request did. */
type CoverageQueueResult = {
  queued: number
  skipped: number
  warnings: string[]
  interrupted: boolean
}

/** A Coverage line's whole gap, as its Queue and Refresh buttons send it. */
export function coverageRequest(
  provider: ProviderCoverage,
  gap: CoverageGap,
): CoverageRequest {
  return {
    provider,
    gap,
    ids: coverageGapIds(provider, gap),
    count: gap === 'missing' ? provider.missing : provider.stale,
  }
}

/** The review step before queueing one provider's gap. */
export function CoverageReview({
  review,
  olderThanDays,
  pending,
  pendingFeedback,
  onConfirm,
  onCancel,
  subject = 'albums',
  storedData = false,
}: {
  review: CoverageRequest
  olderThanDays: number
  pending: boolean
  pendingFeedback?: ButtonFeedback
  onConfirm: () => void
  onCancel: () => void
  storedData?: boolean
  subject?: CoverageSubject
}) {
  const { provider, gap, ids, count } = review
  const jobs = formatItemCount(ids.length, {
    one: 'metadata job',
    other: 'metadata jobs',
  })
  const items = formatItemCount(ids.length, nouns[subject])
  return (
    <div role="region" aria-label="Review metadata jobs">
      <Notice
        tone={ids.length > BROAD_RUN_JOBS ? 'attention' : undefined}
        action={
          <span className="ds-actions">
            <Button
              size="xs"
              variant="primary"
              disabled={pending}
              feedback={
                pending
                  ? (pendingFeedback ?? {
                      phase: 'pending',
                      label: 'Submitting…',
                    })
                  : undefined
              }
              onClick={onConfirm}
            >
              Confirm {jobs}
            </Button>
            <Button size="xs" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          </span>
        }
      >
        <strong>
          Queue {jobs} for {provider.displayName}
        </strong>{' '}
        ·{' '}
        {gap === 'missing'
          ? storedData
            ? `${items} missing ${provider.displayName} metadata`
            : subject === 'albums'
              ? `${items} without a successful scrape`
              : `${items} never fetched`
          : `${items} last fetched over ${formatCount(olderThanDays)} days ago`}
        {count > ids.length &&
          ` (the first ${formatCount(ids.length)} of ${formatCount(count)})`}
        <p>
          {storedData
            ? 'Albums whose metadata gap has been filled, with an active job or without a usable identifier are skipped.'
            : skipRules[subject]}{' '}
          Provider limits and cooldowns apply.
        </p>
      </Notice>
    </div>
  )
}

/** The coverage of a playlist or artist, shared by Coverage and the track list. */
export function useCoverage(kind: MetadataCoverageKind, id: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: coverageKey(kind, id),
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, coveragePath(kind, id), CoverageSchema, {
        signal,
      }),
  })
}

/** The coverage of the artists credited in a playlist. */
export function useArtistCoverage(playlistId: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: artistCoverageKey(playlistId),
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, artistCoveragePath(playlistId), CoverageSchema, {
        signal,
      }),
  })
}

/**
 * The review and queueing of one provider's gap: albums through the album
 * queue, artists through the artist queue. Queueing reloads the coverage and
 * everything under its key, such as the playlist's gap list.
 */
export function useCoverageQueue(
  kind: MetadataCoverageKind,
  id: string,
  olderThanDays = DEFAULT_OLDER_THAN_DAYS,
  onQueued?: () => void,
  subject: CoverageSubject = 'albums',
) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [review, setReview] = useState<CoverageRequest | null>(null)
  const [batchId, setBatchId] = useState('')
  const [confirmed, setConfirmed] = useState(0)
  const queue = useMutation({
    mutationFn: async ({
      provider,
      gap,
      ids,
    }: CoverageRequest): Promise<CoverageQueueResult> => {
      const batch = crypto.randomUUID()
      setBatchId(batch)
      setConfirmed(0)
      if (subject === 'artists') {
        const result = await dispatchArtistSelection(
          ids,
          (artistIds) =>
            fetchApiData(
              apiBaseUrl,
              '/api/v1/artists/enrichment',
              ArtistEnrichmentResultSchema,
              {
                method: 'POST',
                body: JSON.stringify({
                  ...artistCoverageQueueRequest({
                    provider: provider.provider,
                    gap,
                    ids: artistIds,
                    olderThanDays,
                    confirmed: true,
                  }),
                  batchId: batch,
                }),
              },
            ),
          setConfirmed,
        )
        return {
          queued: result.queued,
          skipped: result.skipped,
          warnings: result.warnings,
          interrupted: result.completed.length < new Set(ids).size,
        }
      }
      return dispatchFilmSelection(
        ids,
        (mediaItemIds) =>
          fetchApiData(
            apiBaseUrl,
            '/api/v1/scrape/jobs/albums',
            EnrichmentResultSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                coverageQueueRequest({
                  kind,
                  provider: provider.provider,
                  gap,
                  ids: mediaItemIds,
                  olderThanDays,
                  // The review step is the confirmation.
                  confirmed: true,
                  batchId: batch,
                }),
              ),
            },
          ),
        setConfirmed,
      )
    },
    onSuccess: (result) => {
      setReview(null)
      if (!result.interrupted) onQueued?.()
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: coverageKey(kind, id) }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
        client.invalidateQueries({
          queryKey: [
            subject === 'artists' ? 'artist-selection' : 'album-selection',
          ],
        }),
      ])
    },
  })
  const batch = useJobBatchFeedback(
    apiBaseUrl,
    queue.data?.queued ? batchId : undefined,
  )
  const terminal =
    batch?.phase === 'done' ||
    batch?.phase === 'failed' ||
    batch?.phase === 'cancelled' ||
    batch?.phase === 'partial'
  useEffect(() => {
    if (terminal)
      void client.invalidateQueries({ queryKey: coverageKey(kind, id) })
  }, [terminal, client, kind, id])
  const feedback: ButtonFeedback | undefined = queue.isPending
    ? {
        phase: 'pending',
        label: confirmed
          ? `${formatCount(confirmed)} confirmed · submitting…`
          : 'Submitting…',
      }
    : queue.isError
      ? { phase: 'unconfirmed', label: 'Queue result unconfirmed' }
      : queue.data?.interrupted
        ? {
            phase: 'partial',
            label: `${formatCount(queue.data.queued)} queued · remainder unconfirmed`,
          }
        : queue.data
          ? (batch ?? queueReceipt(queue.data.queued, queue.data.skipped))
          : undefined
  return {
    queue,
    review,
    feedback,
    receiptSkips:
      queue.data && (batch || queue.data.interrupted || !queue.data.queued)
        ? queue.data.skipped
        : 0,
    feedbackFor(provider: string, gap: CoverageGap) {
      return !review &&
        queue.variables?.provider.provider === provider &&
        queue.variables.gap === gap
        ? feedback
        : undefined
    },
    subject,
    storedData: kind === 'playlist' && subject === 'albums',
    progressHref: batchId
      ? scopedHref(
          `/jobs?batchId=${encodeURIComponent(batchId)}`,
          subject === 'artists' ? 'artist' : 'album',
        )
      : subject === 'artists'
        ? ARTIST_JOBS_HREF
        : '',
    olderThanDays,
    open(request: CoverageRequest) {
      queue.reset()
      setReview(request)
    },
    cancel() {
      setReview(null)
    },
  }
}

/** The review step, then the queue's error or result, under the control that opened it. */
export function CoverageQueueStatus({
  state,
  feedbackOnControl,
}: {
  state: ReturnType<typeof useCoverageQueue>
  feedbackOnControl: boolean
}) {
  const { queue, review, progressHref } = state
  const fallbackFeedback = feedbackOnControl ? undefined : state.feedback
  return (
    <>
      {review && (
        <CoverageReview
          review={review}
          olderThanDays={state.olderThanDays}
          subject={state.subject}
          storedData={state.storedData}
          pending={queue.isPending}
          pendingFeedback={state.feedback}
          onConfirm={() => queue.mutate(review)}
          onCancel={state.cancel}
        />
      )}
      {queue.isError && (
        <Notice tone="danger">
          {!feedbackOnControl && 'Could not queue the jobs. '}
          Check progress before retrying.
        </Notice>
      )}
      {queue.data &&
        (fallbackFeedback ||
          progressHref ||
          state.receiptSkips > 0 ||
          queue.data.warnings.length > 0) && (
          <Notice
            tone={queue.data.interrupted ? 'danger' : undefined}
            action={
              progressHref ? (
                <Button size="xs" asChild>
                  <Link href={progressHref}>View progress</Link>
                </Button>
              ) : undefined
            }
          >
            {fallbackFeedback && (
              <span className="ds-actions" role="status">
                <ButtonFeedbackLabel feedback={fallbackFeedback} />
              </span>
            )}
            {state.receiptSkips > 0 &&
              `${formatCount(state.receiptSkips)} skipped.`}
            {queue.data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </Notice>
        )}
    </>
  )
}

/**
 * One line per provider: the meter, the gap counts (links where `showGap`
 * gives them), Queue and Refresh with their review, or why it cannot queue.
 */
function CoverageSection({
  coverage,
  subject,
  state,
  showGap,
  aside,
  playlistAlbums = false,
}: {
  coverage: UseQueryResult<CoverageData>
  subject: CoverageSubject
  state: ReturnType<typeof useCoverageQueue>
  showGap?: (
    provider: ProviderCoverage,
    gap: CoverageGap,
    count: number,
  ) => ReactNode
  aside?: ReactNode
  playlistAlbums?: boolean
}) {
  const data = coverage.data
  const noun = playlistAlbums ? libraryAlbumNoun : nouns[subject]
  const { queue } = state
  const feedbackOnControl = Boolean(
    data?.providers.some(
      (provider) =>
        !provider.unavailableReason &&
        ((provider.missing > 0 &&
          state.feedbackFor(provider.provider, 'missing')) ||
          (provider.stale > 0 &&
            state.feedbackFor(provider.provider, 'stale'))),
    ),
  )
  return (
    <Section
      title="Coverage"
      note={
        data &&
        `${playlistAlbums && data.storedAlbums !== undefined ? `${formatCount(data.storedAlbums)} of ${formatItemCount(data.total, noun)} with metadata` : formatItemCount(data.total, noun)} · stale after ${formatCount(data.olderThanDays)} days`
      }
      aside={aside}
    >
      {!data ? (
        coverage.isError ? (
          <State
            title="Could not load coverage"
            error
            size="sm"
            action={
              <ReadButton size="xs" read={() => coverage.refetch()}>
                Retry
              </ReadButton>
            }
          />
        ) : (
          <div className="data-stack" role="status" aria-busy="true">
            <span className="sr-only">Loading coverage</span>
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        )
      ) : data.total === 0 || !data.providers.length ? (
        <State
          title={
            data.total === 0 ? `No ${noun.other}` : 'No metadata providers'
          }
          size="sm"
        />
      ) : (
        <>
          <div
            className="data-stack"
            role="list"
            aria-label="Coverage by provider"
          >
            {data.providers.map((provider) => {
              const needsId = data.total - provider.eligible
              const show = (gap: CoverageGap, count: number) =>
                showGap?.(provider, gap, count)
              return (
                <div role="listitem" key={provider.provider}>
                  <Coverage
                    label={
                      <span
                        className="ds-cell-id"
                        title={
                          needsId
                            ? `${formatItemCount(needsId, noun)} need an identifier first`
                            : undefined
                        }
                      >
                        <ProviderMark
                          name={provider.displayName}
                          src={providerLogoUrl(provider.provider)}
                          hidden
                        />
                        <span className="ds-truncate">
                          {provider.displayName}
                        </span>
                      </span>
                    }
                    have={
                      playlistAlbums
                        ? (provider.stored ?? provider.covered)
                        : provider.covered
                    }
                    total={provider.eligible}
                    tone={provider.unavailableReason ? 'attention' : undefined}
                    action={
                      provider.unavailableReason ? (
                        <span className="ds-actions">
                          {provider.missing > 0 &&
                            show('missing', provider.missing)}
                          {provider.stale > 0 && show('stale', provider.stale)}
                          <Status
                            state={
                              provider.unavailableReason === 'halted'
                                ? 'paused'
                                : 'attention'
                            }
                          >
                            {
                              coverageUnavailableLabels[
                                provider.unavailableReason
                              ]
                            }
                          </Status>
                        </span>
                      ) : provider.missing || provider.stale ? (
                        <span className="ds-actions">
                          {provider.missing > 0 && (
                            <>
                              {show('missing', provider.missing)}
                              <Button
                                size="xs"
                                disabled={queue.isPending}
                                feedback={state.feedbackFor(
                                  provider.provider,
                                  'missing',
                                )}
                                aria-label={
                                  playlistAlbums
                                    ? `Queue ${provider.displayName} scrapes for ${formatItemCount(provider.missing, noun)}`
                                    : `Queue ${formatCount(provider.missing)} missing for ${provider.displayName}`
                                }
                                onClick={() =>
                                  state.open(
                                    coverageRequest(provider, 'missing'),
                                  )
                                }
                              >
                                {showGap
                                  ? 'Queue'
                                  : `Queue ${formatCount(provider.missing)} missing`}
                              </Button>
                            </>
                          )}
                          {provider.stale > 0 && (
                            <>
                              {show('stale', provider.stale)}
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={queue.isPending}
                                feedback={state.feedbackFor(
                                  provider.provider,
                                  'stale',
                                )}
                                aria-label={
                                  playlistAlbums
                                    ? `Refresh ${provider.displayName} metadata for ${formatItemCount(provider.stale, noun)}`
                                    : `Refresh ${formatCount(provider.stale)} stale for ${provider.displayName}`
                                }
                                onClick={() =>
                                  state.open(coverageRequest(provider, 'stale'))
                                }
                              >
                                {showGap
                                  ? 'Refresh'
                                  : `Refresh ${formatCount(provider.stale)} stale`}
                              </Button>
                            </>
                          )}
                        </span>
                      ) : undefined
                    }
                  />
                </div>
              )
            })}
          </div>
          <CoverageQueueStatus
            state={state}
            feedbackOnControl={feedbackOnControl}
          />
        </>
      )}
    </Section>
  )
}

/** How many albums of a playlist or artist each provider has data for. */
export function MetadataCoverage({
  kind,
  id,
  onShowGap,
  aside,
}: {
  kind: MetadataCoverageKind
  id: string
  /** Shows the track list's entries with this gap; the counts become links. */
  onShowGap?: (provider: ProviderCoverage, gap: CoverageGap) => void
  aside?: ReactNode
}) {
  const coverage = useCoverage(kind, id)
  const state = useCoverageQueue(kind, id, coverage.data?.olderThanDays)
  return (
    <CoverageSection
      coverage={coverage}
      subject="albums"
      playlistAlbums={kind === 'playlist'}
      state={state}
      aside={aside}
      showGap={
        onShowGap &&
        ((provider, gap, count) => (
          <Button
            size="xs"
            variant="link"
            aria-label={
              gap === 'missing'
                ? `Show entries for ${formatItemCount(count, libraryAlbumNoun)} missing ${provider.displayName} metadata`
                : `Show entries for ${formatItemCount(count, libraryAlbumNoun)} with stale ${provider.displayName} metadata`
            }
            onClick={() => onShowGap(provider, gap)}
          >
            {formatCount(count)}{' '}
            {gap === 'missing' ? 'missing metadata' : 'stale'}
          </Button>
        ))
      }
    />
  )
}

/**
 * How many artists credited in a playlist each artist provider has a
 * profile for. The counts open Artists Metadata filtered to the playlist and
 * the gap; Queue and Refresh queue only those artists.
 */
export function PlaylistArtistCoverage({
  id,
  aside,
}: {
  id: string
  aside?: ReactNode
}) {
  const coverage = useArtistCoverage(id)
  const olderThanDays = coverage.data?.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS
  const state = useCoverageQueue(
    'playlist',
    id,
    olderThanDays,
    undefined,
    'artists',
  )
  return (
    <CoverageSection
      coverage={coverage}
      subject="artists"
      state={state}
      aside={aside}
      showGap={(provider, gap, count) => (
        <Button size="xs" variant="link" asChild>
          <Link
            href={artistGapHref(id, provider.provider, gap, olderThanDays)}
            aria-label={`Show the artists ${gap === 'missing' ? 'missing' : 'with stale'} ${provider.displayName}`}
          >
            {formatCount(count)} {gap}
          </Link>
        </Button>
      )}
    />
  )
}

/** A playlist's Coverage tab: its albums or its artists. */
export function PlaylistCoverage({
  id,
  subject,
  onSubjectChange,
  onShowGap,
}: {
  id: string
  subject: CoverageSubject
  onSubjectChange: (subject: CoverageSubject) => void
  onShowGap: (provider: ProviderCoverage, gap: CoverageGap) => void
}) {
  const aside = (
    <Segmented<CoverageSubject>
      label="Coverage of"
      value={subject}
      options={subjectOptions}
      onChange={onSubjectChange}
    />
  )
  return subject === 'artists' ? (
    <PlaylistArtistCoverage id={id} aside={aside} />
  ) : (
    <MetadataCoverage
      kind="playlist"
      id={id}
      onShowGap={onShowGap}
      aside={aside}
    />
  )
}
