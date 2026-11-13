export type MediaScope = 'album' | 'film'
/**
 * What the library selector shows. Tracks and playlists are a view of the
 * album library: Tags, Imports, Jobs and Providers stay in the album scope.
 */
export type LibraryView = MediaScope | 'track'

const trackViewPaths = ['/tracks', '/playlists']

function isUnder(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`)
}

export function mediaScope(value: string | null): MediaScope {
  return value === 'album' ? 'album' : 'film'
}

export function mediaScopeForPath(
  path: string,
  value: string | null,
): MediaScope {
  if (
    path === '/albums' ||
    path.startsWith('/albums/') ||
    trackViewPaths.some((root) => isUnder(path, root)) ||
    path === '/imports/albums' ||
    path === '/imports/spotify' ||
    path === '/imports/spotify-playlists' ||
    path === '/imports/lastfm'
  )
    return 'album'
  if (path === '/films' || path.startsWith('/films/')) return 'film'
  return mediaScope(value)
}

export function libraryViewForPath(
  path: string,
  value: string | null,
): LibraryView {
  return trackViewPaths.some((root) => isUnder(path, root))
    ? 'track'
    : mediaScopeForPath(path, value)
}

export function scopedHref(href: string, mediaType: MediaScope) {
  const hashIndex = href.indexOf('#')
  const hash = hashIndex < 0 ? '' : href.slice(hashIndex)
  const destination = hashIndex < 0 ? href : href.slice(0, hashIndex)
  const [path, query] = destination.split('?')
  const params = new URLSearchParams(query)
  params.set('mediaType', mediaType)
  return `${path}?${params}${hash}`
}

export function switchMediaScopeHref(
  path: string,
  search: string,
  mediaType: MediaScope,
) {
  const current = new URLSearchParams(search)
  if (mediaScopeForPath(path, current.get('mediaType')) === mediaType)
    return `${path}${current.size ? `?${current}` : ''}`

  if (
    path === '/albums' ||
    path.startsWith('/albums/') ||
    path === '/films' ||
    path.startsWith('/films/')
  )
    return mediaType === 'album' ? '/albums' : '/films'

  const destination =
    path === '/imports' || path.startsWith('/imports/') ? '/imports' : path
  const params = new URLSearchParams()
  // Status applies to both libraries; IDs, providers and filters do not.
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
  const current = new URLSearchParams(search)
  const shown = libraryViewForPath(path, current.get('mediaType'))
  if (shown === view) return `${path}${current.size ? `?${current}` : ''}`
  if (view === 'track') return '/tracks'
  if (shown === 'track') return view === 'album' ? '/albums' : '/films'
  return switchMediaScopeHref(path, search, view)
}
