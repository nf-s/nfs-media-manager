'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { State } from '@repo/ui/components/ds/feedback'
import {
  SpotifyAlbumReferenceState,
  useSpotifyAlbumReference,
} from '@/components/spotify-album-reference-link'
import { detailPageHref } from '@/utils/detail-inspector'

/** Destination for opening a track's release in a new tab or workspace. */
export default function AlbumFromTrackPage() {
  const params = useSearchParams()
  const router = useRouter()
  const trackId = params.get('trackId')
  const spotifyAlbumId = params.get('spotifyAlbumId')
  const album = useSpotifyAlbumReference(trackId, spotifyAlbumId)
  const id = album.data?.mediaItemId
  useEffect(() => {
    if (id) router.replace(detailPageHref({ kind: 'album', id }))
  }, [id, router])
  if (!trackId) return <State error title="Missing track ID" />
  return <SpotifyAlbumReferenceState album={album} />
}
