'use client'

import Link from 'next/link'
import { useDeferredValue, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BrowseCountSchema } from '@repo/schemas/browse'
import {
  PlaylistBrowsePageSchema,
  PlaylistRemovalSchema,
  PlaylistSourceSchema,
  type PlaylistBrowseSort,
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
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { useCountedVirtualTable } from '@/hooks/useVirtualTable'
import MediaArtwork from './media-artwork'
import { errorMessage } from './lastfm-sync'
import { DetailLink } from './detail-link'
import { useDetailInspector } from './detail-inspector-context'
import { PlaylistPlayButton } from './playlist-detail'
import ServiceIconLinks from './service-icon-links'
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

type PlaylistColumn = TableColumn &
  (
    | { key: PlaylistBrowseSort; sortable: true }
    | { key: 'artwork' | 'actions'; sortable: false }
  )

const playlistColumns: readonly PlaylistColumn[] = [
  { key: 'artwork', sortable: false, label: 'Artwork' },
  { key: 'name', sortable: true, label: 'Playlist', required: true },
  { key: 'source', sortable: true, label: 'Source', defaultVisible: false },
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

export default function PlaylistsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [sortBy, setSortBy] = useState<PlaylistBrowseSort>('name')
  const [direction, setDirection] = useState<Direction>('asc')
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const [sources, setSources] = useState<Array<PlaylistSource | 'library'>>([])
  const view = useLibraryView()
  const importHref = scopedHref(
    '/imports/spotify-playlists',
    view === 'album' ? 'album' : 'track',
  )
  const [confirming, setConfirming] = useState<PlaylistSummary | null>(null)
  const [outcome, setOutcome] = useState('')
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === 'playlist' ? inspector.root.id : null
  const columns = useTableColumns('playlists', playlistColumns)
  const filters = {
    q,
    ...(sources.length ? { sources: JSON.stringify(sources) } : {}),
  }
  const {
    window: query,
    isCounting,
    countError,
    retryCount,
  } = useCountedVirtualTable({
    queryKey: ['playlists', 'browse', q, sources, sortBy, direction],
    countKey: ['playlists', 'browse-count', q, sources],
    loadCount: (signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-count?${new URLSearchParams(filters)}`,
        BrowseCountSchema,
        { signal },
      ),
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-page?${new URLSearchParams({ ...filters, sortBy, direction, page: String(page), size: String(size) })}`,
        PlaylistBrowsePageSchema,
        { signal },
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
      setConfirming(null)
      setOutcome(
        `Removed ${playlist.name} and ${result.removedTracks.toLocaleString()} ${result.removedTracks === 1 ? 'track' : 'tracks'}.`,
      )
      await invalidatePlaylists(client)
    },
  })
  function sort(key: PlaylistBrowseSort) {
    setConfirming(null)
    if (sortBy === key) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setDirection('asc')
    }
  }
  const sorting = { sortBy, direction, onSort: sort }
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
            maxLength={200}
            onChange={(event) => {
              setSearch(event.target.value)
              setConfirming(null)
            }}
          />
        }
        count={
          countError ? (
            <button type="button" className="underline" onClick={retryCount}>
              Retry count
            </button>
          ) : !isCounting ? (
            `${query.total.toLocaleString()} ${query.total === 1 ? 'playlist' : 'playlists'}`
          ) : query.isPending ? (
            'Loading playlists...'
          ) : (
            'Counting playlists...'
          )
        }
        columns={columns.controls}
      />
      {query.isError && (
        <p className="quiet" role="alert">
          Could not load playlists.{' '}
          <button type="button" className="underline" onClick={query.retry}>
            Retry
          </button>
        </p>
      )}
      <SecondaryTableFrame>
        <SecondaryTableScroll
          ref={query.scroller}
          onScroll={query.onScroll}
          className="tags-scroll"
          role="region"
          aria-label="Playlists"
          aria-busy={query.isFetching}
        >
          <table
            className="compact-table"
            aria-label="Playlists"
            aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
          >
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
                              onChange={(next) => {
                                setSources([...next].sort())
                                setConfirming(null)
                              }}
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
              {query.hasTotal && query.total === 0 && (
                <TableState colSpan={columns.count}>
                  {q || sources.length ? (
                    'No matching playlists.'
                  ) : (
                    <>
                      No playlists.{' '}
                      <Link href={importHref}>Import playlists</Link>
                    </>
                  )}
                </TableState>
              )}
              <SecondaryVirtualRows
                window={query}
                colSpan={columns.count}
                renderRow={(playlist, index) => (
                  <TableRow
                    key={playlist.id}
                    className="cursor-pointer"
                    aria-rowindex={index + 2}
                    style={{ height: query.rowHeight }}
                    data-selected={
                      playlist.id === confirming?.id ||
                      playlist.id === selectedId ||
                      undefined
                    }
                    onClick={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest(
                          'a, button, input, select, textarea',
                        )
                      )
                        return
                      inspector?.open(
                        { kind: 'playlist', id: playlist.id },
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
                        <div className="secondary-cell-actions">
                          <PlaylistPlayButton playlist={playlist} />
                          <SecondaryCell text={playlist.name}>
                            <DetailLink
                              kind="playlist"
                              id={playlist.id}
                              className="table-title hover:underline"
                            >
                              {playlist.name}
                            </DetailLink>
                          </SecondaryCell>
                          {playlist.spotifyUrl && (
                            <ServiceIconLinks
                              links={[
                                {
                                  provider: 'spotify',
                                  label: 'Spotify',
                                  url: playlist.spotifyUrl,
                                },
                              ]}
                            />
                          )}
                        </div>
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
                              setConfirming(playlist)
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
                )}
              />
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
              onClick={() => setConfirming(null)}
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
    </section>
  )
}
