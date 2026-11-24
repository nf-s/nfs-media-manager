'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import type { MouseEvent, ReactNode } from 'react'
import { SpotifyAlbumReferenceResultSchema } from '@repo/schemas/spotify-album-reference'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { detailPageHref, type DetailEntry } from '@/utils/detail-inspector'
import { useDetailInspector } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'

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
  spotifyAlbumId: string
  catalogId?: string | null
  children: ReactNode
  className?: string
  workspaceLabel?: string
  onNavigate?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const inspector = useDetailInspector()
  const router = useRouter()
  const resolve = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/catalog/spotify-album-reference',
        SpotifyAlbumReferenceResultSchema,
        {
          method: 'POST',
          body: JSON.stringify({ trackId, spotifyAlbumId }),
        },
      ),
  })

  function open(event: MouseEvent<HTMLElement>) {
    if (
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
        if (jobId) {
          void client.invalidateQueries({ queryKey: ['job-activity'] })
          void client.invalidateQueries({ queryKey: ['history', mediaItemId] })
        }
        onNavigate?.()
        const target: DetailEntry = { kind: 'album', id: mediaItemId }
        if (inspector) inspector.open(target, trigger)
        else router.push(detailPageHref(target))
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
        <Button
          type="button"
          className={className}
          variant="link"
          aria-busy={resolve.isPending}
          onClick={open}
        >
          {children}
        </Button>
      )}
      {resolve.isError && (
        <span role="alert" className="ds-muted">
          {errorMessage(resolve.error, 'Could not open the Spotify release.')}
        </span>
      )}
    </>
  )
}
