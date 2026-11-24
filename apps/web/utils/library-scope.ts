import {
  CatalogScopeQuerySchema,
  isTrackDiscoverySource,
  type CatalogScopeQuery,
} from '@repo/schemas/catalog'

export const libraryScopeLabels = {
  library: 'In library',
  outside: 'Outside library',
  all: 'All known',
}

export const discoverySourceLabels = new Map([
  ['artist-albums', 'Artist albums'],
  ['spotify-match', 'Spotify matching'],
  ['spotify-code-search', 'Spotify recording code search'],
  ['similar', 'Similar results'],
  ['catalog-search', 'Catalogue search'],
  ['playlist', 'Playlist'],
  ['playlist-listing', 'Playlist directory'],
  ['playlist-contents', 'Playlist contents'],
  ['playback-queue', 'Playback queue'],
  ['playback-recovery', 'Recently played'],
  ['album-preview', 'Album preview'],
  ['match-search', 'Find match'],
  ['tidal-track-match', 'TIDAL track matching'],
  ['sonovault-track-match', 'Sonovault track matching'],
  ['sonovault-track-lookup', 'Sonovault track lookup'],
  ['sonovault-album-match', 'Sonovault album matching'],
  ['similar-resolution', 'Similar item lookup'],
  ['subscription-catalogue', 'Subscription directory'],
  ['channel-details', 'Channel details'],
  ['upload-listing', 'Channel uploads'],
  ['video-details', 'Video details'],
  ['podcast-catalogue', 'Podcast directory'],
  ['podcast-episodes', 'Podcast episodes'],
  ['station-schedule', 'Station schedule'],
  ['playback', 'Playback'],
  ['album-tracks', 'Album tracks'],
  ['provider-result', 'Provider results'],
  ['import', 'Import'],
  ['album-import-preview', 'Album import preview'],
  ['film-import-preview', 'Film import preview'],
  ['film-match-chosen', 'Chosen film match'],
  ['channel-uploads', 'Channel upload sync'],
  ['shorts-listing', 'Shorts listing'],
  ['film-details', 'Film details'],
  ['playlist-identity', 'Playlist identity'],
  ['scrobble', 'Listening history'],
  ['parent-reference', 'Parent link'],
  ['station-feed', 'Station feed'],
  ['station-show-detail', 'Station show details'],
  ['station-episode-response', 'Station episode details'],
  ['stored-short', 'Saved Shorts listing'],
  ['stored-subscription-source', 'Saved subscription source'],
  ['stored-subscription-item', 'Saved subscription item'],
])

export const clearLibraryScope = {
  libraryScope: null,
  discoverySources: null,
  discoverySourceMode: null,
  discoverySourceScope: null,
}

export type LibraryScope = keyof typeof libraryScopeLabels

export type LibraryScopeState = {
  scope: LibraryScope
  sources: string[]
  mode: 'any' | 'all' | 'exclude'
  selection?: boolean
}

export function readLibraryScope(
  params: Pick<URLSearchParams, 'get'>,
  kind?: 'track',
): LibraryScopeState {
  const { libraryScope, discoverySources, discoverySourceMode } =
    CatalogScopeQuerySchema.shape
  const rawSources = discoverySources.safeParse(
    params.get('discoverySources'),
  ).data
  const sources = [...new Set(rawSources?.split(','))].sort()
  return {
    scope: libraryScope.safeParse(params.get('libraryScope')).data ?? 'library',
    ...(params.get('discoverySourceScope') === 'selection'
      ? { selection: true }
      : {}),
    sources:
      kind === 'track' ? sources.filter(isTrackDiscoverySource) : sources,
    mode:
      discoverySourceMode.safeParse(params.get('discoverySourceMode')).data ??
      'any',
  }
}

export function libraryScopeQuery({
  scope,
  sources,
  mode,
  selection,
}: LibraryScopeState): CatalogScopeQuery {
  if (scope === 'library' && !(sources.length && selection)) return {}
  return {
    libraryScope: scope,
    ...(sources.length
      ? { discoverySources: [...sources].sort().join(',') }
      : {}),
    ...(sources.length && mode !== 'any' ? { discoverySourceMode: mode } : {}),
    ...(sources.length && selection
      ? { discoverySourceScope: 'selection' }
      : {}),
  }
}

export function libraryScopeUpdates({
  scope,
  sources,
  mode,
  selection,
}: LibraryScopeState) {
  return {
    libraryScope: scope === 'library' ? null : scope,
    discoverySources: sources.length ? [...sources].sort().join(',') : null,
    discoverySourceMode: mode !== 'any' ? mode : null,
    discoverySourceScope: selection ? 'selection' : null,
  }
}

export function libraryScopeFilterCount({
  scope,
  sources,
  selection,
}: LibraryScopeState) {
  return (
    Number(scope === 'outside') +
    (scope === 'library' && !selection ? 0 : sources.length)
  )
}
