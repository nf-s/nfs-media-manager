import { hashKey, type QueryClient } from '@tanstack/react-query'
import {
  RatingsAgreementPageSchema,
  RatingsCalculationSchema,
  RatingsComparePageSchema,
  type RatingsCompareRequest,
} from '@repo/schemas/ratings-charts'
import {
  RatingsRankingRequestSchema,
  type RatingsRankingRow,
  type RatingsSourcesRequest,
} from '@repo/schemas/ratings-explorer'
import { fetchApiData } from './api'
import { clientCacheStaleTime } from './query-cache'

export type ChartView = 'agreement' | 'compare'
export type ChartAxes = Pick<RatingsCompareRequest, 'x' | 'y'>
export function ratingChartsKey(
  view: ChartView,
  request: RatingsSourcesRequest,
  axes: ChartAxes,
) {
  return [
    request.library + 's',
    'ratings-explorer',
    view,
    view === 'agreement' ? request : { ...request, ...axes },
  ]
}
export function fetchAgreement(
  url: string,
  request: RatingsSourcesRequest,
  signal: AbortSignal,
) {
  return fetchApiData(
    url,
    '/api/v1/ratings/agreement',
    RatingsAgreementPageSchema,
    {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    },
  )
}
export function fetchCompare(
  url: string,
  request: RatingsCompareRequest,
  signal: AbortSignal,
) {
  return fetchApiData(
    url,
    '/api/v1/ratings/compare',
    RatingsComparePageSchema,
    {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    },
  )
}

/** A ranking page already contains the calculation for every displayed item. */
export function fetchChartCalculation(
  client: QueryClient,
  url: string,
  request: RatingsSourcesRequest,
  id: string,
  signal: AbortSignal,
) {
  const pages = client.getQueriesData<{ items: RatingsRankingRow[] }>({
    queryKey: [request.library + 's', 'ratings-explorer'],
    predicate(query) {
      if (
        query.isStaleByTime(clientCacheStaleTime) ||
        typeof query.queryKey[3] !== 'number'
      )
        return false
      const result = RatingsRankingRequestSchema.safeParse(query.queryKey[2])
      if (!result.success) return false
      // Display filters determine membership. Each member's calculation uses
      // the library-wide normalization and the same scoring settings.
      return hashKey([result.data.settings]) === hashKey([request.settings])
    },
  })
  for (const [, page] of pages) {
    const row = page?.items.find((item) => item.id === id)
    if (row) return Promise.resolve(row)
  }
  return fetchApiData(
    url,
    '/api/v1/ratings/calculation',
    RatingsCalculationSchema,
    {
      method: 'POST',
      body: JSON.stringify({ ...request, id }),
      signal,
    },
  )
}
