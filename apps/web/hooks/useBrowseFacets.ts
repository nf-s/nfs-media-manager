'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TagLevels } from '@repo/schemas/browse'
import {
  browseFacetOptions,
  type BrowseFacetCollection,
} from '@/utils/browse-facets'

export function useBrowseFacets(
  apiBaseUrl: string,
  collection: BrowseFacetCollection,
  draft: string,
  enabled = true,
  matches = false,
  tagLevels?: TagLevels,
) {
  const [search, setSearch] = useState('')
  const [activated, setActivated] = useState(false)
  const query = draft.trim()
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 200)
    return () => window.clearTimeout(timer)
  }, [query])
  const isDebouncing = search !== query
  const active = enabled && (activated || Boolean(query))
  const current = active && !isDebouncing
  const result = useQuery({
    ...browseFacetOptions(apiBaseUrl, collection, search, matches, tagLevels),
    enabled: current,
  })
  return {
    ...result,
    activate: () => setActivated(true),
    search,
    isDebouncing,
    isPending: active && result.isPending,
    isError: current && result.isError,
    data: current ? result.data : undefined,
  }
}
