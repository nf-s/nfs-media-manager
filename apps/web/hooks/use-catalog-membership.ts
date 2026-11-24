'use client'

import { useQuery } from '@tanstack/react-query'
import {
  CatalogMembershipInputSchema,
  CatalogMembershipResultSchema,
  type CatalogMembershipInput,
} from '@repo/schemas/manual-add'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'

export function catalogMembershipQuery(
  items: readonly CatalogMembershipInput['items'][number][],
) {
  const entries = new Map<string, CatalogMembershipInput['items'][number]>()
  for (const item of items) {
    const key = `${item.mediaType}:${item.externalId}`
    if (!entries.has(key) || (item.mediaType === 'track' && item.recording))
      entries.set(key, item)
  }
  const sorted = [...entries.keys()].sort()
  const catalog = sorted.flatMap((key) => entries.get(key) ?? [])
  const withRecording = catalog.filter(
    (item) => item.mediaType === 'track' && item.recording,
  )
  const queryKey = withRecording.length
    ? ['catalog-membership', sorted, withRecording]
    : ['catalog-membership', sorted]
  return { queryKey, catalog }
}

export function useCatalogMembership(
  items: readonly CatalogMembershipInput['items'][number][],
) {
  const { apiBaseUrl } = useConfig()
  const { queryKey, catalog } = catalogMembershipQuery(items)
  return useQuery({
    queryKey,
    enabled: catalog.length > 0,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/manual-add/membership',
        CatalogMembershipResultSchema,
        {
          method: 'POST',
          signal,
          body: JSON.stringify(
            CatalogMembershipInputSchema.parse({ items: catalog }),
          ),
        },
      ),
  })
}
