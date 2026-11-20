'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SpotifyTrackSearchJob } from '@repo/schemas/spotify-track-search'
import { trackSpotifyMatchLabels, type TrackDetail } from '@repo/schemas/tracks'
import { Notice } from '@repo/ui/components/ds/feedback'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { SourceBlock, SourceRow } from '@repo/ui/components/ds/source'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatAge, formatDateTime } from '@repo/ui/lib/format'
import { spotifyTrackUri } from '@/utils/album-links'
import { providerLogoUrl } from '@/utils/provider-logos'
import { DetailLink } from './detail-link'
import { invalidateScrobbleLinks } from './lastfm-sync'
import {
  invalidateSpotifySearchJobs,
  isActiveSpotifyTrackSearch,
  SpotifyTrackSearchJobStatus,
  SpotifyTrackSearchResult,
  SpotifyTrackSearchReview,
  useQueueSpotifyTrackSearch,
  useSavedSpotifyTrackSearch,
} from './spotify-track-search'

function matchNote(
  item: TrackDetail,
  job: SpotifyTrackSearchJob | null | undefined,
) {
  if (job?.acceptedTrackId === item.id && job.matchMethod === 'automatic')
    return 'The track title and artist credits matched automatically.'
  if (!spotifyTrackUri(item.spotifyTrackId))
    return item.spotifyAlternate
      ? 'Another library version of this recording has a Spotify track ID.'
      : 'Search Spotify by track title and artist.'
  if (item.spotifyMatch === 'spotify-search')
    return job?.acceptedTrackId === item.id
      ? 'You confirmed this recording from a Spotify track search.'
      : 'The Spotify track ID came from a catalog search.'
  if (item.spotifyMatch === 'spotify-import')
    return item.lastfmSources.some((source) => source.manuallyMatched)
      ? 'Imported from Spotify. The Last.fm names marked below were chosen manually for this recording.'
      : item.sources.includes('lastfm')
        ? 'Imported from Spotify. Last.fm was matched by a unique artist and title match, with compatible album information.'
        : 'The Spotify ID came from a playlist or Liked Songs import.'
  return 'The linked album’s stored track list supplied the Spotify track ID.'
}

/** The same saved searches and recording identities used by Imports and Metadata. */
export function TrackSpotifySource({
  item,
  onResolved,
}: {
  item: TrackDetail
  onResolved?: (id: string) => void
}) {
  const catalog = useQueueSpotifyTrackSearch()
  const client = useQueryClient()
  const [review, setReview] = useState(false)
  const search = useSavedSpotifyTrackSearch(item.id)
  const job = search.data?.job
  const observedJob = useRef<SpotifyTrackSearchJob | null | undefined>(
    undefined,
  )
  const direct = Boolean(spotifyTrackUri(item.spotifyTrackId))
  const alternate = item.spotifyAlternate
  const needsMatch = !direct && !alternate
  const queue = useMutation({
    retry: false,
    mutationFn: () => catalog.queue({ trackIds: [item.id] }),
    onSettled: async (result) => {
      await invalidateSpotifySearchJobs(client)
      if (result?.skipped)
        await client.invalidateQueries({
          queryKey: ['track', item.id],
          exact: true,
        })
    },
  })
  useEffect(() => {
    if (job === undefined) return
    const previous = observedJob.current
    observedJob.current = job
    // A last.fm name can be intentionally separated again after a past search.
    // Follow a new acceptance observed here, never redirect on old history alone.
    if (
      previous === undefined ||
      !job?.acceptedTrackId ||
      (previous?.jobId === job.jobId &&
        previous.acceptedTrackId === job.acceptedTrackId)
    )
      return
    const replaced = job.acceptedTrackId !== item.id
    if (replaced) onResolved?.(job.acceptedTrackId)
    void invalidateScrobbleLinks(client, replaced ? item.id : undefined)
  }, [job, client, item.id, onResolved])
  const time = job?.finishedAt ?? job?.startedAt ?? job?.createdAt
  const label = direct
    ? trackSpotifyMatchLabels[item.spotifyMatch]
    : alternate
      ? 'Other Spotify version'
      : trackSpotifyMatchLabels.unmatched
  return (
    <>
      <SourceRow
        name="Spotify"
        mark={
          <ProviderMark
            name="Spotify"
            src={providerLogoUrl('spotify')}
            hidden
          />
        }
        match={
          <Status state={needsMatch ? 'attention' : 'done'}>{label}</Status>
        }
        identifier={direct ? item.spotifyTrackId : alternate?.identifier}
        when={
          time && (
            <time dateTime={time} title={formatDateTime(time)}>
              {formatAge(time)}
            </time>
          )
        }
        state={job && <SpotifyTrackSearchJobStatus job={job} />}
        actions={
          <>
            {alternate && (
              <DetailLink kind="track" id={alternate.trackId} tab="sources">
                Open version
              </DetailLink>
            )}
            {job && (
              <SpotifyTrackSearchResult
                job={job}
                currentTrackId={item.id}
                onReview={needsMatch ? () => setReview(true) : undefined}
                disabled={queue.isPending}
              />
            )}
            {needsMatch && (
              <Button
                size="xs"
                disabled={
                  queue.isPending ||
                  catalog.invalidMarket ||
                  !search.data ||
                  isActiveSpotifyTrackSearch(job)
                }
                onClick={() => queue.mutate()}
              >
                Search Spotify
              </Button>
            )}
          </>
        }
      >
        <SourceBlock title="Spotify match">{matchNote(item, job)}</SourceBlock>
      </SourceRow>
      {needsMatch && catalog.marketField}
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
      {catalog.failureMessage && (
        <Notice tone="danger">{catalog.failureMessage}</Notice>
      )}
      {queue.data?.skipped && needsMatch && !isActiveSpotifyTrackSearch(job) ? (
        <p role="status" className="ds-help">
          {queue.data.warnings.join(' ')}
        </p>
      ) : null}
      {review && (
        <SpotifyTrackSearchReview
          track={item}
          onClose={() => setReview(false)}
          onMatched={(id) => {
            if (id !== item.id) onResolved?.(id)
          }}
        />
      )}
    </>
  )
}
