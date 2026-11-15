'use client'

import { skipToken, useQuery } from '@tanstack/react-query'
import { SubscriptionSourceDetailSchema } from '@repo/schemas/subscriptions'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'

export function useSubscriptionSource(id?: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['subscriptions', 'source', id],
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
