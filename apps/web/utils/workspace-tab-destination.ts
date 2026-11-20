const appOrigin = 'https://workspace.invalid'

// The authenticated App Router pages. Keep login, API, and static files outside
// this set so opening a workspace tab never starts a download or auth flow.
const appPagePaths = [
  /^\/(?:albums|artists|collections|films|jobs|people|playlists|providers|subscriptions|tracks)(?:\/[^/]+)?$/,
  /^\/channels\/[^/]+$/,
  /^\/mixes(?:\/[^/]+|\/shows\/[^/]+)?$/,
  /^\/imports(?:\/(?:albums|csv|lastfm|legacy|lotradio|nfo|nts|rinse|spotify-playlists|spotify-podcasts|spotify|youtube))?$/,
  /^\/tags(?:\/(?:all|hidden|hierarchy))?$/,
  /^\/(?:user|youtube(?:\/subscriptions)?)$/,
]

function pageHref(url: URL) {
  return url.pathname + url.search + url.hash
}

export function isWorkspaceHref(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\'))
    return false
  try {
    const url = new URL(href, appOrigin)
    // App Router decodes path segments before looking up dynamic routes.
    decodeURI(url.pathname)
    return (
      url.origin === appOrigin &&
      pageHref(url) === href &&
      appPagePaths.some((path) => path.test(url.pathname.replace(/\/$/, '')))
    )
  } catch {
    return false
  }
}

export function resolveWorkspaceHref(href: string, current: URL) {
  if (!href.trim() || href.trimStart().startsWith('#')) return null
  try {
    const url = new URL(href, current)
    const local = pageHref(url)
    if (url.origin !== current.origin || url.protocol !== current.protocol)
      return null
    if (url.username || url.password) return null
    if (
      url.hash &&
      url.pathname === current.pathname &&
      url.search === current.search
    )
      return null
    return isWorkspaceHref(local) ? local : null
  } catch {
    return null
  }
}

/** An explicit destination can differ from what a plain click does. */
export function workspaceTabLinkProps(href: string, label?: string) {
  return {
    'data-workspace-href': href,
    'data-workspace-label': label,
    'aria-keyshortcuts': 'Alt+Enter',
  }
}

type Gesture = Pick<
  MouseEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented'
> &
  (Pick<MouseEvent, 'button'> | Pick<KeyboardEvent, 'key' | 'isComposing'>)

export function isWorkspaceTabGesture(event: Gesture) {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.defaultPrevented &&
    ('button' in event
      ? event.button === 0
      : event.key === 'Enter' && !event.isComposing)
  )
}
