'use client'

import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BrowseFilter } from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  TrackListItemSchema,
  trackSourceLabels,
  trackSpotifyMatchLabels,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { tracksHref } from '@/utils/track-browse'
import {
  errorMessage,
  refreshScrobbleLinks,
  useLastfmSyncStatus,
} from './lastfm-sync'
import { useConfig } from './providers'

const source: BrowseFilter = {
  field: 'source',
  value: trackSourceLabels.lastfm,
  mode: 'required',
}
const unmatched: BrowseFilter = {
  field: 'spotifyMatch',
  value: trackSpotifyMatchLabels.unmatched,
  mode: 'required',
}

export async function loadLastfmTrackMatchCounts(apiBaseUrl: string) {
  async function count(filters: BrowseFilter[]) {
    const params = new URLSearchParams({
      size: '1',
      filters: JSON.stringify(filters),
    })
    const result = await fetchApiData(
      apiBaseUrl,
      `/api/v1/tracks?${params}`,
      PaginatedDataSchema(TrackListItemSchema),
    )
    return result.totalCount
  }
  const [total, withoutSpotify] = await Promise.all([
    count([source]),
    count([source, unmatched]),
  ])
  return { total, withoutSpotify }
}

export default function LastfmTrackMatches() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const status = useLastfmSyncStatus()
  const counts = useQuery({
    queryKey: ['tracks', 'lastfm-match-counts'],
    queryFn: () => loadLastfmTrackMatchCounts(apiBaseUrl),
  })
  const refresh = useMutation({
    mutationFn: () => refreshScrobbleLinks(apiBaseUrl, client),
  })
  return (
    <section
      className="film-import-workflow"
      aria-label="Last.fm track matches"
    >
      <h2>Track matches</h2>
      {counts.isPending ? (
        <p role="status">Loading track matches...</p>
      ) : counts.isError ? (
        <p role="alert">
          Could not load track matches.{' '}
          <Button variant="ghost" size="sm" onClick={() => counts.refetch()}>
            Retry
          </Button>
        </p>
      ) : (
        <dl className="detail-metrics">
          <div>
            <dt>Last.fm tracks in library</dt>
            <dd>
              <Link href={tracksHref([source])}>
                {counts.data.total.toLocaleString()}
              </Link>
            </dd>
          </div>
          <div>
            <dt>No Spotify match</dt>
            <dd>
              <Link href={tracksHref([source, unmatched])}>
                {counts.data.withoutSpotify.toLocaleString()}
              </Link>
            </dd>
          </div>
        </dl>
      )}
      <p className="muted">
        Spotify links come from existing Spotify imports or a unique title in
        the linked album’s stored track list. Open a track to see which applies
        and the names recorded by Last.fm. Spotify has not been searched for
        unmatched tracks.
      </p>
      <div className="form-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={
            !status.data?.configured ||
            !status.data.storedScrobbles ||
            refresh.isPending ||
            status.data.state === 'running'
          }
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? 'Refreshing...' : 'Refresh matches'}
        </Button>
      </div>
      <p className="muted">
        Use stored history to update matches after library metadata changes.
        This makes no Last.fm or Spotify requests.
      </p>
      {refresh.isSuccess && <p role="status">Track matches refreshed.</p>}
      {refresh.isError && (
        <p role="alert">
          {errorMessage(refresh.error, 'Could not refresh track matches.')}
        </p>
      )}
    </section>
  )
}
