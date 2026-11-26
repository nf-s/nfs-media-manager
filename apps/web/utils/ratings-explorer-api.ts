import {
  RatingsRankingPageSchema,
  type RatingsRankingRequest,
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
