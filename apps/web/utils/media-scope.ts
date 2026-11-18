export type MediaScope = 'album' | 'film'
/**
 * The library that Jobs and Providers are scoped to. Subscriptions
 * (YouTube channels and Spotify podcasts) has no media items or tags.
 */
export type WorkspaceScope = MediaScope | 'artist' | 'subscription'
/**
 * What the library selector shows. Tracks has its own browse, playlists and
 * imports navigation; it has no tag management or per-track metadata jobs.
 */
export type LibraryView = WorkspaceScope | 'track'

const trackViewPaths = ['/tracks', '/playlists']
const trackImportPaths = [
  '/imports',
  '/imports/spotify-playlists',
  '/imports/lastfm',
]
const trackUnsupportedPaths = ['/tags', '/providers']
/** Jobs and Providers sit once under System and filter by library. */
const systemPaths = ['/jobs', '/providers']
const subscriptionPaths = [
  '/subscriptions',
  '/channels',
  '/imports/youtube',
  '/imports/spotify-podcasts',
]

function isUnder(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`)
}

export function isSystemPath(path: string) {
  return systemPaths.some((root) => isUnder(path, root))
}

/** The library filter of a System page; null means every library. */
export function systemLibraryFilter(
  value: string | null,
): WorkspaceScope | null {
  return value === 'album' ||
    value === 'film' ||
    value === 'artist' ||
    value === 'subscription'
    ? value
    : null
}

export function parseLibraryView(value: string | null): LibraryView | null {
  return value === 'track' ? value : systemLibraryFilter(value)
}

export function mediaScope(value: string | null): MediaScope {
  return value === 'album' ? 'album' : 'film'
}

/** The library a path belongs to whatever `mediaType` says, if any. */
function pathMediaScope(path: string): MediaScope | null {
  if (
    isUnder(path, '/albums') ||
    isUnder(path, '/artists') ||
    trackViewPaths.some((root) => isUnder(path, root)) ||
    path === '/imports/albums' ||
    path === '/imports/spotify' ||
    path === '/imports/spotify-playlists' ||
    path === '/imports/lastfm'
  )
    return 'album'
  if (isUnder(path, '/films') || isUnder(path, '/people')) return 'film'
  return null
}

export function mediaScopeForPath(
  path: string,
  value: string | null,
): MediaScope {
  return pathMediaScope(path) ?? mediaScope(value)
}

export function workspaceScopeForPath(
  path: string,
  value: string | null,
): WorkspaceScope {
  if (isUnder(path, '/collections')) return mediaScope(value)
  if (isUnder(path, '/artists')) return 'artist'
  if (subscriptionPaths.some((root) => isUnder(path, root)))
    return 'subscription'
  return (
    pathMediaScope(path) ??
    (value === 'subscription' || value === 'artist' ? value : mediaScope(value))
  )
}

export function libraryViewForPath(
  path: string,
  value: string | null,
): LibraryView {
  if (isUnder(path, '/playlists') && value === 'album') return 'album'
  if (isUnder(path, '/artists')) return 'artist'
  return trackViewPaths.some((root) => isUnder(path, root)) ||
    (value === 'track' &&
      (isUnder(path, '/imports') ||
        isUnder(path, '/user') ||
        isUnder(path, '/jobs') ||
        trackUnsupportedPaths.some((root) => isUnder(path, root))))
    ? 'track'
    : workspaceScopeForPath(path, value)
}

/** Invalid track-scoped links must not render another library's workspace. */
export function trackScopeRedirect(path: string, value: string | null) {
  if (value !== 'track') return null
  if (trackUnsupportedPaths.some((root) => isUnder(path, root)))
    return '/tracks'
  if (isUnder(path, '/imports') && !trackImportPaths.includes(path))
    return scopedHref('/imports/spotify-playlists', 'track')
  return null
}

export function scopedHref(href: string, mediaType: LibraryView) {
  const hashIndex = href.indexOf('#')
  const hash = hashIndex < 0 ? '' : href.slice(hashIndex)
  const destination = hashIndex < 0 ? href : href.slice(0, hashIndex)
  const [path, query] = destination.split('?')
  const params = new URLSearchParams(query)
  params.set('mediaType', mediaType)
  return `${path}?${params}${hash}`
}

function libraryHome(scope: LibraryView) {
  return scope === 'track'
    ? '/tracks'
    : scope === 'artist'
      ? '/artists'
      : scope === 'album'
        ? '/albums'
        : scope === 'film'
          ? '/films'
          : '/subscriptions'
}

export function libraryMatchesHref(view: LibraryView) {
  return `${libraryHome(view)}/matches`
}

export function switchMediaScopeHref(
  path: string,
  search: string,
  mediaType: WorkspaceScope,
) {
  const current = new URLSearchParams(search)
  if (workspaceScopeForPath(path, current.get('mediaType')) === mediaType)
    return `${path}${current.size ? `?${current}` : ''}`

  if (
    isUnder(path, '/collections') &&
    (mediaType === 'album' || mediaType === 'film')
  )
    return scopedHref('/collections', mediaType)

  if (
    [
      '/albums',
      '/films',
      '/collections',
      '/subscriptions',
      '/artists',
      '/people',
      '/channels',
    ].some((root) => isUnder(path, root))
  )
    return libraryHome(mediaType)

  const imports = isUnder(path, '/imports')
  let destination = imports ? '/imports' : path
  // Artist enrichment shares Jobs, while artists have no imports or tags.
  if (mediaType === 'artist') {
    if (!isUnder(path, '/jobs')) return libraryHome(mediaType)
    destination =
      path === '/jobs/metadata' ||
      path === '/jobs/new' ||
      path === '/jobs/refresh'
        ? '/jobs/metadata'
        : '/jobs'
  } else if (
    isUnder(path, '/jobs') &&
    !['/jobs', '/jobs/metadata', '/jobs/new', '/jobs/refresh'].includes(path)
  ) {
    destination = '/jobs'
  }
  // Subscriptions has Imports, Jobs and Providers, but no Tags or metadata jobs.
  if (mediaType === 'subscription') {
    if (imports) destination = '/imports/youtube'
    else if (isUnder(path, '/jobs')) destination = '/jobs'
    else if (!isUnder(path, '/providers')) return libraryHome(mediaType)
  }
  const params = new URLSearchParams()
  // Status applies to every library; IDs, providers and filters do not.
  if (destination === '/jobs' && current.has('status'))
    params.set('status', current.get('status') ?? '')
  return scopedHref(
    `${destination}${params.size ? `?${params}` : ''}`,
    mediaType,
  )
}

export function switchLibraryHref(
  path: string,
  search: string,
  view: LibraryView,
) {
  // System pages are not part of a library: choosing one opens its home.
  if (isSystemPath(path)) return libraryHome(view)
  const current = new URLSearchParams(search)
  const shown = libraryViewForPath(path, current.get('mediaType'))
  if (shown === view) return `${path}${current.size ? `?${current}` : ''}`
  if (path === libraryMatchesHref(shown)) return libraryMatchesHref(view)
  if (view === 'artist') return switchMediaScopeHref(path, search, view)
  if (isUnder(path, '/playlists'))
    return view === 'album' || view === 'track'
      ? scopedHref(`${path}${current.size ? `?${current}` : ''}`, view)
      : libraryHome(view)
  if (
    path !== '/imports' &&
    trackImportPaths.includes(path) &&
    ((shown === 'album' && view === 'track') ||
      (shown === 'track' && view === 'album'))
  )
    return scopedHref(path, view)
  if (view === 'track')
    return isUnder(path, '/imports')
      ? scopedHref('/imports/spotify-playlists', 'track')
      : '/tracks'
  if (shown === 'track')
    return isUnder(path, '/imports')
      ? scopedHref(
          view === 'subscription' ? '/imports/youtube' : '/imports',
          view,
        )
      : libraryHome(view)
  return switchMediaScopeHref(path, search, view)
}
