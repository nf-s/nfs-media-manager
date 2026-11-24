import { z } from 'zod'
import type { BrowseFilter } from '@repo/schemas/browse'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  PlaylistDetailQuerySchema,
  PlaylistPresentationSchema,
  type PlaylistDetailQuery,
  type PlaylistEntrySort,
  type PlaylistPresentation,
} from '@repo/schemas/tracks'
import type { BrowseView } from './media-grid'
import type { MediaScope } from './media-scope'

const PlaylistEntrySettingsSchema = PlaylistDetailQuerySchema.omit({
  groupBy: true,
}).extend({
  contents: PlaylistPresentationSchema.optional(),
  q: z.string().max(200).optional(),
})
const PlaylistEntryViewSchema = PlaylistEntrySettingsSchema.extend({
  id: z.string(),
})

export const playlistAlbumSorts: readonly PlaylistEntrySort[] = [
  'position',
  'title',
  'artists',
  'added',
  'releaseDate',
]

export const playlistPresentationLabels: Record<PlaylistPresentation, string> =
  {
    albums: 'Album playlist',
    tracks: 'Track playlist',
  }

/** Playlist table settings travel with its drawer URL, including a playback return link. */
export function playlistEntryView(value: string | null, id: string) {
  try {
    const parsed = PlaylistEntryViewSchema.safeParse(JSON.parse(value ?? '{}'))
    if (parsed.success && parsed.data.id === id) return parsed.data
  } catch {
    // Malformed URL state falls back to the playlist's original order.
  }
  return PlaylistEntrySettingsSchema.parse({})
}

export function playlistEntryViewParam(
  id: string,
  view: PlaylistDetailQuery & { contents?: PlaylistPresentation },
) {
  return JSON.stringify({
    id,
    sortBy: view.sortBy,
    direction: view.direction,
    q: view.q,
    kinds: view.kinds,
    contents: view.contents,
  })
}

/** The required filter for one playlist, as the playlist links apply it. */
export function playlistFilter(name: string): BrowseFilter {
  return { field: 'playlist', value: name, mode: 'required' }
}

function playlistFilterParams(name: string) {
  return new URLSearchParams({
    filters: JSON.stringify([playlistFilter(name)]),
  })
}

/** The Tracks view filtered to one playlist. */
export function playlistTracksHref(name: string) {
  return `/tracks?${playlistFilterParams(name)}`
}

/** The Albums view filtered to albums with a track in one playlist. */
export function playlistAlbumsHref(name: string) {
  return `/albums?${playlistFilterParams(name)}`
}

/**
 * The Browse order that matches each order of a playlist's own list. Playlist
 * position, the date added to the playlist and the entry columns have none.
 */
const playlistBrowseSorts: Partial<Record<PlaylistEntrySort, string>> = {
  title: 'title',
  artists: 'artist',
  album: 'album',
  duration: 'durationSec',
  releaseDate: 'releaseDate',
  scrobbles: 'scrobbles',
  lastListened: 'lastListenedAt',
}

/**
 * Tracks or Albums filtered to one playlist, with the search, order and view
 * its own list has now. An order Browse does not have is left to Browse.
 */
export function playlistBrowseHref(
  contents: PlaylistPresentation,
  name: string,
  list: {
    q?: string
    sortBy: PlaylistEntrySort
    direction: 'asc' | 'desc'
    view: BrowseView
  },
) {
  const params = playlistFilterParams(name)
  const q = list.q?.trim()
  if (q) params.set('q', q)
  const sortBy = playlistBrowseSorts[list.sortBy]
  if (sortBy && (contents === 'tracks' || sortBy !== 'album')) {
    params.set('sortBy', sortBy)
    params.set('direction', list.direction)
  }
  params.set('view', list.view)
  return `/${contents}?${params}`
}

/** The library Browse view filtered to members of one stored collection. */
export function collectionItemsHref(mediaType: MediaScope, name: string) {
  return `/${mediaType}s?${new URLSearchParams({ filters: JSON.stringify([{ field: 'collection', value: name, mode: 'required' } satisfies BrowseFilter]) })}`
}

/**
 * The Browse order that matches each order of a collection's own list.
 * Collection position, source and watched have none.
 */
const collectionBrowseSorts: Readonly<Record<string, string>> = {
  title: 'title',
  artists: 'artist',
  releaseDate: 'releaseDate',
  durationSec: 'durationSec',
  runtimeMinutes: 'runtimeMinutes',
  dateAdded: 'dateAdded',
}

/**
 * Films or Albums filtered to one collection, with the search, watched
 * filter, order and view its own list has now.
 */
export function collectionBrowseHref(
  mediaType: MediaScope,
  name: string,
  list: {
    q?: string
    watchedStates?: readonly ('watched' | 'unwatched')[]
    sortBy: string
    direction: 'asc' | 'desc'
    view: BrowseView
  } & CatalogScopeQuery,
) {
  const filters: BrowseFilter[] = [
    { field: 'collection', value: name, mode: 'required' },
  ]
  // Both states together are every film, which needs no filter.
  const [watched, other] = list.watchedStates ?? []
  if (watched && !other)
    filters.push({
      field: 'watched',
      value: watched === 'watched' ? 'Yes' : 'No',
      mode: 'required',
    })
  const params = new URLSearchParams({ filters: JSON.stringify(filters) })
  if (list.libraryScope) params.set('libraryScope', list.libraryScope)
  if (list.discoverySources)
    params.set('discoverySources', list.discoverySources)
  if (list.discoverySourceScope)
    params.set('discoverySourceScope', list.discoverySourceScope)
  if (list.discoverySourceMode)
    params.set('discoverySourceMode', list.discoverySourceMode)
  const q = list.q?.trim()
  if (q) params.set('q', q)
  const sortBy = collectionBrowseSorts[list.sortBy]
  if (sortBy) {
    params.set('sortBy', sortBy)
    params.set('direction', list.direction)
  }
  params.set('view', list.view)
  return `/${mediaType}s?${params}`
}

export function trackHref(id: string) {
  return `/tracks/${encodeURIComponent(id)}`
}

/** Tabs of the playlist drawer; `overview` is the default and is left out of URLs. */
export const PlaylistTabSchema = z.enum([
  'overview',
  'listening',
  'coverage',
  'sources',
])
export type PlaylistTab = z.infer<typeof PlaylistTabSchema>

/**
 * The `tab` URL parameter of the playlist drawer, defaulting to Overview.
 * Older links used `tracks` for the contents and `sync` for Sources.
 */
export function parsePlaylistTab(value: string | null): PlaylistTab {
  if (value === 'sync') return 'sources'
  const parsed = PlaylistTabSchema.safeParse(value)
  return parsed.success ? parsed.data : 'overview'
}

/** The URL parameters that open the playlist drawer on a tab. */
export function playlistDrawerParams(
  id: string,
  tab: PlaylistTab = 'overview',
) {
  return { playlist: id, tab: tab === 'overview' ? null : tab }
}

/** The Playlists page with one playlist's drawer open. */
export function playlistHref(id: string, tab: PlaylistTab = 'overview') {
  const params = new URLSearchParams({ playlist: id })
  if (tab !== 'overview') params.set('tab', tab)
  return `/playlists?${params}`
}
