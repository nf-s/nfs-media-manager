'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AlbumPlaylistsSchema } from '@repo/schemas/tracks'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { playlistAlbumsHref, trackHref } from '@/utils/playlist-links'

export default function AlbumPlaylists({ albumId }: { albumId: string }) {
  const { apiBaseUrl } = useConfig()
  const query = useQuery({
    queryKey: ['album-playlists', albumId],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/albums/${encodeURIComponent(albumId)}/playlists`,
        AlbumPlaylistsSchema,
      ),
  })
  if (query.isError)
    return (
      <p role="alert" className="mt-4">
        Playlists unavailable.{' '}
        <button className="underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </p>
    )
  if (!query.data) return null
  const { playlists, tracks } = query.data
  if (!playlists.length && !tracks.length) return null
  return (
    <div className="detail-metadata mt-6">
      {playlists.length > 0 && (
        <section>
          <h2>Playlists</h2>
          <div className="detail-tags">
            {playlists.map((playlist) => (
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
        </section>
      )}
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
