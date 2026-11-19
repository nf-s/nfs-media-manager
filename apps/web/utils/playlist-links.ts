import { z } from 'zod'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  PlaylistDetailQuerySchema,
  PlaylistPresentationSchema,
  type PlaylistDetailQuery,
  type PlaylistEntrySort,
  type PlaylistPresentation,
} from '@repo/schemas/tracks'
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

/** The library Browse view filtered to members of one stored collection. */
export function collectionItemsHref(mediaType: MediaScope, name: string) {
  return `/${mediaType}s?${new URLSearchParams({ filters: JSON.stringify([{ field: 'collection', value: name, mode: 'required' } satisfies BrowseFilter]) })}`
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
