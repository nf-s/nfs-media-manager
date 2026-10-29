'use client'

import { Fragment, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { mediaScopeForPath, switchMediaScopeHref } from '@/utils/media-scope'

export function useMediaScope() {
  const path = usePathname()
  const params = useSearchParams()
  return mediaScopeForPath(path, params.get('mediaType'))
}

export function LibrarySelector() {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const mediaType = useMediaScope()
  return (
    <select
      aria-label="Library"
      className="library-selector"
      value={mediaType}
      onChange={(event) => {
        const next = event.target.value
        if (next !== 'album' && next !== 'film') return
        router.push(switchMediaScopeHref(path, params.toString(), next))
      }}
    >
      <option value="album">Albums</option>
      <option value="film">Films</option>
    </select>
  )
}

export function MediaScopeContent({ children }: { children: ReactNode }) {
  const mediaType = useMediaScope()
  return <Fragment key={mediaType}>{children}</Fragment>
}
