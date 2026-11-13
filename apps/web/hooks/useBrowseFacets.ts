'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  browseFacetOptions,
  type BrowseFacetCollection,
} from '@/utils/browse-facets'

export function useBrowseFacets(
  apiBaseUrl: string,
  collection: BrowseFacetCollection,
  draft: string,
  enabled = true,
) {
  const [search, setSearch] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(draft.trim()), 200)
    return () => window.clearTimeout(timer)
  }, [draft])
  const result = useQuery({
    ...browseFacetOptions(apiBaseUrl, collection, search),
    enabled,
  })
  const isDebouncing = search !== draft.trim()
  return {
    ...result,
    search,
    isDebouncing,
    data: isDebouncing ? undefined : result.data,
  }
}
