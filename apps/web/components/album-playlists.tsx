'use client'

import { useQuery } from '@tanstack/react-query'
import { AlbumPlaylistsSchema } from '@repo/schemas/tracks'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { DetailLink } from './detail-link'
import { PlaylistPlayButton } from './playlist-detail'
import {
  AddToPlaylist,
  AdditionState,
  usePlaylistAdditions,
} from './playlist-addition-controls'

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
    <div className="detail-metadata mt-6">
      <section aria-label="Playlist memberships">
        {query.isError && (
          <p role="alert">
            Playlists unavailable.{' '}
            <button className="underline" onClick={() => query.refetch()}>
              Retry
            </button>
          </p>
        )}
        {memberships.length > 0 && (
          <div className="detail-tags">
            {memberships.map((playlist) => (
              <span
                key={playlist.id}
                className="inline-flex items-center gap-1"
              >
                <PlaylistPlayButton playlist={playlist} />
                <DetailLink
                  className="metadata-tag"
                  kind="playlist"
                  id={playlist.id}
                >
                  {playlist.name}
                  {playlist.trackCount > 0 && (
                    <span className="quiet">
                      {' '}
                      · {playlist.trackCount}{' '}
                      {playlist.trackCount === 1 ? 'track' : 'tracks'}
                    </span>
                  )}
                </DetailLink>
              </span>
            ))}
          </div>
        )}
        <AddToPlaylist
          mediaType="album"
          id={albumId}
          playlists={playlists}
          additions={additionList}
        />
        {additionList.length > 0 && (
          <ul className="mt-2 grid gap-1 text-sm" aria-label="Additions">
            {additionList.map((addition) => (
              <AdditionState
                key={addition.job.jobId}
                addition={addition}
                name={names.get(addition.playlistId) ?? 'Playlist'}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
