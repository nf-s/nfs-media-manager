'use client'

import { ReadButton } from '@/components/read-button'
import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import {
  SpotifyArtistAlbumListingSchema,
  type SpotifyArtistAlbumListing,
} from '@repo/schemas/spotify-artist-albums'
import { Notice } from '@repo/ui/components/ds/feedback'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'
import { formatDateTime, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { providerLogoUrl } from '@/utils/provider-logos'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { EmbeddedMediaBrowser } from './media-browser'
import { useConfig } from './providers'

function active(listing: SpotifyArtistAlbumListing | undefined) {
  return listing?.job?.status === 'queued' || listing?.job?.status === 'running'
}

function listingSummary(listing: SpotifyArtistAlbumListing) {
  const {
    completedAt,
    job,
    market,
    pagesSaved,
    releasesSeen,
    unavailableReason,
  } = listing
  const coverage =
    formatItemCount(pagesSaved, { one: 'page', other: 'pages' }) + ' saved'
  const releases = formatItemCount(releasesSeen, {
    one: 'release entry',
    other: 'release entries',
  })
  if (unavailableReason) return unavailableReason
  if (completedAt) return market ? `${coverage} · Market ${market}` : coverage
  if (job) return `${coverage} · ${releases}`
  return pagesSaved ? coverage : null
}

function listingFeedback(
  listing: SpotifyArtistAlbumListing | undefined,
): ButtonFeedback | undefined {
  if (!listing) return undefined
  if (listing.completedAt)
    return {
      phase: 'done',
      label: `${formatItemCount(listing.releasesSeen, { one: 'release', other: 'releases' })} read`,
    }
  if (listing.retryAt)
    return {
      phase: 'waiting',
      label: `Waiting until ${formatDateTime(listing.retryAt)}`,
    }
  if (listing.job?.status === 'queued')
    return { phase: 'queued', label: 'Queued' }
  if (listing.job?.status === 'running')
    return {
      phase: 'running',
      label: listing.artistUrl
        ? `Fetching page ${listing.pagesSaved + 1}`
        : 'Matching artist…',
    }
  if (listing.job?.status === 'failed')
    return { phase: 'failed', label: 'Fetch failed' }
  if (listing.job?.status === 'cancelled')
    return { phase: 'cancelled', label: 'Fetch cancelled' }
}

export function ArtistAlbums({
  artistId,
  showSources,
}: {
  artistId: string
  showSources: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const path = `/api/v1/artists/${encodeURIComponent(artistId)}/albums/spotify`
  const queryKey = ['artist', artistId, 'spotify-albums']
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, path, SpotifyArtistAlbumListingSchema, {
        signal,
      }),
    refetchInterval: ({ state }) => {
      if (active(state.data)) return 1800
      const retryAt = state.data?.retryAt
      return retryAt
        ? Math.max(500, Date.parse(retryAt) - Date.now() + 100)
        : false
    },
  })
  const fetch = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, path, SpotifyArtistAlbumListingSchema, {
        method: 'POST',
      }),
    onSuccess: (listing) => {
      client.setQueryData(queryKey, listing)
      void client.invalidateQueries({ queryKey: ['job-activity'] })
      setOpen(false)
    },
    onError: () => {
      void query.refetch()
    },
  })
  const listing = query.data
  const feedback: ButtonFeedback | undefined = fetch.isPending
    ? { phase: 'pending', label: 'Requesting…' }
    : fetch.isError
      ? { phase: 'failed', label: 'Request failed · retry' }
      : listingFeedback(listing)
  const pagesSaved = listing?.pagesSaved ?? 0
  const knownArtist = Boolean(listing?.artistUrl)
  useEffect(() => {
    if (!pagesSaved) return
    for (const key of ['browse', 'browse-count', 'facets'])
      void client.invalidateQueries({ queryKey: ['albums', key] })
  }, [client, pagesSaved])
  useEffect(() => {
    if (knownArtist)
      void client.invalidateQueries({ queryKey: ['artist', artistId] })
  }, [client, artistId, knownArtist])

  const summary = listing ? listingSummary(listing) : null
  const details = listing?.job ? (
    <Button size="xs" variant="link" asChild>
      <DetailLink kind="job" id={listing.job.jobId}>
        View listing job
      </DetailLink>
    </Button>
  ) : null
  const running = active(listing)
  const resumable =
    !running &&
    (pagesSaved > 0 ||
      listing?.job?.status === 'cancelled' ||
      listing?.job?.status === 'failed')
  const needsMatchReview = listing?.job?.errorMessage?.startsWith(
    'ArtistSearchAmbiguousError',
  )

  return (
    <EmbeddedMediaBrowser
      mediaType="album"
      creator={{ creatorId: artistId }}
      storage="artist-albums"
      sort={{ key: 'title', direction: 'asc' }}
      countActions={
        <Button
          type="button"
          variant="link"
          aria-expanded={open}
          aria-label="Fetch albums"
          aria-controls={open ? panelId : undefined}
          feedback={!open ? feedback : undefined}
          onClick={() => setOpen(!open)}
        >
          <Download className="ds-i" aria-hidden />
          Fetch albums
        </Button>
      }
      beforeResults={
        <>
          {open && (
            <div id={panelId} className="browse-notice">
              <Notice
                icon={
                  <ProviderMark
                    name="Spotify"
                    src={providerLogoUrl('spotify')}
                    hidden
                  />
                }
                action={
                  listing && !listing.unavailableReason ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="primary"
                      disabled={
                        fetch.isPending ||
                        running ||
                        Boolean(listing.retryAt) ||
                        Boolean(listing.completedAt)
                      }
                      feedback={feedback}
                      onClick={() => fetch.mutate()}
                    >
                      {resumable
                        ? `Resume from page ${pagesSaved + 1}`
                        : 'Fetch from Spotify'}
                    </Button>
                  ) : undefined
                }
              >
                {listing ? (
                  <>
                    Spotify{' '}
                    {listing.artistUrl && (
                      <a
                        href={listing.artistUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        artist match
                      </a>
                    )}
                    {listing.market && ` · ${listing.market}`}
                    {
                      ' · Albums, singles, compilations and appearances. Saved outside the library.'
                    }
                  </>
                ) : query.isError ? (
                  'Could not load Spotify listing status.'
                ) : (
                  'Checking Spotify listing status…'
                )}
              </Notice>
              {query.isError && (
                <ReadButton
                  type="button"
                  variant="link"
                  read={() => query.refetch()}
                >
                  Retry status
                </ReadButton>
              )}
              {fetch.isError && (
                <Notice tone="danger">
                  {errorMessage(
                    fetch.error,
                    'Could not start the Spotify fetch.',
                  )}
                </Notice>
              )}
            </div>
          )}
          {summary &&
            (open || (listing?.job && !listing.unavailableReason)) && (
              <div className="browse-notice">
                <Notice
                  tone={
                    listing?.job?.status === 'failed' || listing?.retryAt
                      ? 'attention'
                      : undefined
                  }
                  action={
                    needsMatchReview ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={showSources}
                      >
                        Review Sources
                      </Button>
                    ) : (
                      details
                    )
                  }
                >
                  {summary}
                  {needsMatchReview ? ' · Several Spotify artists match.' : ''}
                </Notice>
              </div>
            )}
        </>
      }
    />
  )
}
