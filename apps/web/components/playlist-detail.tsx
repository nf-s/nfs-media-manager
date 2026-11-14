'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { X } from 'lucide-react'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  PlaylistDetailSchema,
  PlaylistSummarySchema,
  PlaylistSyncScheduleSchema,
  type PlaylistDetail,
  type PlaylistEntry,
  type PlaylistEntrySort,
  type PlaylistSummary,
  type PlaylistSyncSchedule,
  type SpotifyPlaylistImportInput,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import {
  PlaylistTabSchema,
  playlistTracksHref,
  trackHref,
  type PlaylistTab,
} from '@/utils/playlist-links'
import {
  PLAYLIST_SYNC_POLL_MS,
  formatPlaylistDuration,
  invalidatePlaylists,
  playlistImportRequest,
  playlistJobActive,
  playlistJobLabels,
  playlistJobProgress,
  playlistNextSync,
  playlistSourceLabel,
} from '@/utils/playlist-sync'
import { albumHref, formatTrackDuration } from '@/utils/track-browse'
import { youtubeScheduleLabels } from '@/utils/youtube'
import { errorMessage } from './lastfm-sync'
import MediaArtwork from './media-artwork'
import {
  LibraryTrackPlayButton,
  LibraryTrackQueueButton,
} from './play-controls'
import { useConfig } from './providers'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  useTableColumns,
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'

const ENTRY_PAGE_SIZE = 100

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

function playlistPath(
  id: string,
  page: number,
  size: number,
  sortBy: PlaylistEntrySort = 'position',
  direction: 'asc' | 'desc' = 'asc',
) {
  return `/api/v1/playlists/${encodeURIComponent(id)}?${new URLSearchParams({
    page: String(page),
    size: String(size),
    sortBy,
    direction,
  })}`
}

/** The playlist with its sync state, re-read while its import is queued or running. */
export function usePlaylistSummary(id: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['playlist', id],
    staleTime: 0,
    refetchInterval: (query) =>
      playlistJobActive(query.state.data?.sync.job)
        ? PLAYLIST_SYNC_POLL_MS
        : false,
    queryFn: () =>
      fetchApiData(apiBaseUrl, playlistPath(id, 1, 1), PlaylistDetailSchema),
  })
}

function entryKey(entry: PlaylistEntry) {
  return entry.kind === 'track'
    ? `track:${entry.position}:${entry.track.id}`
    : `album:${entry.position}:${entry.album.id}`
}

const entryColumns: Array<{
  key: PlaylistEntrySort
  label: string
  defaultVisible?: boolean
  required?: boolean
}> = [
  { key: 'position', label: 'Position' },
  { key: 'title', label: 'Title', required: true },
  { key: 'artists', label: 'Artists' },
  { key: 'album', label: 'Album' },
  { key: 'duration', label: 'Duration' },
  { key: 'added', label: 'Added' },
  { key: 'releaseDate', label: 'Released', defaultVisible: false },
  { key: 'scrobbles', label: 'Scrobbles', defaultVisible: false },
  { key: 'lastListened', label: 'Last listened', defaultVisible: false },
  { key: 'kind', label: 'Type', defaultVisible: false },
]

export function PlaylistEntries({
  id,
  onOpenTrack,
}: {
  id: string
  /** Opens a track in the surrounding browser; without it titles link to the track page. */
  onOpenTrack?: (trackId: string, trigger: HTMLElement) => void
}) {
  const { apiBaseUrl } = useConfig()
  const [sortBy, setSortBy] = useState<PlaylistEntrySort>('position')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const columns = useTableColumns('playlist-entries', entryColumns)
  function onSort(key: PlaylistEntrySort) {
    if (key === sortBy) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setDirection('asc')
    }
  }
  const sorting = { sortBy, direction, onSort }
  const entries = useInfiniteQuery({
    queryKey: ['playlist', id, 'entries', sortBy, direction],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        playlistPath(id, pageParam, ENTRY_PAGE_SIZE, sortBy, direction),
        PlaylistDetailSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.items.page < last.items.pageCount ? last.items.page + 1 : undefined,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: entries.hasNextPage && !entries.isFetching && !entries.isError,
    fetchNextPage: entries.fetchNextPage,
    resetKey: `${id}:${sortBy}:${direction}`,
  })
  // A sync between page requests can move entries across page boundaries.
  const byKey = new Map<string, PlaylistEntry>()
  for (const page of entries.data?.pages ?? [])
    for (const entry of page.items.items) {
      const key = entryKey(entry)
      if (!byKey.has(key)) byKey.set(key, entry)
    }
  const items = [...byKey.entries()]
  const total = entries.data?.pages[0]?.items.totalCount ?? 0
  return (
    <>
      <div className="flex justify-end">{columns.controls}</div>
      <SecondaryTableScroll
        ref={scroller}
        className="min-h-0 flex-1"
        role="region"
        aria-label="Playlist tracks"
        aria-busy={entries.isFetching}
      >
        <table className="compact-table" aria-label="Playlist tracks">
          <TableHeader>
            <TableRow>
              {entryColumns
                .filter((column) => columns.visible(column.key))
                .map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    className={
                      ['position', 'duration', 'scrobbles'].includes(column.key)
                        ? 'numeric'
                        : undefined
                    }
                    {...sorting}
                  />
                ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!items.length && (
              <TableState colSpan={columns.count} error={entries.isError}>
                {entries.isPending ? (
                  'Loading tracks...'
                ) : entries.isError ? (
                  <>
                    {errorMessage(entries.error, 'Could not load tracks.')}{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => entries.refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : (
                  'No tracks.'
                )}
              </TableState>
            )}
            {items.map(([key, entry]) =>
              entry.kind === 'track' ? (
                <TableRow key={key} className="group">
                  {columns.visible('position') && (
                    <TableCell className="numeric">
                      <LibraryTrackPlayButton
                        track={entry.track}
                        position={entry.position}
                      />
                    </TableCell>
                  )}
                  {columns.visible('title') && (
                    <TableCell>
                      {onOpenTrack ? (
                        <button
                          type="button"
                          className="table-title"
                          onClick={(event) =>
                            onOpenTrack(entry.track.id, event.currentTarget)
                          }
                        >
                          {entry.track.title}
                        </button>
                      ) : (
                        <Link
                          className="table-title"
                          href={trackHref(entry.track.id)}
                        >
                          {entry.track.title}
                        </Link>
                      )}
                      <LibraryTrackQueueButton track={entry.track} />
                    </TableCell>
                  )}
                  {columns.visible('artists') && (
                    <TableCell>
                      {entry.track.artists.join(', ') || '-'}
                    </TableCell>
                  )}
                  {columns.visible('album') && (
                    <TableCell>
                      {entry.track.album ? (
                        <Link href={albumHref(entry.track.album.id)}>
                          {entry.track.albumName ?? entry.track.album.title}
                        </Link>
                      ) : (
                        (entry.track.albumName ?? '-')
                      )}
                    </TableCell>
                  )}
                  {columns.visible('duration') && (
                    <TableCell className="numeric">
                      {formatTrackDuration(entry.track.durationSec)}
                    </TableCell>
                  )}
                  {columns.visible('added') && (
                    <TableCell className="whitespace-nowrap">
                      <AddedDate value={entry.addedAt} />
                    </TableCell>
                  )}
                  {columns.visible('releaseDate') && (
                    <TableCell className="whitespace-nowrap">
                      <AddedDate value={entry.track.releaseDate} />
                    </TableCell>
                  )}
                  {columns.visible('scrobbles') && (
                    <TableCell className="numeric">
                      {entry.track.scrobbles.toLocaleString()}
                    </TableCell>
                  )}
                  {columns.visible('lastListened') && (
                    <TableCell className="whitespace-nowrap">
                      <AddedDate value={entry.track.lastListenedAt} />
                    </TableCell>
                  )}
                  {columns.visible('kind') && <TableCell>Track</TableCell>}
                </TableRow>
              ) : (
                <TableRow key={key}>
                  {columns.visible('position') && (
                    <TableCell className="numeric">{entry.position}</TableCell>
                  )}
                  {columns.visible('title') && (
                    <TableCell>
                      <Link
                        className="table-title"
                        href={albumHref(entry.album.id)}
                      >
                        {entry.album.title}
                      </Link>{' '}
                      <span className="quiet">Album</span>
                    </TableCell>
                  )}
                  {columns.visible('artists') && (
                    <TableCell>
                      {entry.album.artists.join(', ') || '-'}
                    </TableCell>
                  )}
                  {columns.visible('album') && <TableCell>-</TableCell>}
                  {columns.visible('duration') && (
                    <TableCell className="numeric">-</TableCell>
                  )}
                  {columns.visible('added') && (
                    <TableCell className="whitespace-nowrap">
                      <AddedDate value={entry.addedAt} />
                    </TableCell>
                  )}
                  {columns.visible('releaseDate') && (
                    <TableCell className="whitespace-nowrap">
                      <AddedDate value={entry.album.releaseDate} />
                    </TableCell>
                  )}
                  {columns.visible('scrobbles') && (
                    <TableCell className="numeric">-</TableCell>
                  )}
                  {columns.visible('lastListened') && (
                    <TableCell className="whitespace-nowrap">-</TableCell>
                  )}
                  {columns.visible('kind') && <TableCell>Album</TableCell>}
                </TableRow>
              ),
            )}
          </TableBody>
        </table>
        <div ref={sentinel} className="py-2 text-center">
          {entries.isFetchingNextPage && (
            <p role="status" className="muted">
              Loading more tracks...
            </p>
          )}
          {entries.isFetchNextPageError && (
            <p role="alert">Could not load more tracks.</p>
          )}
          {entries.hasNextPage && !entries.isFetchingNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={entries.isFetching}
              onClick={() => entries.fetchNextPage({ cancelRefetch: false })}
            >
              {entries.isFetchNextPageError
                ? 'Retry loading tracks'
                : 'Load more tracks'}
            </Button>
          )}
          {!entries.hasNextPage && items.length > 0 && (
            <p className="muted">
              {items.length.toLocaleString()} of {total.toLocaleString()}{' '}
              loaded.
            </p>
          )}
        </div>
      </SecondaryTableScroll>
    </>
  )
}

function AddedDate({ value }: { value: string | null }) {
  if (!value) return <>-</>
  return <time dateTime={value}>{new Date(value).toLocaleDateString()}</time>
}

export function PlaylistSyncPanel({ playlist }: { playlist: PlaylistSummary }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const { sync } = playlist
  const request = playlistImportRequest(playlist)
  const schedule = useMutation({
    mutationFn: (value: PlaylistSyncSchedule) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/${encodeURIComponent(playlist.id)}/sync-schedule`,
        PlaylistSummarySchema,
        { method: 'PUT', body: JSON.stringify({ schedule: value }) },
      ),
    onSuccess: async (summary) => {
      client.setQueryData<PlaylistDetail>(['playlist', playlist.id], (old) =>
        old ? { ...old, ...summary } : old,
      )
      await client.invalidateQueries({ queryKey: ['playlists'] })
    },
  })
  const queue = useMutation({
    mutationFn: (input: SpotifyPlaylistImportInput) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists/import',
        EnrichmentResultSchema,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['playlist', playlist.id],
          exact: true,
        }),
        client.invalidateQueries({ queryKey: ['playlists'] }),
        client.invalidateQueries({ queryKey: ['spotify-playlist-imports'] }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  if (!sync.syncable)
    return <p className="quiet">This playlist is not synced from Spotify.</p>
  const { job } = sync
  const active = playlistJobActive(job)
  const progress = job ? playlistJobProgress(job.progress) : null
  const refused = queue.data?.queued === 0
  return (
    <section className="film-import-workflow" aria-label="Sync">
      <div className="form-actions">
        <label className="flex items-center gap-2">
          Schedule
          <select
            value={sync.schedule}
            disabled={schedule.isPending}
            onChange={(event) => {
              const parsed = PlaylistSyncScheduleSchema.safeParse(
                event.target.value,
              )
              if (parsed.success) schedule.mutate(parsed.data)
            }}
          >
            {PlaylistSyncScheduleSchema.options.map((value) => (
              <option key={value} value={value}>
                {youtubeScheduleLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={!request || active || queue.isPending}
          onClick={() => request && queue.mutate(request)}
        >
          {queue.isPending ? 'Queueing...' : 'Sync now'}
        </Button>
      </div>
      {schedule.isError && (
        <p role="alert">
          {errorMessage(schedule.error, 'Could not save the schedule.')}
        </p>
      )}
      {queue.isError && (
        <p role="alert">
          {errorMessage(queue.error, 'Could not queue the import.')}
        </p>
      )}
      {refused && (
        <p role="alert">
          {queue.data?.warnings.join(' ') || 'The import was not queued.'}
        </p>
      )}
      <dl className="detail-metrics">
        <div>
          <dt>Last checked</dt>
          <dd>{formatDateTime(sync.lastCheckedAt)}</dd>
        </div>
        <div>
          <dt>Contents stored</dt>
          <dd>{formatDateTime(playlist.importedAt)}</dd>
        </div>
        <div>
          <dt>Next sync</dt>
          <dd>{playlistNextSync(sync)}</dd>
        </div>
      </dl>
      <h2 className="text-xs font-semibold">Latest import</h2>
      {job ? (
        <>
          <div className="form-actions">
            <span className="job-status" data-status={job.status}>
              {playlistJobLabels[job.status]}
            </span>
            {progress && <span>{progress}</span>}
            {job.finishedAt && (
              <span>Finished {formatDateTime(job.finishedAt)}</span>
            )}
            <Link
              className="underline underline-offset-2"
              href={scopedHref(
                `/jobs?jobId=${encodeURIComponent(job.jobId)}`,
                'album',
              )}
            >
              View job
            </Link>
          </div>
          {active && (
            <progress
              className="w-full"
              value={
                job.progress?.totalPages ? job.progress.pagesRead : undefined
              }
              max={job.progress?.totalPages || undefined}
              aria-label="Import progress"
            />
          )}
          {job.status === 'failed' && job.errorMessage && (
            <p role="alert">{job.errorMessage}</p>
          )}
        </>
      ) : (
        <p className="muted">No import job.</p>
      )}
    </section>
  )
}

export default function PlaylistDetailView({
  id,
  tab,
  onTabChange,
  onOpenTrack,
  filterTracks,
}: {
  id: string
  tab: PlaylistTab
  onTabChange: (tab: PlaylistTab) => void
  onOpenTrack?: (trackId: string, trigger: HTMLElement) => void
  /** Filters the surrounding Tracks browser; without it the button links to Tracks. */
  filterTracks?: (playlist: PlaylistSummary) => void
}) {
  const client = useQueryClient()
  const summary = usePlaylistSummary(id)
  const active = playlistJobActive(summary.data?.sync.job)
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) void invalidatePlaylists(client)
    wasActive.current = active
  }, [active, client])

  if (summary.isPending) return <p className="browse-empty">Loading...</p>
  if (!summary.data)
    return (
      <p role="alert">
        {errorMessage(summary.error, 'Could not load this playlist.')}{' '}
        <Button onClick={() => summary.refetch()}>Retry</Button>
      </p>
    )
  const playlist = summary.data
  const facts = [
    playlistSourceLabel(playlist.source),
    playlist.ownerName,
    `${playlist.trackCount.toLocaleString()} ${playlist.trackCount === 1 ? 'track' : 'tracks'}`,
    formatPlaylistDuration(playlist.durationSec),
  ].filter((fact): fact is string => Boolean(fact))
  return (
    <>
      <header className="flex shrink-0 items-start gap-3">
        {playlist.artworkUrl && (
          <MediaArtwork
            src={playlist.artworkUrl}
            alt=""
            fallbackLabel=""
            containerClassName="size-16 shrink-0 rounded"
            imageClassName="size-16 object-cover"
            fallbackClassName="size-16"
          />
        )}
        <div className="grid min-w-0 gap-1.5">
          <h1 className="text-lg font-semibold leading-tight">
            {playlist.name}
          </h1>
          <div className="detail-facts">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
          <div className="form-actions">
            {filterTracks ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => filterTracks(playlist)}
              >
                Filter tracks
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href={playlistTracksHref(playlist.name)}>
                  Filter tracks
                </Link>
              </Button>
            )}
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
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const parsed = PlaylistTabSchema.safeParse(value)
          if (parsed.success) onTabChange(parsed.data)
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="self-start">
          <TabsTrigger value="tracks">Tracks</TabsTrigger>
          <TabsTrigger value="sync">Sync</TabsTrigger>
        </TabsList>
        <TabsContent
          value="tracks"
          className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <PlaylistEntries id={id} onOpenTrack={onOpenTrack} />
        </TabsContent>
        <TabsContent value="sync" className="mt-3 min-h-0 flex-1 overflow-auto">
          <PlaylistSyncPanel playlist={playlist} />
        </TabsContent>
      </Tabs>
    </>
  )
}

/** The playlist drawer: the track drawer's shell with the playlist inside. */
export function PlaylistDrawer({
  id,
  tab,
  topbar,
  onClose,
  onTabChange,
  onOpenTrack,
  filterTracks,
}: {
  id: string
  tab: PlaylistTab
  /** The left side of the top bar, such as a link to the Playlists page. */
  topbar: ReactNode
  onClose: () => void
  onTabChange: (tab: PlaylistTab) => void
  onOpenTrack?: (trackId: string, trigger: HTMLElement) => void
  filterTracks?: (playlist: PlaylistSummary) => void
}) {
  const inspector = useRef<HTMLElement>(null)
  useEffect(() => {
    // The drawer covers the page, so it takes focus.
    inspector.current?.focus({ preventScroll: true })
  }, [id])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })
  return (
    <>
      <div className="inspector-backdrop" onClick={onClose} />
      <aside
        ref={inspector}
        tabIndex={-1}
        aria-label="Playlist details"
        className="media-inspector"
      >
        <div className="detail-topbar">
          {topbar}
          <button type="button" aria-label="Close details" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3.5 pb-3.5 pt-3">
          <PlaylistDetailView
            key={id}
            id={id}
            tab={tab}
            onTabChange={onTabChange}
            onOpenTrack={onOpenTrack}
            filterTracks={filterTracks}
          />
        </div>
      </aside>
    </>
  )
}
