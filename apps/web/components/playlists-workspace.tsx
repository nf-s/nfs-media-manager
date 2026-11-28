'use client'

import { ResultSection } from './result-feedback'

import { ReadButton } from '@/components/read-button'
import { forgetLibraryAddition } from '@/hooks/use-library-addition'
import Link from 'next/link'
import { useDeferredValue, useId, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
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
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
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
import { LibraryPlaylistPlayButton } from './library-playlist-detail'
import { useLibraryPlaylistActions } from './library-playlist-actions'
import { PlaylistNamePopover } from './playlist-name-popover'
import { ResultLineSlot } from './result-line'
import {
  PlaylistCountCell,
  PlaylistRowMenu,
  SavedViewCell,
  SmartPlaylistPlayButton,
  playlistCountHeading,
  playlistRowKind,
  playlistRowMenuItems,
  playlistTypeLabel,
} from './playlist-directory-cells'
import {
  listsImportedPlaylists,
  playableLibrary,
  playlistLibraryForView,
  smartPlaylistHref,
} from '@/utils/library-playlists'
import type { LibraryPlaylistLibrary } from '@repo/schemas/library-playlists'
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
  'count',
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
    | { key: 'savedView' | 'actions'; sortable: false }
  )

/** Room for the row's menu or remove button. */
const ACTIONS_WIDTH = 44

/**
 * PL-50: Playlist, Type, Source, the count in the library's noun, Saved
 * view, Updated and the row's menu by default. Every other column stays
 * available under Columns.
 */
export function playlistColumnsFor(
  library: LibraryPlaylistLibrary,
): readonly PlaylistColumn[] {
  const columns: readonly PlaylistColumn[] = [
    {
      key: 'name',
      sortable: true,
      label: 'Playlist',
      width: 250,
      fill: true,
      required: true,
    },
    { key: 'type', sortable: true, label: 'Type', width: 120 },
    { key: 'source', sortable: true, label: 'Source', width: 120 },
    {
      key: 'count',
      sortable: true,
      label: playlistCountHeading(library),
      width: 80,
    },
    { key: 'savedView', sortable: false, label: 'Saved view', width: 240 },
    { key: 'updated', sortable: true, label: 'Updated', width: 110 },
    {
      key: 'owner',
      sortable: true,
      label: 'Owner',
      width: 140,
      defaultVisible: false,
    },
    {
      key: 'tracks',
      sortable: true,
      label: 'Tracks',
      width: 80,
      defaultVisible: false,
    },
    {
      key: 'linkedTracks',
      sortable: true,
      label: 'In album library',
      width: 120,
      defaultVisible: false,
    },
    {
      key: 'albums',
      sortable: true,
      label: 'Albums',
      width: 80,
      defaultVisible: false,
    },
    {
      key: 'duration',
      sortable: true,
      label: 'Duration',
      width: 90,
      defaultVisible: false,
    },
    {
      key: 'imported',
      sortable: true,
      label: 'Imported',
      width: 110,
      defaultVisible: false,
    },
    {
      key: 'schedule',
      sortable: true,
      label: 'Schedule',
      width: 100,
      defaultVisible: false,
    },
    {
      key: 'checked',
      sortable: true,
      label: 'Last checked',
      width: 140,
      defaultVisible: false,
    },
    {
      key: 'added',
      sortable: true,
      label: 'Added to library',
      width: 140,
      defaultVisible: false,
    },
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
  // The columns hidden by default are imported playlists'; a library without
  // imported playlists has none of them.
  return listsImportedPlaylists(library)
    ? columns
    : columns.filter((column) => column.defaultVisible !== false)
}

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
  // The page lists the playlists of the library it is scoped to.
  const library = playlistLibraryForView(view) ?? 'tracks'
  const playable = playableLibrary(library)
  const imports = listsImportedPlaylists(library)
  const importHref = scopedHref(
    '/imports/spotify-playlists',
    view === 'album' ? 'album' : 'track',
  )
  const playlistColumns = playlistColumnsFor(library)
  const actions = useLibraryPlaylistActions()
  const newPlaylistId = useId()
  const newPlaylistButton = useRef<HTMLButtonElement>(null)
  const renameAnchor = useRef<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState<PlaylistSummary | null>(null)
  const [outcome, setOutcome] = useState<{
    id: string
    message: string
  } | null>(null)
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === 'playlist' ||
    inspector?.root?.kind === 'library-playlist'
      ? inspector.root.id
      : null
  // A new key, so the PL-50 default columns apply to choices saved before.
  const columns = useTableColumns('playlist-directory', playlistColumns)
  const filters = {
    q,
    library,
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
      library,
      q,
      sources,
      sortBy,
      direction,
      ...scopeKey,
    ],
    countKey: ['playlists', 'browse-count', library, q, sources, ...scopeKey],
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
    onMutate: () => setOutcome(null),
    onSuccess: async (result, playlist) => {
      forgetLibraryAddition(client, {
        kind: 'playlist',
        catalogId: playlist.id,
      })
      setOutcome({
        id: playlist.id,
        message: `Removed ${playlist.name} and ${formatItemCount(result.removedTracks, TRACKS)}.`,
      })
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
    shown.map((column) =>
      column.key === 'actions' ? ACTIONS_WIDTH : column.key,
    ),
  )
  return (
    <ResultSection
      className="sec-page"
      identity={JSON.stringify([filters, sortBy, direction])}
      result={query}
    >
      <PageHead
        title="Playlists"
        actions={
          <>
            <Button
              ref={newPlaylistButton}
              type="button"
              popoverTarget={newPlaylistId}
              aria-haspopup="dialog"
              aria-controls={newPlaylistId}
            >
              <Plus className="ds-i" data-size="sm" aria-hidden />
              New playlist
            </Button>
            {imports && (
              <Button asChild>
                <Link href={importHref}>Import playlists</Link>
              </Button>
            )}
          </>
        }
      />
      <PlaylistNamePopover
        id={newPlaylistId}
        mode="create"
        anchor={newPlaylistButton}
        onSubmit={(name) => actions.create(library, name)}
      />
      {renaming && (
        <PlaylistNamePopover
          key={renaming.id}
          mode="rename"
          anchor={renameAnchor}
          initialName={renaming.name}
          showOnMount
          sheet
          onSubmit={(name) => actions.rename({ ...renaming, library }, name)}
          onOpenChange={(open) => {
            if (!open) setRenaming(null)
          }}
        />
      )}
      <div className="sec-notices">
        {query.isError && (
          <Notice
            tone="danger"
            action={
              <ReadButton size="xs" read={query.retry}>
                Retry
              </ReadButton>
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
        {outcome && <Notice>{outcome.message}</Notice>}
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
            <ReadButton size="xs" read={retryCount}>
              Retry count
            </ReadButton>
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
                column.key === 'savedView' ? (
                  <TableHead
                    key={column.key}
                    resizer={columns.resizer(column.key)}
                  >
                    {column.label}
                  </TableHead>
                ) : !column.sortable ? (
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
                      column.key === 'source' && imports ? (
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
                ) : imports ? (
                  <>
                    No playlists.{' '}
                    <Link href={importHref}>Import playlists</Link>
                  </>
                ) : (
                  'No playlists.'
                )}
              </TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={columns.count}
              renderRow={(playlist, index) => {
                const kind = playlistRowKind(playlist)
                return (
                  <TableRow
                    key={playlist.id}
                    aria-rowindex={index + 2}
                    style={{ height: query.rowHeight }}
                    selected={playlist.id === selectedId}
                  >
                    {columns.visible('name') && (
                      <TableCell sticky={0} stickyEdge>
                        <span className="ds-cell-id">
                          <MediaThumb
                            kind="playlist"
                            src={playlist.artworkUrl}
                          />
                          <SecondaryCell text={playlist.name}>
                            {kind === 'smart' ? (
                              <Link
                                href={smartPlaylistHref(
                                  library,
                                  playlist.id,
                                  playlist.view ?? {},
                                )}
                                prefetch={false}
                                className="ds-cell-title"
                              >
                                {playlist.name}
                              </Link>
                            ) : (
                              <DetailLink
                                kind={
                                  kind === 'playlist'
                                    ? 'library-playlist'
                                    : 'playlist'
                                }
                                id={playlist.id}
                                className="ds-cell-title"
                              >
                                {playlist.name}
                              </DetailLink>
                            )}
                          </SecondaryCell>
                          {playlist.inLibrary === false && (
                            <span className="ds-muted">Outside library</span>
                          )}
                          {kind === 'imported' ? (
                            <PlaylistPlayButton playlist={playlist} />
                          ) : playable && kind === 'playlist' ? (
                            <LibraryPlaylistPlayButton
                              playlist={{
                                id: playlist.id,
                                name: playlist.name,
                                entryCount: playlist.itemCount ?? 0,
                              }}
                              library={playable}
                            />
                          ) : playable && kind === 'smart' ? (
                            <SmartPlaylistPlayButton
                              playlist={playlist}
                              library={playable}
                              view={playlist.view ?? {}}
                            />
                          ) : null}
                        </span>
                      </TableCell>
                    )}
                    {columns.visible('type') && (
                      <TableCell>{playlistTypeLabel(playlist)}</TableCell>
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
                    {columns.visible('count') && (
                      <TableCell align="end">
                        <PlaylistCountCell row={playlist} library={library} />
                      </TableCell>
                    )}
                    {columns.visible('savedView') && (
                      <TableCell>
                        <SavedViewCell row={playlist} library={library} />
                      </TableCell>
                    )}
                    {columns.visible('updated') && (
                      <TableCell>
                        <DateValue value={playlist.updatedAt} />
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
                        {kind !== 'imported' && (
                          <PlaylistRowMenu
                            row={playlist}
                            items={playlistRowMenuItems(playlist, library, {
                              rename: (anchor) => {
                                renameAnchor.current = anchor
                                setRenaming(playlist)
                              },
                              remove: () =>
                                void actions.remove({ ...playlist, library }),
                            })}
                          />
                        )}
                        {playlist.source && outcome?.id !== playlist.id && (
                          <ConfirmAction
                            variant="ghost"
                            size="xs"
                            icon
                            confirmVariant="danger"
                            ariaLabel={`Remove ${playlist.name}`}
                            title={`Remove ${playlist.name}`}
                            question={`Remove ${playlist.name}?`}
                            details="Its tracks that are in no other playlist are removed too. Albums stay in the library."
                            confirmLabel="Remove"
                            disabled={
                              remove.isPending &&
                              remove.variables.id === playlist.id
                            }
                            feedback={
                              remove.variables?.id === playlist.id
                                ? mutationFeedback(remove, {
                                    pending: 'Removing…',
                                    success: 'Removed',
                                    error: 'Removal failed · retry',
                                  })
                                : undefined
                            }
                            onConfirm={() => remove.mutate(playlist)}
                          >
                            <Trash2 className="ds-i" aria-hidden="true" />
                          </ConfirmAction>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              }}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
      <ResultLineSlot place="content" />
    </ResultSection>
  )
}
