import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import {
  BrowseFacetQuerySchema,
  formatBrowseFilterValue,
  formatTagLevelsParam,
  type TagLevels,
} from '@repo/schemas/browse'
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

type FacetOption = z.infer<typeof FilmFilterOptionSchema>

/** The server labels a key in Camelot; show it in the chosen notation. */
function withKeyLabel(option: FacetOption): FacetOption {
  if (option.field !== 'musicalKey') return option
  const field = option.label.slice(0, option.label.indexOf(': ') + 2)
  return {
    ...option,
    label: `${field}${formatBrowseFilterValue(option.field, option.value)}`,
  }
}

export function browseFacetOptions(
  apiBaseUrl: string,
  collection: BrowseFacetCollection,
  search: string,
  matches = false,
  /** Where the Tags suggestions are counted; left out for Auto. */
  tagLevels?: TagLevels,
  /** Albums and Films: count archived items, as the list does. */
  includeArchived = false,
  catalogParams?: Readonly<Record<string, string>>,
) {
  // Bound suggestion requests, not the user's full-text filter draft.
  const query = BrowseFacetQuerySchema.parse({ q: search.trim().slice(0, 200) })
  const endpoint = facetEndpoint(collection)
  const levels = formatTagLevelsParam(tagLevels)
  const params = new URLSearchParams({
    q: query.q ?? '',
    limitPerField: String(query.limitPerField),
    ...endpoint.params,
    ...(levels ? { tagLevels: levels } : {}),
    ...(includeArchived ? { includeArchived: 'true' } : {}),
    ...catalogParams,
  })
  return queryOptions({
    queryKey: [
      collection,
      matches ? 'match-facets' : 'facets',
      query.q ?? '',
      ...(levels ? [levels] : []),
      ...(includeArchived ? ['archived'] : []),
      ...(catalogParams && Object.keys(catalogParams).length
        ? [catalogParams]
        : []),
    ],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${endpoint.path}${matches ? '/match-diagnostics' : ''}/facets?${params}`,
        z.array(FilmFilterOptionSchema),
        { signal },
      ),
    // Applied on read, so cached suggestions follow a change of notation.
    select: (options: FacetOption[]) => options.map(withKeyLabel),
    ...clientQueryDefaults,
  })
}
