'use client'

import { ReadButton } from '@/components/read-button'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { invalidateScrobbleLinks } from './lastfm-sync'
import { SourceHistory } from './provider-sources'
import {
  SpotifyTrackSearchCandidates,
  SpotifyTrackSearchJobStatus,
  SpotifyTrackSearchResult,
  SpotifyTrackSearchReview,
  isActiveSpotifyTrackSearch,
  searchReceiptId,
  spotifyTrackSearchSavedResults,
  type SpotifyTrackSearchSelection,
  useSavedSpotifyTrackSearch,
} from './spotify-track-search'
import { canMergeLastfmTrack, TrackMergePanel } from './track-merge'

function matchNote(
  item: TrackDetail,
  job: SpotifyTrackSearchJob | null | undefined,
  acceptedInteractive: boolean,
) {
  if (job?.acceptedTrackId === item.id && job.matchMethod === 'automatic')
    return 'The track title and artist credits matched automatically.'
  if (!spotifyTrackUri(item.spotifyTrackId))
    return item.spotifyAlternate
      ? 'Another library version of this recording has a Spotify track ID.'
      : 'Search Spotify by track title or artist.'
  if (item.spotifyMatch === 'spotify-search')
    return acceptedInteractive || job?.acceptedTrackId === item.id
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
  const client = useQueryClient()
  const view = useDetailView()
  const [open, setOpen] = useState(
    view.params.get('sourceProvider') === 'spotify',
  )
  const sourceParams = new URLSearchParams(view.params)
  sourceParams.set('sourceProvider', 'spotify')
  sourceParams.set('tab', 'sources')
  const [matching, setMatching] = useState<
    | { mode: 'edit-query' | 'library' }
    | { mode: 'review-results'; selection?: SpotifyTrackSearchSelection }
    | null
  >(null)
  const search = useSavedSpotifyTrackSearch(item.id)
  const job = search.data?.job
  const latestInteractive = search.data?.interactiveResults?.[0]
  const acceptedInteractive =
    search.data?.interactiveResults?.some(
      ({ acceptedTrackId }) => acceptedTrackId === item.id,
    ) ?? false
  const observedJob = useRef<SpotifyTrackSearchJob | null | undefined>(
    undefined,
  )
  const direct = Boolean(spotifyTrackUri(item.spotifyTrackId))
  const alternate = item.spotifyAlternate
  const needsMatch = !direct && !alternate
  const savedResults = spotifyTrackSearchSavedResults(search.data)
  const hasCandidates = savedResults.length > 0
  const searchActive = isActiveSpotifyTrackSearch(job)
  const canSearchLibrary = needsMatch && canMergeLastfmTrack(item)
  useEffect(() => {
    if (job === undefined) return
    const previous = observedJob.current
    observedJob.current = job
    // A last.fm name can be intentionally separated again after a past search.
    // Follow a new acceptance observed here, never redirect on old history alone.
    if (
      previous === undefined ||
      job?.matchMethod !== 'automatic' ||
      !job.acceptedTrackId ||
      (previous?.jobId === job.jobId &&
        previous.acceptedTrackId === job.acceptedTrackId)
    )
      return
    const replaced = job.acceptedTrackId !== item.id
    if (replaced) onResolved?.(job.acceptedTrackId)
    void invalidateScrobbleLinks(client, replaced ? item.id : undefined)
  }, [job, client, item.id, onResolved])
  const jobTime = job?.finishedAt ?? job?.startedAt ?? job?.createdAt
  const time =
    latestInteractive && (!jobTime || latestInteractive.searchedAt > jobTime)
      ? latestInteractive.searchedAt
      : jobTime
  const label = direct
    ? trackSpotifyMatchLabels[item.spotifyMatch]
    : alternate
      ? 'Other Spotify version'
      : trackSpotifyMatchLabels.unmatched
  return (
    <>
      <SourceRow
        name="Spotify"
        open={open}
        onToggle={setOpen}
        summaryProps={workspaceTabLinkProps(
          view.workspaceHref(sourceParams),
          'Spotify',
        )}
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
            {job && !hasCandidates && (
              <SpotifyTrackSearchResult job={job} currentTrackId={item.id} />
            )}
            {needsMatch && hasCandidates && (
              <Button
                size="xs"
                aria-expanded={open}
                onClick={() => setOpen(true)}
              >
                Match to Spotify
              </Button>
            )}
            {needsMatch && (
              <Button
                size="xs"
                aria-haspopup="dialog"
                onClick={() => setMatching({ mode: 'edit-query' })}
              >
                Search Spotify
              </Button>
            )}
          </>
        }
      >
        {open && !direct && hasCandidates ? (
          <SourceBlock title="Saved Spotify matches">
            {savedResults.map(({ receipt, searchedAt, candidates }, index) => (
              <div className="data-stack" key={searchReceiptId(receipt)}>
                {(index > 0 ||
                  ('jobId' in receipt && receipt.jobId !== job?.jobId)) && (
                  <p className="ds-help">
                    Search from {formatDateTime(searchedAt)}
                  </p>
                )}
                <SpotifyTrackSearchCandidates
                  candidates={candidates}
                  disabled={searchActive}
                  onSelect={
                    needsMatch
                      ? (candidate) =>
                          setMatching({
                            mode: 'review-results',
                            selection: { ...receipt, candidate },
                          })
                      : undefined
                  }
                />
              </div>
            ))}
          </SourceBlock>
        ) : (
          <SourceBlock title="Spotify match">
            {matchNote(item, job, acceptedInteractive)}
          </SourceBlock>
        )}
        {open && (
          <SourceBlock title="Response history">
            <SourceHistory
              scope={{ kind: 'track', id: item.id }}
              row={{ id: 'spotify', label: 'Spotify' }}
            />
          </SourceBlock>
        )}
      </SourceRow>
      {search.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => search.refetch()}>
              Retry
            </ReadButton>
          }
        >
          Could not load the saved Spotify search.
        </Notice>
      )}
      {(matching?.mode === 'edit-query' ||
        matching?.mode === 'review-results') && (
        <SpotifyTrackSearchReview
          track={item}
          searchMode={matching.mode}
          initialSelection={
            matching.mode === 'review-results' ? matching.selection : undefined
          }
          onClose={() => setMatching(null)}
          onSearchLibrary={
            canSearchLibrary
              ? () => setMatching({ mode: 'library' })
              : undefined
          }
          onMatched={(id) => {
            if (id !== item.id) onResolved?.(id)
          }}
        />
      )}
      {matching?.mode === 'library' && (
        <TrackMergePanel
          track={item}
          onClose={() => setMatching(null)}
          onMerged={(id) => onResolved?.(id)}
        />
      )}
    </>
  )
}
