'use client'

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import {
  ProviderLocalWorkerControlResultSchema,
  ProviderLocalWorkerControlSchema,
  ProviderLocalWorkerStatusSchema,
  type ProviderLocalWorkerStatus,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { Pill } from '@repo/ui/components/ds/pill'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'

const workerPath = (provider: string) =>
  `/api/v1/cloud/providers/${encodeURIComponent(provider)}/local-worker`
const workerKey = (provider: string) => ['providers', 'local-worker', provider]

export function providerLocalWorkerQuery(apiBaseUrl: string, id: string) {
  return queryOptions({
    queryKey: workerKey(id),
    enabled: id !== '',
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        workerPath(id),
        ProviderLocalWorkerStatusSchema,
        {
          signal,
        },
      ),
    staleTime: 5000,
    refetchInterval: (query) => (query.state.data?.active ? 5000 : 30_000),
  })
}

export function useProviderLocalWorker(provider: ProviderSummary | undefined) {
  const { apiBaseUrl } = useConfig()
  return useQuery(
    providerLocalWorkerQuery(
      apiBaseUrl,
      provider?.supportsLocalWorker ? provider.id : '',
    ),
  )
}

export function useProviderLocalWorkerMode(provider: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const queryKey = workerKey(provider)
  return useMutation({
    retry: false,
    mutationFn: (mode: ProviderLocalWorkerStatus['mode'] | 'review') =>
      fetchApiData(
        apiBaseUrl,
        workerPath(provider),
        ProviderLocalWorkerControlResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            ProviderLocalWorkerControlSchema.parse({ mode }),
          ),
        },
      ),
    onSuccess: async ({ status }, mode) => {
      await client.cancelQueries({ queryKey })
      client.setQueryData(queryKey, status)
      if (mode === 'review')
        await Promise.all([
          client.invalidateQueries({ queryKey: ['providers'], exact: true }),
          client.invalidateQueries({ queryKey: ['providers', 'overview'] }),
          client.invalidateQueries({ queryKey: ['jobs'] }),
        ])
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey })
    },
  })
}

export function useProviderLocalWorkerPair(provider: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const queryKey = workerKey(provider)
  const pendingToken = useRef<{ provider: string; token: string } | null>(null)
  const mountedProvider = useRef<string | null>(null)
  useEffect(() => {
    mountedProvider.current = provider
    return () => {
      mountedProvider.current = null
      pendingToken.current = null
    }
  }, [provider])
  const request = useMutation({
    retry: false,
    mutationFn: async () => {
      try {
        const { token, status } = await fetchApiData(
          apiBaseUrl,
          workerPath(provider),
          ProviderLocalWorkerControlResultSchema,
          {
            method: 'POST',
            cache: 'no-store',
            body: JSON.stringify(
              ProviderLocalWorkerControlSchema.parse({ mode: 'pair' }),
            ),
          },
        )
        if (!token) throw new Error()
        // Only status is returned to the mutation cache.
        if (mountedProvider.current === provider)
          pendingToken.current = { provider, token }
        return status
      } catch {
        throw new Error(
          'Could not pair the worker. Check the queue and worker status before trying again.',
        )
      }
    },
    onSuccess: async (status) => {
      await client.cancelQueries({ queryKey })
      client.setQueryData(queryKey, status)
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey })
    },
  })
  return {
    request,
    canDownload:
      request.isSuccess && pendingToken.current?.provider === provider,
    download() {
      const result = pendingToken.current
      if (result?.provider !== provider || !request.isSuccess) return
      const url = URL.createObjectURL(
        new Blob([result.token], { type: 'text/plain' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = 'local-worker-token.txt'
      document.body.appendChild(link)
      link.click()
      link.remove()
      pendingToken.current = null
      request.reset()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  }
}

export function ProviderLocalWorkerBadge({
  status,
}: {
  status: ProviderLocalWorkerStatus
}) {
  return (
    <span className="ds-actions" role="status">
      <Pill>{status.mode === 'local' ? 'Local' : 'Cloudflare'}</Pill>
      <span className="ds-help">{localWorkerLabel(status)}</span>
    </span>
  )
}

export function localWorkerLabel(status: ProviderLocalWorkerStatus) {
  return status.blocked
    ? 'Local worker needs review'
    : !status.paired
      ? 'Local worker not paired'
      : status.online
        ? 'Local worker online'
        : 'Local worker offline'
}
