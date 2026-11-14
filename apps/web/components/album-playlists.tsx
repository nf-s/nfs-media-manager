'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AlbumPlaylistsSchema } from '@repo/schemas/tracks'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { playlistAlbumsHref, trackHref } from '@/utils/playlist-links'
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
  const tracks = query.data?.tracks ?? []
  return (
    <div className="detail-metadata mt-6">
      <section>
        <h2>Playlists</h2>
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
              <Link
                key={playlist.id}
                className="metadata-tag"
                href={playlistAlbumsHref(playlist.name)}
              >
                {playlist.name}
                {playlist.trackCount > 0 && (
                  <span className="quiet">
                    {' '}
                    · {playlist.trackCount}{' '}
                    {playlist.trackCount === 1 ? 'track' : 'tracks'}
                  </span>
                )}
              </Link>
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
      {tracks.length > 0 && (
        <section>
          <h2>Tracks in the track library</h2>
          <ul className="grid gap-1 text-sm">
            {tracks.map((track) => (
              <li key={track.id}>
                <Link
                  className="underline underline-offset-2"
                  href={trackHref(track.id)}
                >
                  {track.title}
                </Link>
                {track.playlists.length > 0 && (
                  <span className="quiet"> · {track.playlists.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
