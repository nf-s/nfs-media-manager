import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import {
  TrackQuerySchema,
  type TrackListItem,
  type TrackScrobbleLinkStrategy,
} from '@repo/schemas/tracks'
import { formatTrackLength } from '@repo/ui/lib/format'
import type { TitleSuggestion } from './browse-suggestions'

/** Column, picker and sort order: identity, creator, parent, properties, dates, counts, pills. */
export const trackFieldOrder = [
  'title',
  'artist',
  'album',
  'albumLink',
  'source',
  'spotifyMatch',
  'durationSec',
  'releaseDate',
  'dateAdded',
  'lastListenedAt',
  'scrobbles',
  'playlist',
  'genre',
  'albumTag',
  'artistTag',
]

export const defaultTrackColumns = [
  'title',
  'artist',
  'album',
  'durationSec',
  'dateAdded',
  'scrobbles',
  'playlist',
  'genre',
]

export function trackGroupingEnabled(sortBy: string, override: string | null) {
  if (override === 'true' || override === 'false') return override === 'true'
  return sortBy === 'scrobbles' || sortBy === 'lastListenedAt'
}

export const trackScrobbleRuleLabels: Record<
  TrackScrobbleLinkStrategy,
  string
> = {
  exact: 'Exact match',
  normalized: 'Ignoring accents and punctuation',
  version: 'Ignoring version notes',
  album: 'Same album',
  manual: 'Manually matched',
}

export function parseTrackFilters(value: string | null): BrowseFilter[] {
  const result = TrackQuerySchema.shape.filters.safeParse(value)
  return result.success ? result.data : []
}

/** Playlist filters intersect: each added playlist is required. */
export function trackFilter(filter: BrowseFilter): BrowseFilter {
  return filter.field === 'playlist' && filter.mode === undefined
    ? { ...filter, mode: 'required' }
    : filter
}

export function withTrackFilter(
  filters: BrowseFilter[],
  filter: BrowseFilter,
): BrowseFilter[] {
  return filters.some((item) => sameBrowseFilter(item, filter))
    ? filters
    : [...filters, trackFilter(filter)]
}

export function tracksHref(filters: BrowseFilter[]) {
  return filters.length
    ? `/tracks?${new URLSearchParams({ filters: JSON.stringify(filters) })}`
    : '/tracks'
}

export function albumHref(albumId: string) {
  return `/albums/${encodeURIComponent(albumId)}`
}

/** `4:05`, or an en dash when the length is unknown. */
export function formatTrackDuration(seconds: number | null) {
  return formatTrackLength(seconds === null ? null : seconds * 1000)
}

export function trackTitleSuggestions(
  items: Pick<TrackListItem, 'id' | 'title' | 'artists'>[],
): TitleSuggestion[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    label: item.artists.length
      ? `${item.title} · ${item.artists.join(', ')}`
      : item.title,
  }))
}
