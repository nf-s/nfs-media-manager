'use client'

import { useQuery } from '@tanstack/react-query'
import { AlbumPlaylistsSchema } from '@repo/schemas/tracks'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Section } from '@repo/ui/components/ds/facts'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { PlaylistPills } from './detail-frame'
import {
  AddToPlaylist,
  AdditionList,
  AdditionState,
  usePlaylistAdditions,
} from './playlist-addition-controls'

/** The album's playlists, with the control that adds it to another. */
export default function AlbumPlaylists({ albumId }: { albumId: string }) {
  const { apiBaseUrl } = useConfig()
  const { additionList, playlists, following } = usePlaylistAdditions(
    'album',
    albumId,
  )
  const query = useQuery({
    queryKey: ['album-playlists', albumId],
    refetchInterval: following ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/albums/${encodeURIComponent(albumId)}/playlists`,
        AlbumPlaylistsSchema,
      ),
  })

  const names = new Map(
    (playlists.data ?? []).map((playlist) => [playlist.id, playlist.name]),
  )
  const memberships = query.data?.playlists ?? []
  return (
    <Section
      title="Playlists"
      note={memberships.length ? formatCount(memberships.length) : undefined}
    >
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        >
          Playlists unavailable.
        </Notice>
      )}
      {query.data && (
        <PlaylistPills
          playlists={memberships.map((playlist) => ({
            ...playlist,
            title:
              playlist.trackCount > 0
                ? `${playlist.name} · ${formatCount(playlist.trackCount)} ${playlist.trackCount === 1 ? 'track' : 'tracks'}`
                : playlist.name,
          }))}
        />
      )}
      <AddToPlaylist mediaType="album" id={albumId} additions={additionList} />
      {additionList.length > 0 && (
        <AdditionList>
          {additionList.map((addition) => (
            <AdditionState
              key={addition.job.jobId}
              addition={addition}
              name={names.get(addition.playlistId) ?? 'Playlist'}
            />
          ))}
        </AdditionList>
      )}
    </Section>
  )
}
