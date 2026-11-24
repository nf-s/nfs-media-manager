import {
  CatalogScopeQuerySchema,
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
  ['playlist-listing','Playlist directory'], ['playlist-contents','Playlist contents'],
  ['playback-queue','Playback queue'], ['playback-recovery','Recently played'],
  ['album-preview','Album preview'], ['match-search','Find match'],
  ['tidal-track-match','TIDAL track matching'], ['sonovault-track-match','Sonovault track matching'],
  ['sonovault-track-lookup','Sonovault track lookup'], ['sonovault-album-match','Sonovault album matching'],
  ['similar-resolution','Similar item lookup'], ['subscription-catalogue','Subscription directory'],
  ['channel-details','Channel details'], ['upload-listing','Channel uploads'], ['video-details','Video details'],
  ['podcast-catalogue','Podcast directory'], ['podcast-episodes','Podcast episodes'], ['station-schedule','Station schedule'],
  ['playback', 'Playback'],
  ['album-tracks', 'Album tracks'],
  ['provider-result', 'Provider results'],
  ['import', 'Import'],
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
): LibraryScopeState {
  const { libraryScope, discoverySources, discoverySourceMode } =
    CatalogScopeQuerySchema.shape
  const sources = discoverySources.safeParse(
    params.get('discoverySources'),
  ).data
  return {
    scope: libraryScope.safeParse(params.get('libraryScope')).data ?? 'library',
    ...(params.get('discoverySourceScope') === 'selection' ? {selection:true} : {}),
    sources: [...new Set(sources?.split(','))].sort(),
    mode:
      discoverySourceMode.safeParse(params.get('discoverySourceMode')).data ??
      'any',
  }
}

export function libraryScopeQuery({
  scope,
  sources,
  mode,selection,
}: LibraryScopeState): CatalogScopeQuery {
  if (scope === 'library' && !(sources.length && selection)) return {}
  return {
    libraryScope: scope,
    ...(sources.length
      ? { discoverySources: [...sources].sort().join(',') }
      : {}),
    ...(sources.length && mode !== 'any' ? { discoverySourceMode: mode } : {}),
    ...(sources.length && selection ? {discoverySourceScope:'selection'} : {}),
  }
}

export function libraryScopeUpdates({
  scope,
  sources,
  mode,selection,
}: LibraryScopeState) {
  return {
    libraryScope: scope === 'library' ? null : scope,
    discoverySources: sources.length ? [...sources].sort().join(',') : null,
    discoverySourceMode: mode !== 'any' ? mode : null,
    discoverySourceScope: selection ? 'selection' : null,
  }
}

export function libraryScopeFilterCount({ scope, sources, selection }: LibraryScopeState) {
  return (
    Number(scope === 'outside') + (scope === 'library' && !selection ? 0 : sources.length)
  )
}
