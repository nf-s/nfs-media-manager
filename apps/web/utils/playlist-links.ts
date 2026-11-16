import { z } from 'zod'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  PlaylistDetailQuerySchema,
  type PlaylistDetailQuery,
} from '@repo/schemas/tracks'

const PlaylistEntryViewSchema = PlaylistDetailQuerySchema.extend({
  id: z.string(),
  q: z.string().max(200).optional(),
})

/** Playlist table settings travel with its drawer URL, including a playback return link. */
export function playlistEntryView(value: string | null, id: string) {
  try {
    const parsed = PlaylistEntryViewSchema.safeParse(JSON.parse(value ?? '{}'))
    if (parsed.success && parsed.data.id === id) return parsed.data
  } catch {
    // Malformed URL state falls back to the playlist's original order.
  }
  return PlaylistDetailQuerySchema.parse({})
}

export function playlistEntryViewParam(id: string, view: PlaylistDetailQuery) {
  return JSON.stringify({
    id,
    sortBy: view.sortBy,
    direction: view.direction,
    q: view.q,
    kinds: view.kinds,
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

/** The Films view filtered to members of one stored collection. */
export function collectionFilmsHref(name: string) {
  return `/films?${new URLSearchParams({ filters: JSON.stringify([{ field: 'collection', value: name, mode: 'required' } satisfies BrowseFilter]) })}`
}

export function trackHref(id: string) {
  return `/tracks/${encodeURIComponent(id)}`
}

/** Tabs of the playlist drawer; `overview` is the default and is left out of URLs. */
export const PlaylistTabSchema = z.enum(['overview', 'listening', 'sources'])
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
