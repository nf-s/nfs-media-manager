'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MouseEvent, ReactNode } from 'react'
import { SpotifyAlbumReferenceResultSchema } from '@repo/schemas/spotify-album-reference'
import { State } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { detailPageHref, type DetailTarget } from '@/utils/detail-inspector'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { CreatorDetailState } from './creator-detail-state'
import { useDetailInspector } from './detail-inspector-context'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'

export function useSpotifyAlbumReference(
  trackId: string | null,
  spotifyAlbumId: string | null = null,
) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useQuery({
    queryKey: ['spotify-album-reference', trackId, spotifyAlbumId],
    queryFn: async () => {
      const result = await fetchApiData(
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
      ).finally(() => {
        void client.invalidateQueries({ queryKey: ['history', trackId] })
      })
      if (!spotifyAlbumId)
        void client.invalidateQueries({
          queryKey: ['track', trackId],
          exact: true,
        })
      void client.invalidateQueries({
        queryKey: ['album', result.mediaItemId],
        exact: true,
      })
      void client.invalidateQueries({
        queryKey: ['history', result.mediaItemId],
      })
      void client.invalidateQueries({
        queryKey: ['catalog-discoveries', 'media', result.mediaItemId],
      })
      return result
    },
    enabled: Boolean(trackId),
    retry: false,
    gcTime: 0,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

export function SpotifyAlbumReferenceState({
  album,
}: {
  album: ReturnType<typeof useSpotifyAlbumReference>
}) {
  function retry() {
    void album.refetch()
  }
  if (album.isError && !album.isFetching)
    return (
      <State
        error
        title={errorMessage(album.error, 'Could not open the Spotify release')}
        action={<Button onClick={retry}>Retry</Button>}
      />
    )
  return (
    <CreatorDetailState
      pending
      pendingLabel="Opening Spotify album"
      subject="album from Spotify"
      retry={retry}
    />
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
  const inspector = useDetailInspector()
  const target: DetailTarget = {
    kind: 'spotify-album-reference',
    id: trackId,
    spotifyAlbumId: spotifyAlbumId ?? undefined,
  }
  const savedAlbum: DetailTarget | undefined = catalogId
    ? { kind: 'album', id: catalogId }
    : undefined
  const pageHref = detailPageHref(savedAlbum ?? target)

  function open(event: MouseEvent<HTMLElement>) {
    if (
      !inspector ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    )
      return
    event.preventDefault()
    event.stopPropagation()
    onNavigate?.()
    inspector.open(target, event.currentTarget)
  }

  return (
    <a
      {...workspaceTabLinkProps(pageHref, workspaceLabel)}
      href={(savedAlbum && inspector?.href(savedAlbum)) || pageHref}
      className={className}
      onClick={open}
    >
      {children}
    </a>
  )
}
