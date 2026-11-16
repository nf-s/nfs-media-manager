import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import { ArtistQuerySchema, type ArtistSummary } from '@repo/schemas/creators'
import type { TitleSuggestion } from './browse-suggestions'

/** Column, picker and sort order: identity, properties, dates, counts, pills. */
export const artistFieldOrder = [
  'name',
  'country',
  'type',
  'provider',
  'createdAt',
  'albumCount',
  'trackCount',
  'scrobbles',
  'playlistCount',
  'playlist',
  'genre',
]

export const defaultArtistColumns = [
  'name',
  'country',
  'createdAt',
  'albumCount',
  'trackCount',
  'scrobbles',
  'genre',
]

export function parseArtistFilters(value: string | null): BrowseFilter[] {
  const result = ArtistQuerySchema.shape.filters.safeParse(value)
  return result.success ? result.data : []
}

/** Playlist selections intersect by default, matching Tracks Browse. */
export function withArtistFilter(
  filters: BrowseFilter[],
  filter: BrowseFilter,
): BrowseFilter[] {
  const next =
    filter.field === 'playlist' && filter.mode === undefined
      ? ({ ...filter, mode: 'required' } satisfies BrowseFilter)
      : filter
  return filters.some((item) => sameBrowseFilter(item, next))
    ? filters
    : [...filters, next]
}

export function artistTitleSuggestions(
  items: Pick<ArtistSummary, 'id' | 'name'>[],
): TitleSuggestion[] {
  return items.map((item) => ({
    id: item.id,
    title: item.name,
    label: item.name,
  }))
}
