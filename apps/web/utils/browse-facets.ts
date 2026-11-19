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
  | 'mixes'

/** Mixes are read from the Subscriptions endpoints with their library named. */
function facetEndpoint(collection: BrowseFacetCollection): {
  path: string
  params: Record<string, string>
} {
  return collection === 'mixes'
    ? { path: 'subscriptions', params: { library: collection } }
    : { path: collection, params: {} }
}

export function browseFacetOptions(
  apiBaseUrl: string,
  collection: BrowseFacetCollection,
  search: string,
  matches = false,
) {
  // Bound suggestion requests, not the user's full-text filter draft.
  const query = BrowseFacetQuerySchema.parse({ q: search.trim().slice(0, 200) })
  const endpoint = facetEndpoint(collection)
  const params = new URLSearchParams({
    q: query.q ?? '',
    limitPerField: String(query.limitPerField),
    ...endpoint.params,
  })
  return queryOptions({
    queryKey: [collection, matches ? 'match-facets' : 'facets', query.q ?? ''],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${endpoint.path}${matches ? '/match-diagnostics' : ''}/facets?${params}`,
        z.array(FilmFilterOptionSchema),
        { signal },
      ),
    ...clientQueryDefaults,
  })
}
