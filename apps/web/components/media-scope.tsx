'use client'

import { Fragment, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  libraryForPath,
  mediaScopeForPath,
  switchLibraryHref,
} from '@/utils/media-scope'

export function useMediaScope() {
  const path = usePathname()
  const params = useSearchParams()
  return mediaScopeForPath(path, params.get('mediaType'))
}

export function useLibrary() {
  const path = usePathname()
  const params = useSearchParams()
  return libraryForPath(path, params.get('mediaType'))
}

export function LibrarySelector() {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const library = useLibrary()
  return (
    <select
      aria-label="Library"
      className="library-selector"
      value={library}
      onChange={(event) => {
        const next = event.target.value
        if (next !== 'album' && next !== 'film' && next !== 'youtube') return
        router.push(switchLibraryHref(path, params.toString(), next))
      }}
    >
      <option value="album">Albums</option>
      <option value="film">Films</option>
      <option value="youtube">YouTube</option>
    </select>
  )
}

export function MediaScopeContent({ children }: { children: ReactNode }) {
  const mediaType = useMediaScope()
  return <Fragment key={mediaType}>{children}</Fragment>
}
