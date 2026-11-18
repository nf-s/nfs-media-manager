import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { BrowseFacetQuerySchema } from '@repo/schemas/browse'
import { FilmFilterOptionSchema } from '@repo/schemas/media'
import { fetchApiData } from './api'
import { clientQueryDefaults } from './query-cache'

/** Libraries with a `/facets` endpoint returning filter suggestions. */
export type BrowseFacetCollection =
  | 'albums'
  | 'films'
  | 'tracks'
  | 'artists'
  | 'subscriptions'

export function browseFacetOptions(
  apiBaseUrl: string,
  collection: BrowseFacetCollection,
  search: string,
  matches = false,
) {
  // Bound suggestion requests, not the user's full-text filter draft.
  const query = BrowseFacetQuerySchema.parse({ q: search.trim().slice(0, 200) })
  const params = new URLSearchParams({
    q: query.q ?? '',
    limitPerField: String(query.limitPerField),
  })
  return queryOptions({
    queryKey: [collection, matches ? 'match-facets' : 'facets', query.q ?? ''],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}${matches ? '/match-diagnostics' : ''}/facets?${params}`,
        z.array(FilmFilterOptionSchema),
        { signal },
      ),
    ...clientQueryDefaults,
  })
}
