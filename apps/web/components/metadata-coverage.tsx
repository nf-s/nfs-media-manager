'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CoverageSchema, type ProviderCoverage } from '@repo/schemas/coverage'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Coverage } from '@repo/ui/components/ds/meter'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
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
import { providerMarkText } from '@/utils/source-rows'
import { useConfig } from './providers'

export type { MetadataCoverageKind }

const albums = { one: 'album', other: 'albums' }
const DEFAULT_OLDER_THAN_DAYS = 180

/** One provider's gap to queue: at most 100 album IDs of `count`. */
export type CoverageRequest = {
  provider: ProviderCoverage
  gap: CoverageGap
  ids: string[]
  count: number
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
  onConfirm,
  onCancel,
}: {
  review: CoverageRequest
  olderThanDays: number
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { provider, gap, ids, count } = review
  const jobs = formatItemCount(ids.length, {
    one: 'metadata job',
    other: 'metadata jobs',
  })
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
              onClick={onConfirm}
            >
              {pending ? 'Queuing...' : `Confirm ${jobs}`}
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
          ? `${formatItemCount(ids.length, albums)} never fetched`
          : `${formatItemCount(ids.length, albums)} last fetched over ${formatCount(olderThanDays)} days ago`}
        {count > ids.length &&
          ` (the first ${formatCount(ids.length)} of ${formatCount(count)})`}
        <p>
          Albums fetched since, with an active job or that the provider cannot
          look up are skipped. Provider limits and cooldowns apply.
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

/**
 * The review and queueing of one provider's gap. Queueing reloads the
 * coverage and everything under its key, such as the playlist's gap list.
 */
export function useCoverageQueue(
  kind: MetadataCoverageKind,
  id: string,
  olderThanDays = DEFAULT_OLDER_THAN_DAYS,
  onQueued?: () => void,
) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [review, setReview] = useState<CoverageRequest | null>(null)
  const [batchId, setBatchId] = useState('')
  const queue = useMutation({
    mutationFn: async ({ provider, gap, ids }: CoverageRequest) => {
      const batch = crypto.randomUUID()
      setBatchId(batch)
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
        () => {},
      )
    },
    onSuccess: () => {
      setReview(null)
      onQueued?.()
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: coverageKey(kind, id) }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
        client.invalidateQueries({ queryKey: ['album-selection'] }),
      ])
    },
  })
  return {
    queue,
    review,
    batchId,
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
}: {
  state: ReturnType<typeof useCoverageQueue>
}) {
  const { queue, review, batchId } = state
  return (
    <>
      {review && (
        <CoverageReview
          review={review}
          olderThanDays={state.olderThanDays}
          pending={queue.isPending}
          onConfirm={() => queue.mutate(review)}
          onCancel={state.cancel}
        />
      )}
      {queue.isError && (
        <Notice tone="danger">
          Could not queue the jobs. Check progress before retrying.
        </Notice>
      )}
      {queue.data && (
        <Notice
          tone={queue.data.interrupted ? 'danger' : undefined}
          action={
            batchId ? (
              <Button size="xs" asChild>
                <Link
                  href={scopedHref(
                    `/jobs?batchId=${encodeURIComponent(batchId)}`,
                    'album',
                  )}
                >
                  View progress
                </Link>
              </Button>
            ) : undefined
          }
        >
          {formatCount(queue.data.queued)} queued ·{' '}
          {formatCount(queue.data.skipped)} skipped
          {queue.data.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </Notice>
      )}
    </>
  )
}

/** How many albums of a playlist or artist each provider has data for. */
export function MetadataCoverage({
  kind,
  id,
  onShowGap,
}: {
  kind: MetadataCoverageKind
  id: string
  /** Shows the track list's entries with this gap; the counts become links. */
  onShowGap?: (provider: ProviderCoverage, gap: CoverageGap) => void
}) {
  const coverage = useCoverage(kind, id)
  const data = coverage.data
  const state = useCoverageQueue(kind, id, data?.olderThanDays)
  const { queue } = state
  return (
    <Section
      title="Coverage"
      note={
        data &&
        `${formatItemCount(data.total, albums)} · stale after ${formatCount(data.olderThanDays)} days`
      }
    >
      {!data ? (
        coverage.isError ? (
          <State
            title="Could not load coverage"
            error
            size="sm"
            action={
              <Button size="xs" onClick={() => coverage.refetch()}>
                Retry
              </Button>
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
          title={data.total === 0 ? 'No albums' : 'No metadata providers'}
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
                onShowGap && (
                  <Button
                    size="xs"
                    variant="link"
                    aria-label={`Show the entries ${gap === 'missing' ? 'missing' : 'with stale'} ${provider.displayName}`}
                    onClick={() => onShowGap(provider, gap)}
                  >
                    {formatCount(count)} {gap}
                  </Button>
                )
              return (
                <div role="listitem" key={provider.provider}>
                  <Coverage
                    label={
                      <span
                        className="ds-cell-id"
                        title={
                          needsId
                            ? `${formatItemCount(needsId, albums)} need an identifier first`
                            : undefined
                        }
                      >
                        <ProviderMark name={provider.displayName}>
                          {providerMarkText(provider.displayName)}
                        </ProviderMark>
                        <span className="ds-truncate">
                          {provider.displayName}
                        </span>
                      </span>
                    }
                    have={provider.covered}
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
                                aria-label={`Queue ${formatCount(provider.missing)} missing for ${provider.displayName}`}
                                onClick={() =>
                                  state.open(
                                    coverageRequest(provider, 'missing'),
                                  )
                                }
                              >
                                {onShowGap
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
                                aria-label={`Refresh ${formatCount(provider.stale)} stale for ${provider.displayName}`}
                                onClick={() =>
                                  state.open(coverageRequest(provider, 'stale'))
                                }
                              >
                                {onShowGap
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
          <CoverageQueueStatus state={state} />
        </>
      )}
    </Section>
  )
}
