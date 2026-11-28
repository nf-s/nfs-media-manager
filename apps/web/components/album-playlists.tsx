'use client'

import { ReadButton } from '@/components/read-button'
import { useQuery } from '@tanstack/react-query'
import { AlbumPlaylistsSchema } from '@repo/schemas/tracks'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { List } from '@repo/ui/components/ds/list-row'
import { Section } from '@repo/ui/components/ds/facts'
import { formatCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { PlaylistPills } from './detail-frame'
import {
  AdditionList,
  AdditionState,
  useAddToPlaylist,
  usePlaylistAdditions,
} from './playlist-addition-controls'
import {
  LibraryPlaylistMembershipRows,
  MembershipsError,
  useLibraryPlaylistMemberships,
} from './item-playlists'

/**
 * The album's playlists: imported playlists, then the library playlists that
 * hold it, with the control that adds it to a Spotify playlist.
 */
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
  const library = useLibraryPlaylistMemberships('albums', albumId)
  const libraryPlaylists = library.data ?? []
  const count = memberships.length + libraryPlaylists.length
  const adding = useAddToPlaylist(
    'album',
    albumId,
    additionList,
    playlists.data,
  )
  return (
    <Section
      title="Playlists"
      note={count ? formatCount(count) : undefined}
      aside={adding.action}
    >
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => query.refetch()}>
              Retry
            </ReadButton>
          }
        >
          Playlists unavailable.
        </Notice>
      )}
      {memberships.length > 0 && (
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
      {library.isError && <MembershipsError retry={() => library.refetch()} />}
      {libraryPlaylists.length > 0 && (
        <List compact>
          <LibraryPlaylistMembershipRows playlists={libraryPlaylists} />
        </List>
      )}
      {query.isSuccess && library.isSuccess && count === 0 && (
        <State size="sm" title="In no playlist" />
      )}
      {adding.notice}
      {additionList.length > 0 && (
        <AdditionList>
          {additionList.map((addition) => (
            <AdditionState
              key={addition.job.jobId}
              addition={addition}
              name={names.get(addition.playlistId) ?? 'Playlist'}
              receipt={adding.receipt}
            />
          ))}
        </AdditionList>
      )}
    </Section>
  )
}
