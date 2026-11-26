import {
  RatingsRankingPageSchema,
  RatingsSourcesPageSchema,
  type RatingsRankingRequest,
  type RatingsSourcesRequest,
} from '@repo/schemas/ratings-explorer'
import { fetchApiData } from './api'

export function fetchRatingsRanking(
  apiBaseUrl: string,
  request: RatingsRankingRequest,
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    '/api/v1/ratings/ranking',
    RatingsRankingPageSchema,
    {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    },
  )
}

export function fetchRatingsSources(
  apiBaseUrl: string,
  request: RatingsSourcesRequest,
  signal: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    '/api/v1/ratings/sources',
    RatingsSourcesPageSchema,
    { method: 'POST', body: JSON.stringify(request), signal },
  )
}
