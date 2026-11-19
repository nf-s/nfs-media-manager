'use client'

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useDetailInspector } from '@/components/detail-inspector-context'
import { tagDetailId } from '@/utils/detail-inspector'

/** Opens the tag a `?tag=` link names in the detail panel and drops the parameter. */
export function useTagDetailParam(mediaType: 'album' | 'film') {
  const inspector = useDetailInspector()
  const selectedTagId = useSearchParams().get('tag')
  useEffect(() => {
    if (!selectedTagId || !inspector) return
    // On a fresh page load this runs before the router starts following
    // history changes: the address would change and the screen would not.
    // One task later the router follows them.
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(window.location.search)
      next.delete('tag')
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${next.size ? `?${next}` : ''}`,
      )
      inspector.open({ kind: 'tag', id: tagDetailId(mediaType, selectedTagId) })
    })
    return () => window.clearTimeout(timer)
  }, [selectedTagId, inspector, mediaType])
}
