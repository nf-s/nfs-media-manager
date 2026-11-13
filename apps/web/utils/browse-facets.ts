import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { BrowseFacetQuerySchema } from '@repo/schemas/browse'
import { FilmFilterOptionSchema } from '@repo/schemas/media'
import { fetchApiData } from './api'

/** Libraries with a `/facets` endpoint returning filter suggestions. */
export type BrowseFacetCollection =
  | 'albums'
  | 'films'
  | 'tracks'
  | 'subscriptions'

export function browseFacetOptions(
  apiBaseUrl: string,
  collection: BrowseFacetCollection,
  search: string,
) {
  // Bound suggestion requests, not the user's full-text filter draft.
  const query = BrowseFacetQuerySchema.parse({ q: search.trim().slice(0, 200) })
  const params = new URLSearchParams({
    q: query.q ?? '',
    limitPerField: String(query.limitPerField),
  })
  return queryOptions({
    queryKey: [collection, 'facets', query.q ?? ''],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/facets?${params}`,
        z.array(FilmFilterOptionSchema),
        { signal },
      ),
    staleTime: 60_000,
    // Search terms must not accumulate a full set of cached suggestion pages.
    gcTime: 0,
  })
}
