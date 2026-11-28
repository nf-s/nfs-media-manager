'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LibraryPlaylistDetail } from '../library-playlist-detail'
import { DetailPage } from '../detail-frame'
import { useLibraryView } from '../media-scope'
import { useConfig } from '../providers'
import {
  fetchLibraryPlaylist,
  libraryPlaylistKey,
  playlistLibraryForView,
  playlistLibraryViews,
} from '@/utils/library-playlists'
import { scopedHref } from '@/utils/media-scope'

/** A library playlist's own page, in the Playlists of its library. */
export default function LibraryPlaylistPageClient({
  playlistId,
}: {
  playlistId: string
}) {
  const { apiBaseUrl } = useConfig()
  const router = useRouter()
  const view = useLibraryView()
  const playlist = useQuery({
    queryKey: libraryPlaylistKey(playlistId),
    queryFn: ({ signal }) =>
      fetchLibraryPlaylist(apiBaseUrl, playlistId, signal),
  })
  const library = playlist.data?.library
  // The page belongs to the playlist's library, which the URL names.
  useEffect(() => {
    if (
      library &&
      playlistLibraryForView(view) !== library &&
      new URLSearchParams(window.location.search).get('mediaType') !==
        playlistLibraryViews[library]
    )
      router.replace(
        scopedHref(
          `${window.location.pathname}${window.location.search}`,
          playlistLibraryViews[library],
        ),
      )
  }, [library, view, router])
  const back = scopedHref('/playlists', view)
  return (
    <DetailPage back={{ href: back, label: 'Back to playlists' }}>
      <LibraryPlaylistDetail
        id={playlistId}
        onDeleted={() => router.push(back)}
      />
    </DetailPage>
  )
}
