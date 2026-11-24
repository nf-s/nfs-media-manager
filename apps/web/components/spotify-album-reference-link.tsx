'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { MouseEvent, ReactNode } from 'react'
import { SpotifyAlbumReferenceResultSchema } from '@repo/schemas/spotify-album-reference'
import { fetchApiData } from '@/utils/api'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { useDetailInspector } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'

export function resolveSpotifyAlbum(
  apiBaseUrl: string,
  trackId: string,
  spotifyAlbumId?: string | null,
) {
  return fetchApiData(
    apiBaseUrl,
    '/api/v1/catalog/spotify-album-reference',
    SpotifyAlbumReferenceResultSchema,
    {
      method: 'POST',
      body: JSON.stringify({
        trackId,
        spotifyAlbumId: spotifyAlbumId ?? undefined,
      }),
    },
  )
}

/** A recorded parent can be opened without importing it or crawling related items. */
export function SpotifyAlbumReferenceLink({
  trackId,
  spotifyAlbumId,
  catalogId,
  children,
  className,
  workspaceLabel,
  onNavigate,
}: {
  trackId: string
  spotifyAlbumId?: string | null
  catalogId?: string | null
  children: ReactNode
  className?: string
  workspaceLabel?: string
  onNavigate?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const inspector = useDetailInspector()
  const params = new URLSearchParams({ trackId })
  if (spotifyAlbumId) params.set('spotifyAlbumId', spotifyAlbumId)
  const href = `/albums/from-track?${params}`
  const resolve = useMutation({
    retry: false,
    mutationFn: () => resolveSpotifyAlbum(apiBaseUrl, trackId, spotifyAlbumId),
  })

  function open(event: MouseEvent<HTMLElement>) {
    if (
      !inspector ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    )
      return
    event.preventDefault()
    event.stopPropagation()
    if (resolve.isPending) return
    const trigger = event.currentTarget
    resolve.mutate(undefined, {
      onSuccess: ({ mediaItemId, jobId }) => {
        if (!spotifyAlbumId)
          void client.invalidateQueries({
            queryKey: ['track', trackId],
            exact: true,
          })
        if (jobId) {
          void client.invalidateQueries({ queryKey: ['job-activity'] })
          void client.invalidateQueries({ queryKey: ['history', mediaItemId] })
        }
        onNavigate?.()
        inspector.open({ kind: 'album', id: mediaItemId }, trigger)
      },
    })
  }

  return (
    <>
      {catalogId ? (
        <DetailLink
          kind="album"
          id={catalogId}
          className={className}
          workspaceLabel={workspaceLabel}
          aria-busy={resolve.isPending}
          onClick={open}
        >
          {children}
        </DetailLink>
      ) : (
        <a
          {...workspaceTabLinkProps(href, workspaceLabel)}
          href={href}
          className={className}
          aria-busy={resolve.isPending}
          onClick={open}
        >
          {children}
        </a>
      )}
      {resolve.isError && (
        <span role="alert" className="ds-muted">
          {errorMessage(resolve.error, 'Could not open the Spotify release.')}
        </span>
      )}
    </>
  )
}
