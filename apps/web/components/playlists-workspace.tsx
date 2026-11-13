'use client'

import Link from 'next/link'
import { useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import {
  PlaylistRemovalSchema,
  PlaylistSummarySchema,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
  TableState,
} from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import { errorMessage } from './lastfm-sync'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { playlistAlbumsHref, playlistTracksHref } from '@/utils/playlist-links'

type SortKey = 'name' | 'tracks' | 'imported'
type Direction = 'asc' | 'desc'

const sourceLabels = {
  spotify: 'Spotify',
  'spotify-liked': 'Liked Songs',
}

const importHref = scopedHref('/imports/spotify-playlists', 'album')

/** Refreshes playlists and everything their tracks appear in. */
export function invalidatePlaylists(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) =>
      [
        'playlists',
        'tracks',
        'track',
        'albums',
        'album',
        'album-playlists',
      ].includes(String(query.queryKey[0])),
  })
}

export function formatPlaylistDuration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function sortPlaylists(
  playlists: PlaylistSummary[],
  key: SortKey,
  direction: Direction,
) {
  const sign = direction === 'asc' ? 1 : -1
  return [...playlists].sort((left, right) => {
    if (key === 'tracks') return sign * (left.trackCount - right.trackCount)
    if (key === 'imported') {
      if (left.importedAt === right.importedAt) return 0
      if (left.importedAt === null) return 1
      if (right.importedAt === null) return -1
      return sign * left.importedAt.localeCompare(right.importedAt)
    }
    return sign * left.name.localeCompare(right.name)
  })
}

export default function PlaylistsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [sortBy, setSortBy] = useState<SortKey>('name')
  const [direction, setDirection] = useState<Direction>('asc')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState('')
  const query = useQuery({
    queryKey: ['playlists'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/playlists',
        z.array(PlaylistSummarySchema),
      ),
  })
  const remove = useMutation({
    mutationFn: (playlist: PlaylistSummary) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/${encodeURIComponent(playlist.id)}`,
        PlaylistRemovalSchema,
        { method: 'DELETE' },
      ),
    onMutate: () => setOutcome(''),
    onSuccess: async (result, playlist) => {
      setConfirmingId(null)
      setOutcome(
        `Removed ${playlist.name} and ${result.removedTracks.toLocaleString()} ${result.removedTracks === 1 ? 'track' : 'tracks'}.`,
      )
      await invalidatePlaylists(client)
    },
  })
  function sort(key: SortKey) {
    if (sortBy === key) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setDirection(key === 'name' ? 'asc' : 'desc')
    }
  }
  const sorting = { sortBy, direction, onSort: sort }
  const playlists = sortPlaylists(query.data ?? [], sortBy, direction)
  const confirming = playlists.find((playlist) => playlist.id === confirmingId)
  return (
    <section className="admin-page table-workspace">
      <div className="tags-toolbar">
        <h1>Playlists</h1>
        <span className="quiet text-xs" aria-live="polite">
          {query.data ? `${query.data.length.toLocaleString()} playlists` : ''}
        </span>
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link href={importHref}>Import playlists</Link>
        </Button>
      </div>
      {confirming && (
        <div
          className="tags-bulk"
          data-active
          role="group"
          aria-label="Confirm playlist removal"
        >
          <span>
            Remove <strong>{confirming.name}</strong> and its tracks that are in
            no other playlist? Albums stay in the library.
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(confirming)}
          >
            {remove.isPending ? 'Removing...' : 'Confirm removal'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => setConfirmingId(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      {remove.isError && (
        <p className="tags-outcome" role="alert">
          {errorMessage(remove.error, 'Could not remove the playlist.')}
        </p>
      )}
      {outcome && (
        <p className="tags-outcome" role="status">
          {outcome}
        </p>
      )}
      <TableScroll
        className="tags-scroll"
        role="region"
        aria-label="Playlists"
        aria-busy={query.isFetching}
      >
        <table className="compact-table" aria-label="Playlists">
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="sr-only">Artwork</span>
              </TableHead>
              <SortHead sortKey="name" label="Playlist" {...sorting} />
              <TableHead>Source</TableHead>
              <TableHead>Owner</TableHead>
              <SortHead sortKey="tracks" label="Tracks" numeric {...sorting} />
              <TableHead>In album library</TableHead>
              <TableHead className="numeric">Albums</TableHead>
              <TableHead className="numeric">Duration</TableHead>
              <SortHead sortKey="imported" label="Imported" {...sorting} />
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!playlists.length && (
              <TableState colSpan={10} error={query.isError}>
                {query.isPending ? (
                  'Loading playlists...'
                ) : query.isError ? (
                  <>
                    Could not load playlists.{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => query.refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : (
                  <>
                    No playlists.{' '}
                    <Link href={importHref}>Import playlists</Link>
                  </>
                )}
              </TableState>
            )}
            {playlists.map((playlist) => (
              <TableRow
                key={playlist.id}
                data-selected={playlist.id === confirmingId || undefined}
              >
                <TableCell className="w-10">
                  {playlist.artworkUrl && (
                    <MediaArtwork
                      src={playlist.artworkUrl}
                      alt=""
                      fallbackLabel=""
                      containerClassName="size-6 rounded"
                      imageClassName="size-6 object-cover"
                      fallbackClassName="size-6"
                    />
                  )}
                </TableCell>
                <TableCell>
                  <Link
                    className="font-medium hover:underline"
                    href={playlistTracksHref(playlist.name)}
                  >
                    {playlist.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {playlist.source ? sourceLabels[playlist.source] : 'Library'}
                </TableCell>
                <TableCell>{playlist.ownerName ?? '-'}</TableCell>
                <TableCell className="numeric">
                  <Link href={playlistTracksHref(playlist.name)}>
                    {playlist.trackCount.toLocaleString()}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {playlist.trackCount > 0
                    ? `${playlist.linkedTrackCount.toLocaleString()} of ${playlist.trackCount.toLocaleString()}`
                    : '-'}
                </TableCell>
                <TableCell className="numeric">
                  <Link href={playlistAlbumsHref(playlist.name)}>
                    {playlist.albumCount.toLocaleString()}
                  </Link>
                </TableCell>
                <TableCell className="numeric whitespace-nowrap">
                  {formatPlaylistDuration(playlist.durationSec)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {playlist.importedAt ? (
                    <time dateTime={playlist.importedAt}>
                      {new Date(playlist.importedAt).toLocaleDateString()}
                    </time>
                  ) : (
                    '-'
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {playlist.source && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      aria-label={`Remove ${playlist.name}`}
                      onClick={() => {
                        setConfirmingId(playlist.id)
                        setOutcome('')
                        remove.reset()
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
      </TableScroll>
    </section>
  )
}

function SortHead({
  sortKey,
  label,
  numeric = false,
  sortBy,
  direction,
  onSort,
}: {
  sortKey: SortKey
  label: string
  numeric?: boolean
  sortBy: SortKey
  direction: Direction
  onSort: (key: SortKey) => void
}) {
  const active = sortBy === sortKey
  return (
    <TableHead
      className={numeric ? 'numeric' : undefined}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}
        {active ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </TableHead>
  )
}
