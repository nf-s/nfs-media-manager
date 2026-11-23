'use client'

import { useQuery } from '@tanstack/react-query'
import { useConfig } from '@/components/providers'
import {
  providerDisplayName,
  providerListOptions,
} from '@/utils/provider-health'

/**
 * A Provider filter value is an ID. Name it as the provider catalog does,
 * the same source the server labels Provider suggestions from. Reads the
 * catalog only while `enabled`; until then, and for an unknown ID, the ID.
 */
export function useProviderDisplayName(enabled: boolean) {
  const { apiBaseUrl } = useConfig()
  const providers = useQuery({
    ...providerListOptions(apiBaseUrl),
    enabled,
  })
  return (id: string) => providerDisplayName(providers.data, id)
}
