'use client'

import {
  Fragment,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  isSystemPath,
  libraryViewForPath,
  mediaScopeForPath,
  parseLibraryView,
  switchLibraryHref,
  trackScopeRedirect,
  workspaceScopeForPath,
  type Library,
} from '@/utils/media-scope'

export function useMediaScope() {
  const path = usePathname()
  const params = useSearchParams()
  return mediaScopeForPath(path, params.get('mediaType'))
}

/** The active workspace, including artist enrichment jobs. */
export function useWorkspaceScope() {
  const path = usePathname()
  const params = useSearchParams()
  return workspaceScopeForPath(path, params.get('mediaType'))
}

export function useLibraryView() {
  const path = usePathname()
  const params = useSearchParams()
  return libraryViewForPath(path, params.get('mediaType'))
}

const lastLibraryKey = 'media-manager:library'
const lastLibraryListeners = new Set<() => void>()
let lastLibrary: Library | null = null

export function readLastLibrary(): Library {
  if (lastLibrary === null) {
    try {
      lastLibrary =
        parseLibraryView(window.sessionStorage.getItem(lastLibraryKey)) ??
        'album'
    } catch {
      lastLibrary = 'album'
    }
  }
  return lastLibrary
}

export function rememberLibrary(view: Library) {
  if (readLastLibrary() === view) return
  lastLibrary = view
  try {
    window.sessionStorage.setItem(lastLibraryKey, view)
  } catch {
    // The rail still remembers the library for this page load.
  }
  for (const listener of lastLibraryListeners) listener()
}

function subscribeLastLibrary(listener: () => void) {
  lastLibraryListeners.add(listener)
  return () => {
    lastLibraryListeners.delete(listener)
  }
}

/**
 * The library the rail shows. Jobs and Providers belong to no library, so the
 * rail keeps the library that was open before them.
 */
export function useRailLibraryView(): Library {
  const path = usePathname()
  const view = useLibraryView()
  const system = isSystemPath(path)
  const last = useSyncExternalStore<Library>(
    subscribeLastLibrary,
    readLastLibrary,
    () => 'album',
  )
  useEffect(() => {
    if (!system) rememberLibrary(view)
  }, [system, view])
  return system ? last : view
}

export function LibrarySelector() {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const view = useRailLibraryView()
  return (
    <select
      aria-label="Library"
      className="ds-select ds-library"
      data-size="md"
      value={view}
      onChange={(event) => {
        const next = parseLibraryView(event.target.value)
        if (!next) return
        router.push(switchLibraryHref(path, params.toString(), next))
      }}
    >
      <option value="album">Albums</option>
      <option value="track">Tracks</option>
      <option value="artist">Artists</option>
      <option value="film">Films</option>
      <option value="subscription">Subscriptions</option>
      <option value="mix">Mixes</option>
    </select>
  )
}

export function MediaScopeContent({ children }: { children: ReactNode }) {
  const path = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const scope = useLibraryView()
  const destination = trackScopeRedirect(path, params.get('mediaType'))
  useEffect(() => {
    if (destination) router.replace(destination)
  }, [destination, router])
  if (destination) return null
  // A System page keeps its state when its library filter changes.
  return (
    <Fragment key={isSystemPath(path) ? 'system' : scope}>{children}</Fragment>
  )
}
