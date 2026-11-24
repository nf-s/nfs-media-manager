'use client'

import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import {
  SpotifyArtistAlbumListingSchema,
  type SpotifyArtistAlbumListing,
} from '@repo/schemas/spotify-artist-albums'
import { Notice } from '@repo/ui/components/ds/feedback'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
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
    retryAt,
    unavailableReason,
  } = listing
  const coverage =
    formatItemCount(pagesSaved, { one: 'page', other: 'pages' }) + ' saved'
  const releases = formatItemCount(releasesSeen, {
    one: 'release entry',
    other: 'release entries',
  })
  if (completedAt) return `Complete for ${market} · ${coverage} · ${releases}`
  if (retryAt)
    return `Spotify is cooling down until ${formatDateTime(retryAt)} · ${coverage} · ${releases}`
  if (unavailableReason) return unavailableReason
  if (job?.status === 'queued') return `Queued · ${coverage}`
  if (job?.status === 'running')
    return listing.artistUrl
      ? `Fetching page ${pagesSaved + 1} · ${coverage} · ${releases}`
      : 'Finding the Spotify artist match'
  if (job?.status === 'failed')
    return `Fetch stopped · ${coverage} · ${releases}`
  if (job?.status === 'cancelled')
    return `Fetch cancelled · ${coverage} · ${releases}`
  return pagesSaved ? coverage : null
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
          aria-controls={open ? panelId : undefined}
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
                  listing &&
                  !listing.completedAt &&
                  !listing.unavailableReason ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="primary"
                      disabled={
                        fetch.isPending || running || Boolean(listing.retryAt)
                      }
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
                <Button
                  type="button"
                  variant="link"
                  onClick={() => void query.refetch()}
                >
                  Retry status
                </Button>
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
                  {needsMatchReview
                    ? ' · Review the Spotify artist match.'
                    : ''}
                </Notice>
              </div>
            )}
        </>
      }
    />
  )
}
