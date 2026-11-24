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
  ['playback', 'Playback'],
  ['album-tracks', 'Album tracks'],
  ['provider-result', 'Provider results'],
  ['import', 'Import'],
])

export const clearLibraryScope = {
  libraryScope: null,
  discoverySources: null,
  discoverySourceMode: null,
}

export type LibraryScope = keyof typeof libraryScopeLabels

export type LibraryScopeState = {
  scope: LibraryScope
  sources: string[]
  mode: 'any' | 'all'
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
    sources: [...new Set(sources?.split(','))].sort(),
    mode:
      discoverySourceMode.safeParse(params.get('discoverySourceMode')).data ??
      'any',
  }
}

export function libraryScopeQuery({
  scope,
  sources,
  mode,
}: LibraryScopeState): CatalogScopeQuery {
  if (scope === 'library') return {}
  return {
    libraryScope: scope,
    ...(sources.length
      ? { discoverySources: [...sources].sort().join(',') }
      : {}),
    ...(sources.length && mode === 'all' ? { discoverySourceMode: mode } : {}),
  }
}

export function libraryScopeUpdates({
  scope,
  sources,
  mode,
}: LibraryScopeState) {
  return {
    libraryScope: scope === 'library' ? null : scope,
    discoverySources: sources.length ? [...sources].sort().join(',') : null,
    discoverySourceMode: mode === 'all' ? mode : null,
  }
}

export function libraryScopeFilterCount({ scope, sources }: LibraryScopeState) {
  return (
    Number(scope === 'outside') + (scope === 'library' ? 0 : sources.length)
  )
}
