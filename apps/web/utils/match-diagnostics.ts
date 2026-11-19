import {
  AlbumMatchRejectionInputSchema,
  AlbumMatchRejectionPageSchema,
  AlbumMatchRejectionSchema,
  MatchDiagnosticsPageSchema,
  MatchDiagnosticsQuerySchema,
  TrackMatchDiagnosticsQuerySchema,
  TrackPlayabilitySchema,
  trackMatchProviderLabels,
  type AlbumMatchRejectionInput,
  type MatchDiagnosticsQuery,
  type MatchDiagnosticsRow,
  type TrackMatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import {
  BrowseRangesParamSchema,
  canonicalBrowseKey,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { fetchApiData } from './api'
import { parseCreatorBrowseScope } from './creator-browse'
import type { LibraryView } from './media-scope'
import type { LibraryTrackSource } from './playback'
import { parseTrackFilters } from './track-browse'

export const matchDiagnosticsPageSize = 50

export function matchDiagnosticsKey(library: LibraryView) {
  return [`${library}s`, 'match-diagnostics']
}

export function albumMatchHistoryKey(id: string) {
  return ['albums', 'match-rejections', id]
}

function albumMatchRejectionsPath(id: string) {
  return `/api/v1/albums/${encodeURIComponent(id)}/match-rejections`
}

export function loadAlbumMatchHistory(
  apiBaseUrl: string,
  id: string,
  page: number,
  size: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ page: String(page), size: String(size) })
  return fetchApiData(
    apiBaseUrl,
    `${albumMatchRejectionsPath(id)}?${params}`,
    AlbumMatchRejectionPageSchema,
    { signal },
  )
}

export function rejectAlbumMatch(
  apiBaseUrl: string,
  id: string,
  target: AlbumMatchRejectionInput,
) {
  return fetchApiData(
    apiBaseUrl,
    albumMatchRejectionsPath(id),
    AlbumMatchRejectionSchema,
    {
      method: 'POST',
      body: JSON.stringify(AlbumMatchRejectionInputSchema.parse(target)),
    },
  )
}

export function matchDiagnosticsSort(params: URLSearchParams) {
  const sort = MatchDiagnosticsQuerySchema.shape.sortBy.safeParse(
    params.get('sortBy') ?? undefined,
  )
  const direction = MatchDiagnosticsQuerySchema.shape.direction.safeParse(
    params.get('direction') ?? undefined,
  )
  return {
    sortBy: sort.success ? sort.data : 'name',
    direction: direction.success ? direction.data : 'asc',
  }
}

export function loadMatchDiagnosticsPage(
  apiBaseUrl: string,
  library: LibraryView,
  query: MatchDiagnosticsQuery,
  signal?: AbortSignal,
) {
  const { q, page, size, sortBy, direction } =
    MatchDiagnosticsQuerySchema.parse(query)
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    sortBy,
    direction,
  })
  if (q) params.set('q', q)
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/${library}s/match-diagnostics?${params}`,
    MatchDiagnosticsPageSchema,
    { signal },
  )
}

/** The URL state used by the diagnostic table, with the shared track filters and ranges. */
export function trackMatchDiagnosticsQuery(
  params: URLSearchParams,
): Omit<TrackMatchDiagnosticsQuery, 'page' | 'size'> {
  const { sortBy, direction } = matchDiagnosticsSort(params)
  const ranges = BrowseRangesParamSchema.safeParse(params.get('ranges'))
  const limit = TrackQuerySchema.shape.limitResults.safeParse(
    params.get('limitResults') ?? undefined,
  )
  const filters = parseTrackFilters(params.get('filters'))
  const explicit = TrackPlayabilitySchema.safeParse(params.get('playability'))
  // Existing Missing Spotify bookmarks are a work queue for recordings with no playable version.
  const playability = explicit.success
    ? explicit.data
    : trackMatchPreset(filters) === 'missing-spotify'
      ? 'unavailable'
      : 'all'
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    filters,
    playability,
    ranges: ranges.success ? ranges.data : [],
    sortBy:
      sortBy === 'name'
        ? 'title'
        : sortBy === 'creator'
          ? 'artist'
          : canonicalBrowseKey(sortBy),
    direction,
    limitResults: limit.success ? limit.data : undefined,
    ...parseCreatorBrowseScope(params, 'track'),
  }
}

export function loadTrackMatchDiagnosticsPage(
  apiBaseUrl: string,
  input: TrackMatchDiagnosticsQuery,
  signal?: AbortSignal,
) {
  const query = TrackMatchDiagnosticsQuerySchema.parse(input)
  const params = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
    sortBy: query.sortBy,
    direction: query.direction,
  })
  if (query.q) params.set('q', query.q)
  if (query.filters.length) params.set('filters', JSON.stringify(query.filters))
  if (query.ranges.length) params.set('ranges', JSON.stringify(query.ranges))
  if (query.creatorId) params.set('creatorId', query.creatorId)
  if (
    query.playability &&
    (query.playability !== 'all' || query.view === 'spotify-search-metadata')
  )
    params.set('playability', query.playability)
  if (query.view && query.view !== 'providers') params.set('view', query.view)
  if (query.freshness?.length)
    params.set('freshness', JSON.stringify(query.freshness))
  if (query.listening) params.set('listening', JSON.stringify(query.listening))
  if (query.listeningSort)
    params.set('listeningSort', JSON.stringify(query.listeningSort))
  if (query.limitResults !== undefined)
    params.set('limitResults', String(query.limitResults))
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/match-diagnostics?${params}`,
    MatchDiagnosticsPageSchema,
    { signal },
  )
}

export function playableMatchTrack(
  track: LibraryTrackSource,
  alternate: MatchDiagnosticsRow['spotifyAlternate'],
): LibraryTrackSource {
  if (!alternate) return track
  return {
    id: alternate.trackId,
    spotifyTrackId: alternate.identifier,
    title: alternate.name,
    artists: track.artists,
    artistCredits: track.artistCredits,
    album: alternate.album ?? null,
    albumName: alternate.albumName,
    artworkUrl: alternate.artworkUrl ?? null,
  }
}

type TrackMatchPreset = {
  key: string
  label: string
  value?: string
  mode?: BrowseFilter['mode']
}

export const trackMatchPresets: TrackMatchPreset[] = [
  { key: 'all', label: 'All tracks' },
  {
    key: 'unmatched',
    label: 'Unmatched recordings',
    value: trackMatchProviderLabels.noRecording,
    mode: 'required',
  },
  {
    key: 'none',
    label: 'No matches at all',
    value: trackMatchProviderLabels.noEvidence,
    mode: 'required',
  },
  {
    key: 'missing-spotify',
    label: 'Missing Spotify on this entry',
    value: trackMatchProviderLabels.spotify,
    mode: 'exclude',
  },
  {
    key: 'missing-lastfm',
    label: 'Missing Last.fm',
    value: trackMatchProviderLabels.lastfm,
    mode: 'exclude',
  },
  {
    key: 'missing-discogs',
    label: 'Missing Discogs album evidence',
    value: trackMatchProviderLabels.discogs,
    mode: 'exclude',
  },
]

export function trackMatchPreset(filters: BrowseFilter[]) {
  const provider = filters.filter((filter) => filter.field === 'matchProvider')
  if (!provider.length) return 'all'
  const filter = provider[0]
  return provider.length === 1 && filter
    ? (trackMatchPresets.find(
        ({ value, mode }) => value === filter.value && mode === filter.mode,
      )?.key ?? 'custom')
    : 'custom'
}

export function applyTrackMatchPreset(filters: BrowseFilter[], key: string) {
  const preset = trackMatchPresets.find((option) => option.key === key)
  if (!preset) return filters
  const rest = filters.filter((filter) => filter.field !== 'matchProvider')
  return preset.value
    ? [
        ...rest,
        { field: 'matchProvider', value: preset.value, mode: preset.mode },
      ]
    : rest
}
