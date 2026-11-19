'use client'

import { skipToken, useQuery } from '@tanstack/react-query'
import {
  SubscriptionSourceDetailSchema,
  type SubscriptionLibrary,
} from '@repo/schemas/subscriptions'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import { subscriptionLibraryPages } from '@/utils/subscriptions'

/** One channel, podcast or show; its ID alone finds it, the library names the cache entry. */
export function useSubscriptionSource(
  id?: string,
  library: SubscriptionLibrary = 'subscriptions',
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: [subscriptionLibraryPages[library].collection, 'source', id],
    queryFn: id
      ? ({ signal }) =>
          fetchApiData(
            apiBaseUrl,
            `/api/v1/subscriptions/sources/${encodeURIComponent(id)}?size=1`,
            SubscriptionSourceDetailSchema,
            { signal },
          )
      : skipToken,
  })
}
