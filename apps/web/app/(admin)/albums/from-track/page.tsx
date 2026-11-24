'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { State } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { CreatorDetailState } from '@/components/creator-detail-state'
import { errorMessage } from '@/components/lastfm-sync'
import { useConfig } from '@/components/providers'
import { resolveSpotifyAlbum } from '@/components/spotify-album-reference-link'
import { detailPageHref } from '@/utils/detail-inspector'

/** Destination for opening a track's release in a new tab or workspace. */
export default function AlbumFromTrackPage() {
  const params = useSearchParams()
  const router = useRouter()
  const { apiBaseUrl } = useConfig()
  const trackId = params.get('trackId')
  const spotifyAlbumId = params.get('spotifyAlbumId')
  const album = useQuery({
    queryKey: ['track', trackId, 'album-reference', spotifyAlbumId],
    queryFn: () =>
      resolveSpotifyAlbum(apiBaseUrl, trackId ?? '', spotifyAlbumId),
    enabled: Boolean(trackId),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const id = album.data?.mediaItemId
  useEffect(() => {
    if (id) router.replace(detailPageHref({ kind: 'album', id }))
  }, [id, router])
  if (!trackId) return <State error title="Missing track ID" />
  if (album.isError)
    return (
      <State
        error
        title={errorMessage(album.error, 'Could not open the Spotify release.')}
        action={<Button onClick={() => void album.refetch()}>Retry</Button>}
      />
    )
  return (
    <CreatorDetailState
      pending
      subject="album"
      retry={() => void album.refetch()}
    />
  )
}
