'use client'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import { useState } from 'react'
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  SONOVAULT_REFRESH_MONTHS,
  SonovaultTrackLookupInputSchema,
  SonovaultTrackStateSchema,
  SonovaultTrackStatusInputSchema,
  SonovaultTrackStatusSchema,
  type SonovaultTrackLookupJob,
  type SonovaultTrackReference,
  type SonovaultTrackState,
} from '@repo/schemas/sonovault'
import type { TrackDetail, TrackListItem } from '@repo/schemas/tracks'
import { List, ListRow } from '@repo/ui/components/ds/list-row'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { EmptyValue, ProviderMark } from '@repo/ui/components/ds/pill'
import { SourceBlock, SourceRow } from '@repo/ui/components/ds/source'
import { Status } from '@repo/ui/components/ds/status'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'
import {
  formatAge,
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { spotifyTrackUri } from '@/utils/album-links'
import { fetchApiData } from '@/utils/api'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'
import { scopedHref } from '@/utils/media-scope'
import { providerLogoUrl } from '@/utils/provider-logos'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { ConfirmAction } from './confirm-action'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { invalidateSpotifySearchJobs } from './spotify-track-search'
import { useJobBatchFeedback } from './job-button-feedback'

const TRACKS = { one: 'track', other: 'tracks' }
const sonovaultLookupPath = '/api/v1/sonovault/tracks/lookup'
export const sonovaultLookupKey = ['tracks', 'sonovault-track-lookup']

/** The service and kind of each reference type, in the order they are listed. */
const referenceServices: Record<
  SonovaultTrackReference['referenceType'],
  { provider: string; label: string }
> = {
  isrc: { provider: 'isrc', label: 'ISRC' },
  'sonovault-track': { provider: 'sonovault', label: 'Sonovault' },
  'spotify-track': { provider: 'spotify', label: 'Spotify' },
  'applemusic-track': { provider: 'applemusic', label: 'Apple Music' },
  'tidal-track': { provider: 'tidal', label: 'TIDAL' },
  'beatport-track': { provider: 'beatport', label: 'Beatport' },
  'musicbrainz-recording': {
    provider: 'musicbrainz',
    label: 'MusicBrainz recording',
  },
  'discogs-release-track': {
    provider: 'discogs',
    label: 'Discogs release track',
  },
  'youtube-video': { provider: 'youtube', label: 'YouTube' },
}
const referenceOrder = Object.keys(referenceServices)

const inputTypeLabels = {
  spotify_id: 'Spotify ID',
  isrc: 'ISRC',
  track_name: 'artist and title',
  release: 'its album’s Sonovault release',
}

export function isActiveSonovaultLookup(
  job: SonovaultTrackLookupJob | null | undefined,
) {
  return job?.status === 'queued' || job?.status === 'running'
}

/** Whether the track has what Sonovault looks tracks up by. */
export function hasSonovaultLookupInput(
  track: Pick<TrackListItem, 'spotifyTrackId' | 'isrc'>,
) {
  return Boolean(spotifyTrackUri(track.spotifyTrackId?.trim()) || track.isrc)
}

/**
 * Whether a lookup would be made now, as the server decides it: never looked
 * up, a miss whose 30 days have passed, or a record older than 11 months
 * (`refresh`). Null while a job is queued or running, or when not due.
 */
export function sonovaultLookupDue(
  state: SonovaultTrackState | undefined,
  now = Date.now(),
): { refresh: boolean } | null {
  if (!state || isActiveSonovaultLookup(state.job)) return null
  const { lookup } = state
  if (!lookup) return { refresh: false }
  if (lookup.status === 'not_found')
    return !lookup.retryAfter || Date.parse(lookup.retryAfter) <= now
      ? { refresh: false }
      : null
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SONOVAULT_REFRESH_MONTHS)
  return Date.parse(lookup.lookedUpAt) < cutoff.getTime()
    ? { refresh: true }
    : null
}

/** The lookup's result in words: Matched, Unverified or Not found. */
export function sonovaultLookupLabel(lookup: SonovaultTrackState['lookup']) {
  if (!lookup) return 'Not looked up'
  if (lookup.status === 'not_found') return 'Not found'
  return lookup.verified === false ? 'Unverified' : 'Matched'
}

function lookupState(lookup: SonovaultTrackState['lookup']) {
  if (!lookup) return 'never'
  return lookup.status === 'matched' && lookup.verified !== false
    ? 'done'
    : 'attention'
}

export function useSonovaultTrackLookup(trackId: string, enabled = true) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: [...sonovaultLookupKey, trackId],
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${sonovaultLookupPath}/${encodeURIComponent(trackId)}`,
        SonovaultTrackStateSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      isActiveSonovaultLookup(query.state.data?.job)
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
}

/** Each page's lookups in batches of at most 100 tracks. */
export function useSonovaultTrackLookupStatusForPages(
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
        queryKey: [...sonovaultLookupKey, 'status', trackIds],
        queryFn: ({ signal }) =>
          fetchApiData(
            apiBaseUrl,
            `${sonovaultLookupPath}/status`,
            SonovaultTrackStatusSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                SonovaultTrackStatusInputSchema.parse({ trackIds }),
              ),
              signal,
            },
          ),
        refetchInterval: (query) =>
          query.state.data?.items.some(({ job }) =>
            isActiveSonovaultLookup(job),
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
    retry: () => Promise.all(queries.map((query) => query.refetch())),
  }
}

/** The request body for one chunk of tracks to look up. */
export function sonovaultLookupBody({
  trackIds,
  batchId,
  refresh,
  total,
  catalogScope,
}: {
  trackIds: string[]
  batchId?: string
  refresh: boolean
  catalogScope?: CatalogScopeQuery
  /** How many tracks the whole run sends; more than five needs confirming. */
  total: number
}) {
  return JSON.stringify(
    SonovaultTrackLookupInputSchema.parse({
      trackIds,
      batchId,
      refresh,
      confirmBroadRun: total > 5,
      catalogScope,
    }),
  )
}

export function useQueueSonovaultLookups() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: ({
      trackIds,
      refresh,
    }: {
      trackIds: string[]
      refresh: boolean
    }) =>
      fetchApiData(apiBaseUrl, sonovaultLookupPath, EnrichmentResultSchema, {
        method: 'POST',
        body: sonovaultLookupBody({
          trackIds,
          refresh,
          total: trackIds.length,
        }),
      }),
    onSettled: () => invalidateSpotifySearchJobs(client),
  })
}

/**
 * Queues Sonovault lookups for a table's selection: its status for the
 * selection bar and the action that starts it. Records older than 11 months
 * are looked up again; the server skips every other track already looked up.
 */
export function useSonovaultLookupSelection({
  onSelect,
  onPendingChange,
  catalogScope,
}: {
  onSelect: (ids: string[]) => void
  onPendingChange: (pending: boolean) => void
  catalogScope?: CatalogScopeQuery
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [batchId, setBatchId] = useState('')
  const [progress, setProgress] = useState(0)
  const queue = useMutation({
    retry: false,
    mutationFn: (ids: string[]) => {
      const batch = crypto.randomUUID()
      setBatchId(batch)
      return dispatchFilmSelection(
        ids,
        (chunk) =>
          fetchApiData(
            apiBaseUrl,
            sonovaultLookupPath,
            EnrichmentResultSchema,
            {
              method: 'POST',
              body: sonovaultLookupBody({
                trackIds: chunk,
                batchId: batch,
                refresh: true,
                total: ids.length,
                catalogScope,
              }),
            },
          ),
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
  const jobs = useJobBatchFeedback(
    apiBaseUrl,
    queue.data?.queued ? batchId : undefined,
  )
  const status = queue.isPending ? (
    <></>
  ) : queue.isError ? (
    <span role="alert">
      {errorMessage(queue.error, 'Could not queue Sonovault lookups.')}
    </span>
  ) : queue.data ? (
    <span>
      {jobs &&
        queue.data.skipped > 0 &&
        `${formatCount(queue.data.skipped)} skipped · `}
      {batchId && (queue.data.queued > 0 || queue.data.interrupted) && (
        <Link
          href={scopedHref(
            `/jobs?batchId=${encodeURIComponent(batchId)}`,
            'track',
          )}
        >
          View Sonovault jobs
        </Link>
      )}
      {queue.data.warnings.map((warning) => (
        <span key={warning} className="block">
          {warning}
        </span>
      ))}
    </span>
  ) : null
  const feedback: ButtonFeedback | undefined = queue.isPending
    ? {
        phase: 'pending',
        label: `Submitting · ${formatCount(progress)} confirmed`,
      }
    : queue.isError
      ? { phase: 'failed', label: 'Could not submit lookups' }
      : queue.data
        ? (jobs ?? {
            phase: queue.data.interrupted
              ? 'partial'
              : queue.data.queued
                ? 'queued'
                : 'done',
            label: `${formatCount(queue.data.queued)} queued · ${formatCount(queue.data.skipped)} skipped`,
          })
        : undefined
  return {
    status,
    pending: queue.isPending,
    action: (selectedIds: string[], disabled: boolean) =>
      selectedIds.length || feedback ? (
        <ConfirmAction
          confirm={selectedIds.length > 5}
          question={`Look up ${formatItemCount(selectedIds.length, TRACKS)} on Sonovault?`}
          details="Each track looked up uses one Sonovault credit. Tracks without a Spotify ID or ISRC, and tracks already looked up, are skipped."
          confirmLabel="Look up on Sonovault"
          disabled={disabled || queue.isPending || !selectedIds.length}
          feedback={feedback}
          onConfirm={() => queue.mutate(selectedIds)}
        >
          Look up on Sonovault
        </ConfirmAction>
      ) : null,
  }
}

export function SonovaultLookupJobStatus({
  job,
  showStatus = true,
}: {
  job: SonovaultTrackLookupJob
  showStatus?: boolean
}) {
  return (
    <DetailLink kind="job" id={job.jobId}>
      {showStatus ? (
        <Status
          state={job.status === 'succeeded' ? 'done' : job.status}
          title={job.errorMessage ?? undefined}
        />
      ) : (
        'View lookup job'
      )}
    </DetailLink>
  )
}

/** Keep the job link when the lookup action already shows its state. */
export function sonovaultLookupStatusOnButton(
  job: SonovaultTrackLookupJob,
  feedback: ButtonFeedback | undefined,
  queued: number | undefined,
) {
  if (!queued || !feedback) return false
  const phase = job.status === 'succeeded' ? 'done' : job.status
  return (
    feedback.phase === phase ||
    (phase === 'queued' && feedback.phase === 'waiting')
  )
}

export function LookupTime({
  time,
  muted = false,
}: {
  time: string
  muted?: boolean
}) {
  return (
    <time
      className={muted ? 'ds-muted' : undefined}
      dateTime={time}
      title={formatDateTime(time)}
    >
      {formatAge(time)}
    </time>
  )
}

/**
 * A table cell: the latest job's status, the lookup's result opening the
 * track's Sonovault source, and its age. Never for a track that can be looked
 * up, a dash for one without a Spotify ID or ISRC.
 */
export function SonovaultTrackLookupCell({
  status,
  canLookUp,
}: {
  status: SonovaultTrackState
  canLookUp: boolean
}) {
  const { job, lookup, trackId } = status
  if (!job && !lookup)
    return canLookUp ? <Status state="never" /> : <EmptyValue />
  const time = lookup?.lookedUpAt ?? job?.finishedAt ?? job?.createdAt
  return (
    <div className="secondary-cell-actions">
      {job && <SonovaultLookupJobStatus job={job} />}
      {lookup && (
        <DetailLink
          kind="track"
          id={trackId}
          tab="sources"
          view={{ sourceProvider: 'sonovault' }}
        >
          {sonovaultLookupLabel(lookup)}
        </DetailLink>
      )}
      {time && <LookupTime time={time} muted />}
    </div>
  )
}

/**
 * Each reference as a row: its service, its ID and a link to its page on that
 * service where it has one.
 */
export function SonovaultReferences({
  references,
}: {
  references: readonly SonovaultTrackReference[]
}) {
  const sorted = [...references].sort(
    (a, b) =>
      referenceOrder.indexOf(a.referenceType) -
      referenceOrder.indexOf(b.referenceType),
  )
  return (
    <List compact aria-label="Sonovault references">
      {sorted.map((reference) => {
        const service = referenceServices[reference.referenceType]
        return (
          <ListRow
            key={`${reference.referenceType}:${reference.externalId}`}
            thumb={<span />}
            title={<span className="ds-row-title">{service.label}</span>}
            by={
              <span className="ds-mono" title={reference.externalId}>
                {reference.externalId}
              </span>
            }
            action={
              reference.url ? (
                <ServiceIconLinks
                  links={[
                    {
                      provider: service.provider,
                      label: service.label,
                      url: reference.url,
                    },
                  ]}
                />
              ) : null
            }
          />
        )
      })}
    </List>
  )
}

/** What the latest lookup found, or why there is nothing to show. */
export function SonovaultLookupBody({
  state,
  canLookUp,
}: {
  state: SonovaultTrackState
  canLookUp: boolean
}) {
  const { lookup, references, job } = state
  return (
    <>
      <div>
        {job?.status === 'failed' && job.errorMessage && (
          <p className="ds-muted">{job.errorMessage}</p>
        )}
        {!lookup ? (
          <p className="ds-help">
            {canLookUp
              ? 'Sonovault looks tracks up by Spotify ID or ISRC.'
              : 'No Spotify ID or ISRC to look up on Sonovault.'}
          </p>
        ) : lookup.status === 'not_found' ? (
          <p className="ds-help">
            Not found by {inputTypeLabels[lookup.inputType]}{' '}
            {formatDateTime(lookup.lookedUpAt)}.
            {lookup.retryAfter &&
              ` Can be looked up again from ${formatDateTime(lookup.retryAfter)}.`}
          </p>
        ) : (
          <>
            <p className="ds-help">
              Found by {inputTypeLabels[lookup.inputType]}{' '}
              {formatDateTime(lookup.lookedUpAt)}.
              {lookup.primaryIsrc &&
                ` Gave the track its ISRC ${lookup.primaryIsrc}.`}
            </p>
            {lookup.verified === false && (
              <p className="ds-help">
                Unverified: the duration or title differs from the library
                track, so this may be another version. Its references are not
                used elsewhere.
              </p>
            )}
          </>
        )}
      </div>
      {lookup?.status === 'matched' && references.length > 0 && (
        <SourceBlock title="Sonovault references">
          <SonovaultReferences references={references} />
        </SourceBlock>
      )}
    </>
  )
}

/** The track's Sonovault row in Sources: its lookup and the references it gave. */
export function TrackSonovaultSource({ item }: { item: TrackDetail }) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const [open, setOpen] = useState(
    view.params.get('sourceProvider') === 'sonovault',
  )
  const sourceParams = new URLSearchParams(view.params)
  sourceParams.set('sourceProvider', 'sonovault')
  sourceParams.set('tab', 'sources')
  const lookup = useSonovaultTrackLookup(item.id)
  const queue = useQueueSonovaultLookups()
  const canLookUp = hasSonovaultLookupInput({
    spotifyTrackId: item.spotifyTrackId,
    isrc: item.isrc ?? item.isrcs[0]?.isrc ?? null,
  })
  const state = lookup.data
  const job = state?.job
  const due = canLookUp ? sonovaultLookupDue(state) : null
  const batch = useJobBatchFeedback(
    apiBaseUrl,
    queue.data?.queued ? queue.data.batchId : undefined,
  )
  const feedback: ButtonFeedback | undefined = queue.isPending
    ? { phase: 'pending', label: 'Requesting lookup…' }
    : queue.isError
      ? { phase: 'failed', label: 'Could not queue lookup' }
      : queue.data
        ? (batch ?? {
            phase: queue.data.queued ? 'queued' : 'done',
            label: queue.data.queued ? 'Lookup queued' : 'Lookup skipped',
          })
        : undefined
  const time = state?.lookup?.lookedUpAt ?? job?.finishedAt ?? job?.createdAt
  return (
    <>
      <SourceRow
        name="Sonovault"
        open={open}
        onToggle={setOpen}
        summaryProps={workspaceTabLinkProps(
          view.workspaceHref(sourceParams),
          'Sonovault',
        )}
        mark={
          <ProviderMark
            name="Sonovault"
            src={providerLogoUrl('sonovault')}
            hidden
          />
        }
        match={
          state && (
            <Status state={lookupState(state.lookup)}>
              {sonovaultLookupLabel(state.lookup)}
            </Status>
          )
        }
        identifier={state?.lookup?.sonovaultTrackId ?? undefined}
        when={time && <LookupTime time={time} />}
        state={
          job && (
            <SonovaultLookupJobStatus
              job={job}
              showStatus={
                !sonovaultLookupStatusOnButton(
                  job,
                  feedback,
                  queue.data?.queued,
                )
              }
            />
          )
        }
        actions={
          (due || feedback) && (
            <Button
              size="xs"
              disabled={
                !due ||
                queue.isPending ||
                lookup.isPending ||
                (queue.data?.queued !== undefined &&
                  queue.data.queued > 0 &&
                  (!batch ||
                    batch.phase === 'queued' ||
                    batch.phase === 'running' ||
                    batch.phase === 'waiting'))
              }
              onClick={() => {
                if (due)
                  queue.mutate({ trackIds: [item.id], refresh: due.refresh })
              }}
              feedback={feedback}
            >
              Look up on Sonovault
            </Button>
          )
        }
      >
        {lookup.isPending && <Skeleton height={48} />}
        {state && <SonovaultLookupBody state={state} canLookUp={canLookUp} />}
      </SourceRow>
      {(lookup.isError || queue.isError) && (
        <Notice
          tone="danger"
          action={
            lookup.isError && (
              <ReadButton size="xs" read={() => lookup.refetch()}>
                Retry
              </ReadButton>
            )
          }
        >
          {lookup.isError
            ? 'Could not load the Sonovault lookup.'
            : errorMessage(
                queue.error,
                'Could not queue the Sonovault lookup.',
              )}
        </Notice>
      )}
    </>
  )
}
