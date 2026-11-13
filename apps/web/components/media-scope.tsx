'use client'

import { Fragment, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  libraryViewForPath,
  mediaScopeForPath,
  switchLibraryHref,
  workspaceScopeForPath,
} from '@/utils/media-scope'

export function useMediaScope() {
  const path = usePathname()
  const params = useSearchParams()
  return mediaScopeForPath(path, params.get('mediaType'))
}

/** The library Imports, Jobs and Providers show: albums, films or subscriptions. */
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

export function LibrarySelector() {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const view = useLibraryView()
  return (
    <select
      aria-label="Library"
      className="library-selector"
      value={view}
      onChange={(event) => {
        const next = event.target.value
        if (
          next !== 'album' &&
          next !== 'track' &&
          next !== 'film' &&
          next !== 'subscription'
        )
          return
        router.push(switchLibraryHref(path, params.toString(), next))
      }}
    >
      <option value="album">Albums</option>
      <option value="track">Tracks</option>
      <option value="film">Films</option>
      <option value="subscription">Subscriptions</option>
    </select>
  )
}

export function MediaScopeContent({ children }: { children: ReactNode }) {
  const scope = useWorkspaceScope()
  return <Fragment key={scope}>{children}</Fragment>
}
