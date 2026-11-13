'use client'

import { Fragment, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  libraryViewForPath,
  mediaScopeForPath,
  switchLibraryHref,
} from '@/utils/media-scope'

export function useMediaScope() {
  const path = usePathname()
  const params = useSearchParams()
  return mediaScopeForPath(path, params.get('mediaType'))
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
        if (next !== 'album' && next !== 'track' && next !== 'film') return
        router.push(switchLibraryHref(path, params.toString(), next))
      }}
    >
      <option value="album">Albums</option>
      <option value="track">Tracks</option>
      <option value="film">Films</option>
    </select>
  )
}

export function MediaScopeContent({ children }: { children: ReactNode }) {
  const mediaType = useMediaScope()
  return <Fragment key={mediaType}>{children}</Fragment>
}
