import { z } from 'zod'
import {
  BrowseFilterSchema,
  BrowseRangesParamSchema,
  type BrowseField,
  type BrowseValues,
} from './browse'
import type { ArtistSummary } from './creators'

/** Months in an artist row's listening sparkline, ending with the current month. */
export const ARTIST_LISTENING_MONTHS = 12

export const artistBrowseFields: BrowseField[] = [
  { key: 'name', label: 'Artist', type: 'text', filterable: true },
  { key: 'playlist', label: 'Playlists', type: 'text', filterable: true },
  { key: 'genre', label: 'Tags', type: 'text', filterable: true },
  { key: 'country', label: 'Country', type: 'text', filterable: true },
  { key: 'type', label: 'Type', type: 'text', filterable: true },
  { key: 'provider', label: 'Provider', type: 'text', filterable: true },
  { key: 'createdAt', label: 'Added', type: 'date', filterable: true },
  { key: 'albumCount', label: 'Albums', type: 'number', filterable: true },
  { key: 'trackCount', label: 'Tracks', type: 'number', filterable: true },
  { key: 'scrobbles', label: 'Scrobbles', type: 'number', filterable: true },
  {
    key: 'playlistCount',
    label: 'Playlists',
    type: 'number',
    filterable: true,
  },
]

export const ArtistBrowseSortSchema = z.enum([
  'name',
  'playlist',
  'genre',
  'country',
  'type',
  'provider',
  'createdAt',
  'albumCount',
  'trackCount',
  'scrobbles',
  'playlistCount',
])
const textKeys = new Set(
  artistBrowseFields
    .filter((field) => field.type === 'text')
    .map((field) => field.key),
)
const rangeKeys = new Set(
  artistBrowseFields
    .filter((field) => field.type !== 'text')
    .map((field) => field.key),
)

export const ArtistBrowseFiltersParamSchema = z.preprocess(
  (value) => {
    if (!value) return []
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  },
  z
    .array(
      BrowseFilterSchema.refine(
        (filter) => textKeys.has(filter.field),
        'Unknown artist filter',
      ),
    )
    .max(40),
)

export const ArtistBrowseRangesParamSchema = BrowseRangesParamSchema.refine(
  (ranges) => ranges.every((range) => rangeKeys.has(range.field)),
  'Unknown artist range',
)

export function getArtistBrowseValues(artist: ArtistSummary): BrowseValues {
  return {
    ...artist.browse,
    name: artist.name,
    createdAt: Date.parse(artist.createdAt),
    albumCount: artist.albumCount,
    trackCount: artist.trackCount,
    ...(artist.scrobbleCount === undefined
      ? {}
      : { scrobbles: artist.scrobbleCount }),
    playlistCount: artist.playlistCount,
  }
}
