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
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import {
  PageHead,
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatDateTime,
  formatItemCount,
  formatRuntime,
} from '@repo/ui/lib/format'
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
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { ConfirmAction } from './confirm-action'
import { useCountedVirtualTable } from '@/hooks/useVirtualTable'
import { usePageBrowse } from '@/hooks/useBrowseHost'
import {
  libraryScopeFilterCount,
  libraryScopeQuery,
  libraryScopeUpdates,
  readLibraryScope,
  type LibraryScopeState,
} from '@/utils/library-scope'
import BrowseFilterPanel from './browse-filter-panel'
import {
  LibraryScopeSections,
  LibraryScopeToggle,
} from './library-scope-controls'
import { MediaThumb } from './media-artwork'
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

const PLAYLISTS = { one: 'playlist', other: 'playlists' }
const TRACKS = { one: 'track', other: 'tracks' }
const NUMERIC = new Set<string>([
  'tracks',
  'linkedTracks',
  'albums',
  'duration',
])

/** An ISO date, or date and time, with the machine value kept for sorting tools. */
function DateValue({
  value,
  time = false,
}: {
  value: string | null | undefined
  time?: boolean
}) {
  if (!value) return <EmptyValue />
  return (
    <time dateTime={value} title={formatDateTime(value)}>
      {time ? formatDateTime(value) : formatDate(value)}
    </time>
  )
}

type PlaylistColumn = TableColumn &
  (
    | { key: PlaylistBrowseSort; sortable: true }
    | { key: 'actions'; sortable: false }
  )

/** Room for the remove button. */
const ACTIONS_WIDTH = 44

const playlistColumns: readonly PlaylistColumn[] = [
  {
    key: 'name',
    sortable: true,
    label: 'Playlist',
    width: 250,
    fill: true,
    required: true,
  },
  {
    key: 'source',
    sortable: true,
    label: 'Source',
    width: 120,
    defaultVisible: false,
  },
  { key: 'owner', sortable: true, label: 'Owner', width: 140 },
  { key: 'tracks', sortable: true, label: 'Tracks', width: 80 },
  {
    key: 'linkedTracks',
    sortable: true,
    label: 'In album library',
    width: 120,
  },
  { key: 'albums', sortable: true, label: 'Albums', width: 80 },
  { key: 'duration', sortable: true, label: 'Duration', width: 90 },
  { key: 'imported', sortable: true, label: 'Imported', width: 110 },
  { key: 'schedule', sortable: true, label: 'Schedule', width: 100 },
  { key: 'checked', sortable: true, label: 'Last checked', width: 140 },
  { key: 'added', sortable: true, label: 'Added to library', width: 140 },
  {
    key: 'description',
    sortable: true,
    label: 'Description',
    width: 240,
    defaultVisible: false,
  },
  {
    key: 'nextSync',
    sortable: true,
    label: 'Next import',
    width: 150,
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
  const host = usePageBrowse('playlists')
  const scope = readLibraryScope(host.params)
  const scopeQuery = libraryScopeQuery(scope)
  const scopeKey = Object.keys(scopeQuery).length ? [scopeQuery] : []
  const onScope = (next: LibraryScopeState) =>
    host.update((params) => {
      Object.entries(libraryScopeUpdates(next)).forEach(([key, value]) => {
        if (value) params.set(key, value)
        else params.delete(key)
      })
    })
  const view = useLibraryView()
  const importHref = scopedHref(
    '/imports/spotify-playlists',
    view === 'album' ? 'album' : 'track',
  )
  const [outcome, setOutcome] = useState('')
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === 'playlist' ? inspector.root.id : null
  const columns = useTableColumns('playlists', playlistColumns)
  const filters = {
    q,
    ...(sources.length ? { sources: JSON.stringify(sources) } : {}),
    ...scopeQuery,
  }
  const {
    window: query,
    isCounting,
    countError,
    retryCount,
  } = useCountedVirtualTable({
    performanceScreen: 'playlists',
    queryKey: [
      'playlists',
      'browse',
      q,
      sources,
      sortBy,
      direction,
      ...scopeKey,
    ],
    countKey: ['playlists', 'browse-count', q, sources, ...scopeKey],
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
      setOutcome(
        `Removed ${playlist.name} and ${formatItemCount(result.removedTracks, TRACKS)}.`,
      )
      await invalidatePlaylists(client)
    },
  })
  function sort(key: PlaylistBrowseSort) {
    if (sortBy === key) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setDirection('asc')
    }
  }
  const sorting = { sortBy, direction, onSort: sort }
  const shown = playlistColumns.filter((column) => columns.visible(column.key))
  const layout = columns.layout(
    shown.map((column) => (column.sortable ? column.key : ACTIONS_WIDTH)),
  )
  return (
    <section className="sec-page">
      <PageHead
        title="Playlists"
        actions={
          <Button asChild>
            <Link href={importHref}>Import playlists</Link>
          </Button>
        }
      />
      <div className="sec-notices">
        {query.isError && (
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={query.retry}>
                Retry
              </Button>
            }
          >
            Could not load playlists.
          </Notice>
        )}
        {remove.isError && (
          <Notice tone="danger">
            {errorMessage(remove.error, 'Could not remove the playlist.')}
          </Notice>
        )}
        {outcome && <Notice>{outcome}</Notice>}
      </div>
      <Toolbar>
        <SecondaryTableSearch
          label="Search playlists"
          value={search}
          maxLength={200}
          onChange={setSearch}
        />
        <ToolbarCount>
          {countError ? (
            <Button size="xs" onClick={retryCount}>
              Retry count
            </Button>
          ) : !isCounting ? (
            formatItemCount(query.total, PLAYLISTS)
          ) : query.isPending ? (
            <Skeleton width={80} height={12} />
          ) : (
            'Counting playlists...'
          )}
        </ToolbarCount>
        <ToolbarEnd>
          <LibraryScopeToggle value={scope} onChange={onScope} />
          <BrowseFilterPanel short count={libraryScopeFilterCount(scope)}>
            <LibraryScopeSections value={scope} onChange={onScope} />
          </BrowseFilterPanel>
          {columns.controls}
        </ToolbarEnd>
      </Toolbar>
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        role="region"
        aria-label="Playlists"
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          aria-label="Playlists"
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {shown.map((column) =>
                !column.sortable ? (
                  <TableHead key={column.key}>
                    <span className="sr-only">{column.label}</span>
                  </TableHead>
                ) : (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    align={NUMERIC.has(column.key) ? 'end' : undefined}
                    sticky={column.key === 'name' ? 0 : undefined}
                    stickyEdge={column.key === 'name'}
                    resizer={columns.resizer(column.key)}
                    filter={
                      column.key === 'source' ? (
                        <SecondaryColumnFilter
                          label="Source"
                          options={[
                            { value: 'library', label: 'Library' },
                            ...PlaylistSourceSchema.options.map((value) => ({
                              value,
                              label: playlistSourceLabel(value),
                            })),
                          ]}
                          value={sources}
                          onChange={(next) => setSources([...next].sort())}
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
                  'No playlists match.'
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
                  aria-rowindex={index + 2}
                  style={{ height: query.rowHeight }}
                  selected={playlist.id === selectedId}
                >
                  {columns.visible('name') && (
                    <TableCell sticky={0} stickyEdge>
                      <span className="ds-cell-id">
                        <MediaThumb kind="playlist" src={playlist.artworkUrl} />
                        <SecondaryCell text={playlist.name}>
                          <DetailLink
                            kind="playlist"
                            id={playlist.id}
                            className="ds-cell-title"
                          >
                            {playlist.name}
                          </DetailLink>
                        </SecondaryCell>
                        {playlist.inLibrary === false && (
                          <span className="ds-muted">Outside library</span>
                        )}
                        <PlaylistPlayButton playlist={playlist} />
                      </span>
                    </TableCell>
                  )}
                  {columns.visible('source') && (
                    <TableCell>
                      <span className="ds-cell-id">
                        {playlist.source === null && playlist.spotifyUrl
                          ? 'Spotify'
                          : playlistSourceLabel(playlist.source)}
                        {playlist.spotifyUrl && (
                          <ServiceIconLinks
                            links={[
                              {
                                provider: 'spotify',
                                label: 'Spotify',
                                url: playlist.spotifyUrl,
                              },
                            ]}
                            itemTitle={playlist.name}
                          />
                        )}
                      </span>
                    </TableCell>
                  )}
                  {columns.visible('owner') && (
                    <TableCell>
                      <SecondaryCell text={playlist.ownerName ?? undefined}>
                        {playlist.ownerName ?? EMPTY_VALUE}
                      </SecondaryCell>
                    </TableCell>
                  )}
                  {columns.visible('tracks') && (
                    <TableCell align="end">
                      <Link href={playlistTracksHref(playlist.name)}>
                        {formatCount(playlist.trackCount)}
                      </Link>
                    </TableCell>
                  )}
                  {columns.visible('linkedTracks') && (
                    <TableCell align="end">
                      {playlist.trackCount > 0
                        ? `${formatCount(playlist.linkedTrackCount)} of ${formatCount(playlist.trackCount)}`
                        : EMPTY_VALUE}
                    </TableCell>
                  )}
                  {columns.visible('albums') && (
                    <TableCell align="end">
                      <Link href={playlistAlbumsHref(playlist.name)}>
                        {formatCount(playlist.albumCount)}
                      </Link>
                    </TableCell>
                  )}
                  {columns.visible('duration') && (
                    <TableCell align="end">
                      {formatRuntime(playlist.durationSec / 60)}
                    </TableCell>
                  )}
                  {columns.visible('imported') && (
                    <TableCell>
                      <DateValue value={playlist.importedAt} />
                    </TableCell>
                  )}
                  {columns.visible('schedule') && (
                    <TableCell>
                      {playlist.sync.syncable
                        ? youtubeScheduleLabels[playlist.sync.schedule]
                        : EMPTY_VALUE}
                    </TableCell>
                  )}
                  {columns.visible('checked') && (
                    <TableCell>
                      <DateValue value={playlist.sync.lastCheckedAt} time />
                    </TableCell>
                  )}
                  {columns.visible('added') && (
                    <TableCell>
                      <DateValue value={playlist.createdAt} time />
                    </TableCell>
                  )}
                  {columns.visible('description') && (
                    <TableCell>
                      <SecondaryCell
                        text={playlist.description ?? undefined}
                        details={playlist.description || undefined}
                        label={`Description of ${playlist.name}`}
                      >
                        {playlist.description ?? EMPTY_VALUE}
                      </SecondaryCell>
                    </TableCell>
                  )}
                  {columns.visible('nextSync') && (
                    <TableCell>
                      <DateValue value={playlist.sync.nextScheduledAt} time />
                    </TableCell>
                  )}
                  {columns.visible('actions') && (
                    <TableCell align="end">
                      {playlist.source && (
                        <ConfirmAction
                          variant="ghost"
                          size="xs"
                          icon
                          confirmVariant="danger"
                          ariaLabel={`Remove ${playlist.name}`}
                          title={`Remove ${playlist.name}`}
                          question={`Remove ${playlist.name}?`}
                          details="Its tracks that are in no other playlist are removed too. Albums stay in the library."
                          confirmLabel={
                            remove.isPending ? 'Removing...' : 'Remove'
                          }
                          disabled={remove.isPending}
                          onConfirm={() => remove.mutate(playlist)}
                        >
                          <Trash2 className="ds-i" aria-hidden="true" />
                        </ConfirmAction>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
