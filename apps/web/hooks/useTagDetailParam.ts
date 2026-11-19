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
    const next = new URLSearchParams(window.location.search)
    next.delete('tag')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${next.size ? `?${next}` : ''}`,
    )
    inspector.open({ kind: 'tag', id: tagDetailId(mediaType, selectedTagId) })
  }, [selectedTagId, inspector, mediaType])
}
