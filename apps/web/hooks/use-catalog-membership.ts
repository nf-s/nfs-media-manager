'use client'

import { useQuery } from '@tanstack/react-query'
import {
  CatalogMembershipInputSchema,
  CatalogMembershipResultSchema,
  type CatalogMembershipInput,
} from '@repo/schemas/manual-add'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'

export function useCatalogMembership(
  items: readonly CatalogMembershipInput['items'][number][],
) {
  const { apiBaseUrl } = useConfig()
  const entries = new Map(
    items.map((item) => [`${item.mediaType}:${item.externalId}`, item]),
  )
  const sorted = [...entries.keys()].sort()
  return useQuery({
    queryKey: ['catalog-membership', sorted],
    enabled: entries.size > 0,
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
            CatalogMembershipInputSchema.parse({
              items: sorted.map((key) => entries.get(key)),
            }),
          ),
        },
      ),
  })
}
