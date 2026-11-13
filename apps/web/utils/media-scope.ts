export type MediaScope = 'album' | 'film'

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
    path === '/imports/albums' ||
    path === '/imports/spotify' ||
    path === '/imports/lastfm'
  )
    return 'album'
  if (path === '/films' || path.startsWith('/films/')) return 'film'
  return mediaScope(value)
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

/** The library selector's choice: a media scope, or YouTube, which has no media items. */
export type Library = MediaScope | 'youtube'

export function isYoutubePath(path: string) {
  return path === '/youtube' || path.startsWith('/youtube/')
}

export function libraryForPath(path: string, value: string | null): Library {
  return isYoutubePath(path) ? 'youtube' : mediaScopeForPath(path, value)
}

export function switchLibraryHref(
  path: string,
  search: string,
  library: Library,
) {
  if (library === 'youtube') {
    if (!isYoutubePath(path)) return '/youtube'
    const current = new URLSearchParams(search)
    return `${path}${current.size ? `?${current}` : ''}`
  }
  if (isYoutubePath(path)) return library === 'album' ? '/albums' : '/films'
  return switchMediaScopeHref(path, search, library)
}
