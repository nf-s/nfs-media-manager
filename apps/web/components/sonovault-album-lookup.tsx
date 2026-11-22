'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import type { AlbumDetail } from '@repo/schemas/media'
import {
  SonovaultAlbumLookupInputSchema,
  SonovaultAlbumReviewListSchema,
  SonovaultAlbumStateSchema,
  SonovaultAlbumSummarySchema,
  type SonovaultAlbumConfirmation,
  type SonovaultAlbumMiss,
  type SonovaultAlbumReference,
  type SonovaultAlbumReview,
  type SonovaultAlbumState,
} from '@repo/schemas/sonovault-album'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow } from '@repo/ui/components/ds/list-row'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { SourceBlock, SourceRow } from '@repo/ui/components/ds/source'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { providerLogoUrl } from '@/utils/provider-logos'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import {
  isActiveSonovaultLookup,
  LookupTime,
  SonovaultLookupJobStatus,
} from './sonovault-track-lookup'
import { invalidateSpotifySearchJobs } from './spotify-track-search'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'

const albumLookupPath = '/api/v1/sonovault/albums/lookup'
export const sonovaultAlbumKey = ['albums', 'sonovault-album-lookup']

const confirmationLabels: Record<SonovaultAlbumConfirmation, string> = {
  'spotify-album': 'Spotify album ID',
  upc: 'UPC',
  'musicbrainz-release-group': 'MusicBrainz release group',
}

const missLabels: Record<SonovaultAlbumMiss, string> = {
  'no-track':
    'No track of the album has a Spotify ID, an ISRC or a Sonovault record.',
  'track-not-found': 'The album track looked up is not on Sonovault.',
  'no-release': 'The track’s Sonovault record lists no release.',
  'not-confirmed':
    'No release on the track’s record carries the album’s Spotify album ID, UPC or MusicBrainz release group.',
}

/** Each reference type's service and kind, in the order they are listed. */
const referenceServices: Record<
  SonovaultAlbumReference['referenceType'],
  { provider: string; label: string }
> = {
  'sonovault-release': { provider: 'sonovault', label: 'Sonovault release' },
  'digital-upc': { provider: 'upc', label: 'Digital UPC' },
  'discogs-master': { provider: 'discogs', label: 'Discogs master' },
  'discogs-release': { provider: 'discogs', label: 'Discogs release' },
  'musicbrainz-release-group': {
    provider: 'musicbrainz',
    label: 'MusicBrainz release group',
  },
  'musicbrainz-release': {
    provider: 'musicbrainz',
    label: 'MusicBrainz release',
  },
  'beatport-release': { provider: 'beatport', label: 'Beatport release' },
  'applemusic-album': { provider: 'applemusic', label: 'Apple Music album' },
}
const referenceOrder = Object.keys(referenceServices)

const reviewLabels: Record<SonovaultAlbumReview['referenceType'], string> = {
  master: 'Discogs master',
  release: 'Discogs release',
  'release-group': 'MusicBrainz release group',
}

/** A review entry in words: the album's value against Sonovault's. */
export function sonovaultReviewText(entry: SonovaultAlbumReview) {
  return entry.stored
    ? `${reviewLabels[entry.referenceType]} differs: ${entry.stored} stored, ${entry.sonovault} on Sonovault`
    : `No ${reviewLabels[entry.referenceType]}: Sonovault has ${entry.sonovault}`
}

/** Whether a lookup would be made now: never looked up, or a miss whose 30 days have passed. */
export function sonovaultAlbumLookupDue(
  state: SonovaultAlbumState | undefined,
  now = Date.now(),
) {
  if (!state?.canLookUp || isActiveSonovaultLookup(state.job)) return false
  const { lookup } = state
  if (!lookup) return true
  return (
    lookup.status === 'not_found' &&
    (!lookup.retryAfter || Date.parse(lookup.retryAfter) <= now)
  )
}

export function sonovaultAlbumLookupLabel(
  lookup: SonovaultAlbumState['lookup'],
) {
  if (!lookup) return 'Not looked up'
  return lookup.status === 'confirmed' ? 'Confirmed' : 'Not found'
}

function lookupState(state: SonovaultAlbumState) {
  if (!state.lookup) return 'never'
  return state.lookup.status === 'confirmed' && !state.review.length
    ? 'done'
    : 'attention'
}

export function useSonovaultAlbumLookup(albumId: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: [...sonovaultAlbumKey, albumId],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${albumLookupPath}/${encodeURIComponent(albumId)}`,
        SonovaultAlbumStateSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      isActiveSonovaultLookup(query.state.data?.job)
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
}

function useQueueSonovaultAlbumLookup(albumId: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: () =>
      fetchApiData(apiBaseUrl, albumLookupPath, EnrichmentResultSchema, {
        method: 'POST',
        body: JSON.stringify(
          SonovaultAlbumLookupInputSchema.parse({ albumIds: [albumId] }),
        ),
      }),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [...sonovaultAlbumKey, albumId] }),
        invalidateSpotifySearchJobs(client),
      ])
    },
  })
}

/** Each album reference as a row: its kind, its ID and its service page. */
export function SonovaultAlbumReferences({
  references,
}: {
  references: readonly SonovaultAlbumReference[]
}) {
  const sorted = [...references].sort(
    (a, b) =>
      referenceOrder.indexOf(a.referenceType) -
        referenceOrder.indexOf(b.referenceType) ||
      Number(b.matchedEdition) - Number(a.matchedEdition),
  )
  return (
    <List compact aria-label="Sonovault album references">
      {sorted.map((reference) => {
        const service = referenceServices[reference.referenceType]
        return (
          <ListRow
            key={`${reference.referenceType}:${reference.externalId}`}
            thumb={<span />}
            title={<span className="ds-row-title">{service.label}</span>}
            by={
              <>
                <span className="ds-mono" title={reference.externalId}>
                  {reference.externalId}
                </span>
                {reference.matchedEdition && ' · Matched edition'}
              </>
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

/** SONO-22 entries as rows: what differs or is missing, with Sonovault's page. */
export function SonovaultAlbumReviewRows({
  review,
}: {
  review: readonly SonovaultAlbumReview[]
}) {
  return (
    <List compact aria-label="Sonovault match review">
      {review.map((entry) => (
        <ListRow
          key={`${entry.referenceType}:${entry.sonovault}`}
          thumb={<span />}
          title={
            <span className="ds-row-title">
              {reviewLabels[entry.referenceType]}
            </span>
          }
          by={`Sonovault ${entry.sonovault} · ${entry.stored ? `stored ${entry.stored}` : 'none stored'}`}
          action={
            entry.url ? (
              <ServiceIconLinks
                links={[
                  {
                    provider: entry.provider,
                    label: reviewLabels[entry.referenceType],
                    url: entry.url,
                  },
                ]}
              />
            ) : null
          }
        />
      ))}
    </List>
  )
}

function AlbumLookupBody({ state }: { state: SonovaultAlbumState }) {
  const { lookup, job, review, references } = state
  return (
    <>
      <div>
        {job && job.status === 'failed' && (
          <p className="ds-muted">
            <SonovaultLookupJobStatus job={job} /> {job.errorMessage}
          </p>
        )}
        {!lookup ? (
          <p className="ds-help">
            {state.canLookUp
              ? 'Sonovault finds an album through one of its tracks and confirms it by the album’s Spotify album ID, UPC or MusicBrainz release group. Up to seven credits.'
              : 'No track of the album has a Spotify ID or ISRC to look up on Sonovault.'}
          </p>
        ) : lookup.status === 'not_found' ? (
          <p className="ds-help">
            Not found {formatDateTime(lookup.lookedUpAt)}.{' '}
            {lookup.miss && missLabels[lookup.miss]}
            {lookup.retryAfter &&
              ` Can be looked up again from ${formatDateTime(lookup.retryAfter)}.`}
          </p>
        ) : (
          <>
            <p className="ds-help">
              Confirmed {formatDateTime(lookup.lookedUpAt)} by{' '}
              {lookup.confirmedBy
                .map((value) => confirmationLabels[value])
                .join(', ')}
              .
            </p>
            <KeyValues
              items={[
                { label: 'Tracks aligned', value: formatCount(lookup.aligned) },
                { label: 'Not aligned', value: formatCount(lookup.unaligned) },
                { label: 'ISRCs given', value: formatCount(lookup.isrcs) },
                {
                  label: 'Credits used',
                  value: formatCount(lookup.creditsUsed),
                },
              ]}
            />
          </>
        )}
      </div>
      {review.length > 0 && (
        <SourceBlock title="Match review">
          <p className="ds-help">
            Choose a candidate in the Discogs or MusicBrainz row to use it.
          </p>
          <SonovaultAlbumReviewRows review={review} />
        </SourceBlock>
      )}
      {lookup?.status === 'confirmed' && references.length > 0 && (
        <SourceBlock title="Sonovault references">
          <SonovaultAlbumReferences references={references} />
        </SourceBlock>
      )}
    </>
  )
}

/** The album's Sonovault row in Sources: its release, references and review. */
export function AlbumSonovaultSource({ item }: { item: AlbumDetail }) {
  const view = useDetailView()
  const [open, setOpen] = useState(
    view.params.get('sourceProvider') === 'sonovault',
  )
  const sourceParams = new URLSearchParams(view.params)
  sourceParams.set('sourceProvider', 'sonovault')
  sourceParams.set('tab', 'sources')
  const lookup = useSonovaultAlbumLookup(item.id)
  const queue = useQueueSonovaultAlbumLookup(item.id)
  const state = lookup.data
  const job = state?.job
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
            <Status state={lookupState(state)}>
              {state.review.length
                ? 'Match review'
                : sonovaultAlbumLookupLabel(state.lookup)}
            </Status>
          )
        }
        identifier={state?.lookup?.releaseId ?? undefined}
        when={time && <LookupTime time={time} />}
        state={job && <SonovaultLookupJobStatus job={job} />}
        actions={
          sonovaultAlbumLookupDue(state) && (
            <Button
              size="xs"
              disabled={queue.isPending || lookup.isPending}
              onClick={() => queue.mutate()}
            >
              Look up on Sonovault
            </Button>
          )
        }
      >
        {lookup.isPending && <Skeleton height={48} />}
        {state && <AlbumLookupBody state={state} />}
      </SourceRow>
      {(lookup.isError || queue.isError) && (
        <Notice
          tone="danger"
          action={
            lookup.isError && (
              <Button size="xs" onClick={() => lookup.refetch()}>
                Retry
              </Button>
            )
          }
        >
          {lookup.isError
            ? 'Could not load the Sonovault album lookup.'
            : errorMessage(
                queue.error,
                'Could not queue the Sonovault album lookup.',
              )}
        </Notice>
      )}
    </>
  )
}

/**
 * Providers → Sonovault: album counts and the albums listed for match review,
 * each opening its Sources.
 */
export function SonovaultAlbumSettings() {
  const { apiBaseUrl } = useConfig()
  const summary = useQuery({
    queryKey: [...sonovaultAlbumKey, 'summary'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonovault/albums/summary',
        SonovaultAlbumSummarySchema,
        { signal },
      ),
  })
  const review = useQuery({
    queryKey: [...sonovaultAlbumKey, 'review'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonovault/albums/review',
        SonovaultAlbumReviewListSchema,
        { signal },
      ),
  })
  return (
    <Section title="Albums">
      {(summary.isPending || review.isPending) && <Skeleton height={120} />}
      {(summary.isError || review.isError) && (
        <Notice
          tone="danger"
          action={
            <Button
              size="xs"
              onClick={() => {
                void summary.refetch()
                void review.refetch()
              }}
            >
              Retry
            </Button>
          }
        >
          Could not load Sonovault albums.
        </Notice>
      )}
      {summary.data && (
        <KeyValues
          items={[
            { label: 'Confirmed', value: formatCount(summary.data.confirmed) },
            { label: 'Not found', value: formatCount(summary.data.notFound) },
            {
              label: 'Tracks aligned',
              value: formatCount(summary.data.alignedTracks),
            },
            {
              label: 'Differing matches',
              value: formatCount(summary.data.differing),
            },
            {
              label: 'Match candidates',
              value: formatCount(summary.data.candidates),
            },
          ]}
        />
      )}
      {review.data && review.data.items.length > 0 && (
        <SourceBlock title="Match review">
          {review.data.totalCount > review.data.items.length && (
            <p className="ds-help">
              First {formatCount(review.data.items.length)} of{' '}
              {formatCount(review.data.totalCount)}.
            </p>
          )}
          <List compact aria-label="Albums for match review">
            {review.data.items.map((album) => (
              <ListRow
                key={album.albumId}
                thumb={<span />}
                title={
                  <DetailLink
                    kind="album"
                    id={album.albumId}
                    tab="sources"
                    view={{ sourceProvider: 'sonovault' }}
                  >
                    {album.title}
                  </DetailLink>
                }
                by={[
                  ...album.review.map((entry) => sonovaultReviewText(entry)),
                  album.artist,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </List>
        </SourceBlock>
      )}
    </Section>
  )
}
