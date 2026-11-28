'use client'

import { useQuery } from '@tanstack/react-query'
import { Ellipsis, LayoutGrid, Pencil, Trash2 } from 'lucide-react'
import { BrowseCountSchema } from '@repo/schemas/browse'
import {
  LIBRARY_PLAYLIST_FILTER_FIELD,
  parseLibraryBrowseView,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistView,
} from '@repo/schemas/library-playlists'
import type { PlaylistSummary } from '@repo/schemas/tracks'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import {
  libraryPlaylistNouns,
  smartPlaylistHref,
} from '@/utils/library-playlists'
import { createBrowsePlaybackSource } from '@/utils/playback-source'
import { clientQueryDefaults } from '@/utils/query-cache'
import { describeSavedView } from '@/utils/saved-view-sentence'
import { subscriptionLibraryParams } from '@/utils/subscriptions'
import { ActionMenu, type DetailMenuItem } from './action-menu'
import { useLibraryPlaylistNames } from './library-playlist-name'
import { useConfig } from './providers'
import { SecondaryCell } from './secondary-table'
import { SourcePlayButton } from './source-play-button'

/** A directory row's kind: imported, a library playlist or a smart playlist. */
export type PlaylistRowKind = 'imported' | 'playlist' | 'smart'

export function playlistRowKind(row: PlaylistSummary): PlaylistRowKind {
  if (row.origin !== 'library') return 'imported'
  return row.type === 'smart' ? 'smart' : 'playlist'
}

/** The Type column: "Playlist" or "Smart playlist". */
export function playlistTypeLabel(row: PlaylistSummary) {
  return row.type === 'smart' ? 'Smart playlist' : 'Playlist'
}

/** The count column's heading: the library's noun, "Tracks" or "Albums". */
export function playlistCountHeading(library: LibraryPlaylistLibrary) {
  const { other } = libraryPlaylistNouns[library]
  return other.charAt(0).toUpperCase() + other.slice(1)
}

/**
 * A playlist's count in the library's noun: its entries, or an imported
 * playlist's tracks in Tracks and albums in Albums. Null for a smart
 * playlist, whose count is read from Browse.
 */
export function playlistRowCount(
  row: PlaylistSummary,
  library: LibraryPlaylistLibrary,
) {
  if (row.type === 'smart') return row.itemCount ?? null
  return (
    row.itemCount ?? (library === 'albums' ? row.albumCount : row.trackCount)
  )
}

/** The Browse count read of a library's view, as Browse itself reads it. */
function browseCountRequest(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
) {
  const params = new URLSearchParams(view)
  for (const key of ['sortBy', 'direction', 'listeningSort', 'page', 'size'])
    params.delete(key)
  if (library === 'subscriptions' || library === 'mixes')
    for (const [key, value] of Object.entries(
      subscriptionLibraryParams(library),
    ))
      params.set(key, value)
  params.sort()
  const endpoint =
    library === 'subscriptions' || library === 'mixes'
      ? 'subscriptions'
      : library
  return {
    queryKey: [library, 'browse-count', params.toString()],
    path: `/api/v1/${endpoint}/browse-count?${params}`,
  }
}

/** A smart playlist's count now: what its view matches in Browse. */
export function useSmartPlaylistCount(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
) {
  const { apiBaseUrl } = useConfig()
  const request = browseCountRequest(library, view)
  return useQuery({
    queryKey: request.queryKey,
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, request.path, BrowseCountSchema, { signal }),
    ...clientQueryDefaults,
    retry: false,
  })
}

/** The count cell: a number, or for a smart playlist its count once read. */
export function PlaylistCountCell({
  row,
  library,
}: {
  row: PlaylistSummary
  library: LibraryPlaylistLibrary
}) {
  const count = playlistRowCount(row, library)
  if (count !== null) return formatCount(count)
  return <SmartPlaylistCount library={library} view={row.view ?? {}} />
}

function SmartPlaylistCount({
  library,
  view,
}: {
  library: LibraryPlaylistLibrary
  view: LibraryPlaylistView
}) {
  const count = useSmartPlaylistCount(library, view)
  return count.data ? formatCount(count.data.totalCount) : <EmptyValue />
}

/** The IDs of the playlists a view filters by. */
function viewPlaylistIds(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
) {
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success) return []
  const filters: readonly { field: string; value: string }[] =
    parsed.data.query.filters
  return filters.flatMap((filter) =>
    filter.field === LIBRARY_PLAYLIST_FILTER_FIELD ? [filter.value] : [],
  )
}

/** Saved view: a smart playlist's view written out, an en dash otherwise. */
export function SavedViewCell({
  row,
  library,
}: {
  row: PlaylistSummary
  library: LibraryPlaylistLibrary
}) {
  const view = row.type === 'smart' ? row.view : null
  const playlistName = useLibraryPlaylistNames(
    view ? viewPlaylistIds(library, view) : [],
  )
  if (!view) return <EmptyValue />
  const text = describeSavedView({ library, view, playlistName })
  return <SecondaryCell text={text}>{text}</SecondaryCell>
}

/**
 * Play and Add to queue for a smart playlist in Albums or Tracks: what its
 * view matches now, in its order, through Browse playback.
 */
export function SmartPlaylistPlayButton({
  playlist,
  library,
  view,
}: {
  playlist: Pick<PlaylistSummary, 'id' | 'name'>
  library: 'albums' | 'tracks'
  view: LibraryPlaylistView
}) {
  const { apiBaseUrl } = useConfig()
  const request = browseCountRequest(library, view)
  return (
    <SourcePlayButton
      title={playlist.name}
      feedbackKey={`smart-playlist:${playlist.id}`}
      emptyReason={`No ${libraryPlaylistNouns[library].other}.`}
      loadSource={async () => {
        const { totalCount } = await fetchApiData(
          apiBaseUrl,
          request.path,
          BrowseCountSchema,
        )
        return createBrowsePlaybackSource({
          apiBaseUrl,
          collection: library,
          params: new URLSearchParams(view),
          href: smartPlaylistHref(library, playlist.id, view),
          label: playlist.name,
          total: totalCount,
          startIndex: 0,
        })
      }}
    />
  )
}

const icon = {
  browse: <LayoutGrid className="ds-i" data-size="sm" aria-hidden />,
  rename: <Pencil className="ds-i" data-size="sm" aria-hidden />,
  delete: <Trash2 className="ds-i" data-size="sm" aria-hidden />,
}

/**
 * PL-51: a library row's three-dot menu: Open in Browse for a smart
 * playlist, Rename, and Delete playlist or Delete smart playlist.
 */
export function playlistRowMenuItems(
  row: PlaylistSummary,
  library: LibraryPlaylistLibrary,
  actions: {
    rename: (anchor: HTMLElement) => void
    remove: () => void
  },
): DetailMenuItem[] {
  const smart = row.type === 'smart'
  return [
    ...(smart
      ? [
          {
            label: 'Open in Browse',
            icon: icon.browse,
            href: smartPlaylistHref(library, row.id, row.view ?? {}),
          },
        ]
      : []),
    { label: 'Rename', icon: icon.rename, onSelect: actions.rename },
    {
      label: smart ? 'Delete smart playlist' : 'Delete playlist',
      icon: icon.delete,
      onSelect: actions.remove,
    },
  ]
}

/** The three-dot button of a library row and its menu. */
export function PlaylistRowMenu({
  row,
  items,
}: {
  row: PlaylistSummary
  items: readonly DetailMenuItem[]
}) {
  return (
    <ActionMenu
      items={items}
      label={`More actions for ${row.name}`}
      sheet
      trigger={(props) => (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          icon
          aria-label={`More actions for ${row.name}`}
          title="More actions"
          {...props}
        >
          <Ellipsis className="ds-i" aria-hidden="true" />
        </Button>
      )}
    />
  )
}
