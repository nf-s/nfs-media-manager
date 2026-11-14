import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import {
  TrackQuerySchema,
  type TrackListItem,
  type TrackScrobbleLinkStrategy,
} from '@repo/schemas/tracks'
import type { TitleSuggestion } from './browse-suggestions'

export const defaultTrackColumns = [
  'title',
  'artist',
  'album',
  'source',
  'playlist',
  'durationSec',
  'dateAdded',
  'scrobbles',
  'genre',
]

export const trackScrobbleRuleLabels: Record<
  TrackScrobbleLinkStrategy,
  string
> = {
  exact: 'Exact match',
  normalized: 'Ignoring accents and punctuation',
  version: 'Ignoring version notes',
  album: 'Same album',
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

export function formatTrackDuration(seconds: number | null) {
  if (seconds === null) return '-'
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
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
