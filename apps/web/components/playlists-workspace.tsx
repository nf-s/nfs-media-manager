'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  PlaylistRemovalSchema,
  PlaylistSummarySchema,
  PlaylistSourceSchema,
  type PlaylistSource,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
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
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableFrame,
  SecondaryTableFooter,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { sortTableRows } from '@/utils/secondary-table'
import MediaArtwork from './media-artwork'
import { errorMessage } from './lastfm-sync'
import { PlaylistDrawer } from './playlist-detail'
import { usePlaylistDrawer } from '@/hooks/usePlaylistDrawer'
import { fetchApiData } from '@/utils/api'
import { useLibraryView } from './media-scope'
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

export function filterPlaylists(
  rows: readonly PlaylistSummary[],
  search: string,
  sources: readonly (PlaylistSource | 'library')[],
) {
  const text = search.trim().toLocaleLowerCase()
  return rows.filter(
    (row) =>
      (!sources.length || sources.includes(row.source ?? 'library')) &&
      [row.name, row.ownerName, row.description].some((value) =>
        value?.toLocaleLowerCase().includes(text),
      ),
  )
}

export default function PlaylistsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [sortBy, setSortBy] = useState<PlaylistSortKey>('name')
  const [direction, setDirection] = useState<Direction>('asc')
  const [search, setSearch] = useState('')
  const [sources, setSources] = useState<Array<PlaylistSource | 'library'>>([])
  const view = useLibraryView()
  const importHref = scopedHref(
    '/imports/spotify-playlists',
    view === 'album' ? 'album' : 'track',
  )
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
    filterPlaylists(query.data ?? [], search, sources),
    { key: sortBy, direction },
    playlistSortValue,
  )
  const confirming = playlists.find((playlist) => playlist.id === confirmingId)
  return (
    <section className="admin-page table-workspace">
      <h1>Playlists</h1>
      <div className="tags-bulk">
        <Button asChild size="sm" variant="outline">
          <Link href={importHref}>Import playlists</Link>
        </Button>
      </div>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search playlists"
            placeholder="Search playlists"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        count={
          <span aria-live="polite">
            {query.data
              ? search.trim() || sources.length
                ? `${playlists.length.toLocaleString()} of ${query.data.length.toLocaleString()} playlists`
                : `${query.data.length.toLocaleString()} playlists`
              : ''}
          </span>
        }
        columns={columns.controls}
      />
      <SecondaryTableFrame>
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
                        filter={
                          column.key === 'source' ? (
                            <SecondaryColumnFilter
                              label="Source"
                              options={[
                                { value: 'library', label: 'Library' },
                                ...PlaylistSourceSchema.options.map(
                                  (value) => ({
                                    value,
                                    label: playlistSourceLabel(value),
                                  }),
                                ),
                              ]}
                              value={sources}
                              onChange={setSources}
                            />
                          ) : undefined
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
                  ) : search.trim() || sources.length ? (
                    'No matching playlists.'
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
                      <SecondaryCell text={playlist.name}>
                        <button
                          type="button"
                          className="table-title hover:underline"
                          onClick={(event) =>
                            drawer.open(playlist.id, event.currentTarget)
                          }
                        >
                          {playlist.name}
                        </button>
                      </SecondaryCell>
                    </TableCell>
                  )}
                  {columns.visible('source') && (
                    <TableCell>
                      {playlistSourceLabel(playlist.source)}
                    </TableCell>
                  )}
                  {columns.visible('owner') && (
                    <TableCell>
                      <SecondaryCell text={playlist.ownerName ?? undefined}>
                        {playlist.ownerName ?? '-'}
                      </SecondaryCell>
                    </TableCell>
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
                    <TableCell>
                      <SecondaryCell
                        text={playlist.description ?? undefined}
                        details={playlist.description || undefined}
                        label={`Description of ${playlist.name}`}
                      >
                        {playlist.description ?? '-'}
                      </SecondaryCell>
                    </TableCell>
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
                          className="size-6 p-0"
                          disabled={remove.isPending}
                          aria-label={`Remove ${playlist.name}`}
                          title={`Remove ${playlist.name}`}
                          onClick={() => {
                            setConfirmingId(playlist.id)
                            setOutcome('')
                            remove.reset()
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </table>
        </SecondaryTableScroll>
        {confirming && (
          <SecondaryTableFooter>
            <span className="sr-only">Confirm playlist removal</span>
            <span>
              Remove <strong>{confirming.name}</strong> and its tracks that are
              in no other playlist? Albums stay in the library.
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
          </SecondaryTableFooter>
        )}
      </SecondaryTableFrame>
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
