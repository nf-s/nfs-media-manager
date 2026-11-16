'use client'

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ProviderLocalWorkerControlResultSchema,
  ProviderLocalWorkerControlSchema,
  ProviderLocalWorkerStatusSchema,
  type ProviderLocalWorkerStatus,
  type ProviderSummary,
} from '@repo/schemas/provider'
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
    mutationFn: (mode: ProviderLocalWorkerStatus['mode']) =>
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
    onSuccess: async ({ status }) => {
      await client.cancelQueries({ queryKey })
      client.setQueryData(queryKey, status)
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey })
    },
  })
}

export function ProviderLocalWorkerBadge({
  status,
}: {
  status: ProviderLocalWorkerStatus
}) {
  return (
    <div
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
      role="status"
    >
      <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        {status.mode === 'local' ? 'Local' : 'Cloudflare'}
      </span>
      <span className="text-xs text-slate-600">
        {status.blocked
          ? 'Local worker needs review'
          : !status.paired
            ? 'Local worker not paired'
            : status.online
              ? 'Local worker online'
              : 'Local worker offline'}
      </span>
    </div>
  )
}
