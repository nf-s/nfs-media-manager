'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  TableState,
} from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { sortTableRows } from '@/utils/secondary-table'
import MediaArtwork from './media-artwork'
import { errorMessage } from './lastfm-sync'
import { PlaylistDrawer } from './playlist-detail'
import { usePlaylistDrawer } from '@/hooks/usePlaylistDrawer'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { playlistAlbumsHref, playlistTracksHref } from '@/utils/playlist-links'
import {
  formatPlaylistDuration,
  invalidatePlaylists,
  playlistSourceLabel,
} from '@/utils/playlist-sync'
import { youtubeScheduleLabels } from '@/utils/youtube'

export { formatPlaylistDuration, invalidatePlaylists }

type Direction = 'asc' | 'desc'

const importHref = scopedHref('/imports/spotify-playlists', 'album')

function formatShortDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

export type PlaylistSortKey =
  | 'name'
  | 'source'
  | 'owner'
  | 'tracks'
  | 'linkedTracks'
  | 'albums'
  | 'duration'
  | 'imported'
  | 'schedule'
  | 'checked'
  | 'added'
  | 'description'
  | 'nextSync'

type PlaylistColumn = TableColumn &
  (
    | { key: PlaylistSortKey; sortable: true }
    | { key: 'artwork' | 'actions'; sortable: false }
  )

const playlistColumns: readonly PlaylistColumn[] = [
  { key: 'artwork', sortable: false, label: 'Artwork' },
  { key: 'name', sortable: true, label: 'Playlist', required: true },
  { key: 'source', sortable: true, label: 'Source' },
  { key: 'owner', sortable: true, label: 'Owner' },
  { key: 'tracks', sortable: true, label: 'Tracks' },
  { key: 'linkedTracks', sortable: true, label: 'In album library' },
  { key: 'albums', sortable: true, label: 'Albums' },
  { key: 'duration', sortable: true, label: 'Duration' },
  { key: 'imported', sortable: true, label: 'Imported' },
  { key: 'schedule', sortable: true, label: 'Schedule' },
  { key: 'checked', sortable: true, label: 'Last checked' },
  { key: 'added', sortable: true, label: 'Added to library' },
  {
    key: 'description',
    sortable: true,
    label: 'Description',
    defaultVisible: false,
  },
  {
    key: 'nextSync',
    sortable: true,
    label: 'Next import',
    defaultVisible: false,
  },
  { key: 'actions', sortable: false, label: 'Actions' },
]

export function playlistSortValue(
  playlist: PlaylistSummary,
  key: PlaylistSortKey,
) {
  switch (key) {
    case 'name':
      return playlist.name
    case 'source':
      return playlistSourceLabel(playlist.source)
    case 'owner':
      return playlist.ownerName
    case 'tracks':
      return playlist.trackCount
    case 'linkedTracks':
      return playlist.linkedTrackCount
    case 'albums':
      return playlist.albumCount
    case 'duration':
      return playlist.durationSec
    case 'imported':
      return playlist.importedAt ? Date.parse(playlist.importedAt) : null
    case 'schedule':
      return playlist.sync.syncable
        ? youtubeScheduleLabels[playlist.sync.schedule]
        : null
    case 'checked':
      return playlist.sync.lastCheckedAt
        ? Date.parse(playlist.sync.lastCheckedAt)
        : null
    case 'added':
      return playlist.createdAt ? Date.parse(playlist.createdAt) : null
    case 'description':
      return playlist.description
    case 'nextSync':
      return playlist.sync.nextScheduledAt
        ? Date.parse(playlist.sync.nextScheduledAt)
        : null
    default:
      return null
  }
}

export default function PlaylistsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [sortBy, setSortBy] = useState<PlaylistSortKey>('name')
  const [direction, setDirection] = useState<Direction>('asc')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState('')
  const drawer = usePlaylistDrawer()
  const columns = useTableColumns('playlists', playlistColumns)
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
  function sort(key: PlaylistSortKey) {
    if (sortBy === key) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setDirection('asc')
    }
  }
  const sorting = { sortBy, direction, onSort: sort }
  const playlists = sortTableRows(
    query.data ?? [],
    { key: sortBy, direction },
    playlistSortValue,
  )
  const confirming = playlists.find((playlist) => playlist.id === confirmingId)
  return (
    <section className="admin-page table-workspace">
      <div className="tags-toolbar">
        <h1>Playlists</h1>
        <span className="quiet text-xs" aria-live="polite">
          {query.data ? `${query.data.length.toLocaleString()} playlists` : ''}
        </span>
        {columns.controls}
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
      <SecondaryTableScroll
        className="tags-scroll"
        role="region"
        aria-label="Playlists"
        aria-busy={query.isFetching}
      >
        <table className="compact-table" aria-label="Playlists">
          <TableHeader>
            <TableRow>
              {playlistColumns
                .filter((column) => columns.visible(column.key))
                .map((column) =>
                  !column.sortable ? (
                    <TableHead key={column.key}>
                      <span className="sr-only">{column.label}</span>
                    </TableHead>
                  ) : (
                    <SecondaryTableHead
                      key={column.key}
                      sortKey={column.key}
                      label={column.label}
                      className={
                        [
                          'tracks',
                          'linkedTracks',
                          'albums',
                          'duration',
                        ].includes(column.key)
                          ? 'numeric'
                          : undefined
                      }
                      {...sorting}
                    />
                  ),
                )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!playlists.length && (
              <TableState colSpan={columns.count} error={query.isError}>
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
                className="cursor-pointer"
                data-selected={
                  playlist.id === confirmingId ||
                  playlist.id === drawer.playlistId ||
                  undefined
                }
                onClick={(event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest('a, button, input, select, textarea')
                  )
                    return
                  drawer.open(
                    playlist.id,
                    event.currentTarget.querySelector<HTMLElement>(
                      '.table-title',
                    ) ?? undefined,
                  )
                }}
              >
                {columns.visible('artwork') && (
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
                )}
                {columns.visible('name') && (
                  <TableCell>
                    <button
                      type="button"
                      className="table-title hover:underline"
                      onClick={(event) =>
                        drawer.open(playlist.id, event.currentTarget)
                      }
                    >
                      {playlist.name}
                    </button>
                  </TableCell>
                )}
                {columns.visible('source') && (
                  <TableCell>{playlistSourceLabel(playlist.source)}</TableCell>
                )}
                {columns.visible('owner') && (
                  <TableCell>{playlist.ownerName ?? '-'}</TableCell>
                )}
                {columns.visible('tracks') && (
                  <TableCell className="numeric">
                    <Link href={playlistTracksHref(playlist.name)}>
                      {playlist.trackCount.toLocaleString()}
                    </Link>
                  </TableCell>
                )}
                {columns.visible('linkedTracks') && (
                  <TableCell className="whitespace-nowrap">
                    {playlist.trackCount > 0
                      ? `${playlist.linkedTrackCount.toLocaleString()} of ${playlist.trackCount.toLocaleString()}`
                      : '-'}
                  </TableCell>
                )}
                {columns.visible('albums') && (
                  <TableCell className="numeric">
                    <Link href={playlistAlbumsHref(playlist.name)}>
                      {playlist.albumCount.toLocaleString()}
                    </Link>
                  </TableCell>
                )}
                {columns.visible('duration') && (
                  <TableCell className="numeric whitespace-nowrap">
                    {formatPlaylistDuration(playlist.durationSec)}
                  </TableCell>
                )}
                {columns.visible('imported') && (
                  <TableCell className="whitespace-nowrap">
                    {playlist.importedAt ? (
                      <time dateTime={playlist.importedAt}>
                        {new Date(playlist.importedAt).toLocaleDateString()}
                      </time>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                )}
                {columns.visible('schedule') && (
                  <TableCell className="whitespace-nowrap">
                    {playlist.sync.syncable
                      ? youtubeScheduleLabels[playlist.sync.schedule]
                      : '-'}
                  </TableCell>
                )}
                {columns.visible('checked') && (
                  <TableCell className="whitespace-nowrap">
                    {playlist.sync.lastCheckedAt ? (
                      <time dateTime={playlist.sync.lastCheckedAt}>
                        {formatShortDateTime(playlist.sync.lastCheckedAt)}
                      </time>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                )}
                {columns.visible('added') && (
                  <TableCell className="whitespace-nowrap">
                    <time dateTime={playlist.createdAt ?? undefined}>
                      {playlist.createdAt
                        ? formatShortDateTime(playlist.createdAt)
                        : '-'}
                    </time>
                  </TableCell>
                )}
                {columns.visible('description') && (
                  <TableCell>{playlist.description ?? '-'}</TableCell>
                )}
                {columns.visible('nextSync') && (
                  <TableCell className="whitespace-nowrap">
                    {playlist.sync.nextScheduledAt
                      ? formatShortDateTime(playlist.sync.nextScheduledAt)
                      : '-'}
                  </TableCell>
                )}
                {columns.visible('actions') && (
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
                )}
              </TableRow>
            ))}
          </TableBody>
        </table>
      </SecondaryTableScroll>
      {drawer.playlistId && (
        <PlaylistDrawer
          id={drawer.playlistId}
          tab={drawer.tab}
          topbar={<span>Playlist</span>}
          onClose={drawer.close}
          onTabChange={drawer.setTab}
        />
      )}
    </section>
  )
}
