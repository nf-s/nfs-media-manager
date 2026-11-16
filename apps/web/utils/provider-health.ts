import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import {
  ProviderOverviewSchema,
  ProviderSummarySchema,
  type ProviderSummary,
  type ProviderOverviewItem,
  type ProviderWaiting,
} from '@repo/schemas/provider'
import type { StatusState } from '@repo/ui/components/ds/status'
import { formatUntil } from '@repo/ui/lib/format'
import { fetchApiData } from './api'
import type { WorkspaceScope } from './media-scope'

/** The provider catalog, shared with every page that names providers. */
export function providerListOptions(apiBaseUrl: string) {
  return queryOptions({
    queryKey: ['providers'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
        { signal },
      ),
  })
}

export function providerDisplayName(
  providers: readonly ProviderSummary[] | undefined,
  id: string,
) {
  return (
    providers?.find((item) => item.id === id)?.displayName ??
    (id === 'google-custom-search' ? 'Google Custom Search (legacy)' : id)
  )
}

/** Every provider's connection and queue state. Bounded and safe to poll. */
export function providerOverviewOptions(
  apiBaseUrl: string,
  mediaType: WorkspaceScope | null = null,
) {
  return queryOptions({
    queryKey: ['providers', 'overview', mediaType ?? 'all'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/overview${mediaType ? `?mediaType=${mediaType}` : ''}`,
        ProviderOverviewSchema,
        { signal },
      ),
    refetchInterval: 60_000,
  })
}

/** A provider the owner must act on: signed out, missing a key, or stopped. */
export function providerNeedsAttention(provider: ProviderOverviewItem) {
  return (
    provider.connection.state === 'needs-sign-in' ||
    provider.connection.state === 'needs-key' ||
    provider.queue.state === 'stopped'
  )
}

/** True when queued work cannot start until something changes. */
export function isBlockingWait(reason: ProviderWaiting['reason'] | null) {
  return reason !== null && reason !== 'queued' && reason !== 'concurrency'
}

/** Queued jobs held back by a blocked provider. */
export function blockedQueuedJobs(providers: readonly ProviderOverviewItem[]) {
  return providers.reduce(
    (total, provider) =>
      total +
      (isBlockingWait(provider.queue.reason) ? provider.jobs.queued : 0),
    0,
  )
}

/** One status for a provider's queue, in the shared vocabulary. */
export function providerQueueStatus(
  provider: ProviderOverviewItem,
  now: Date = new Date(),
): { state: StatusState; label: string; title: string | undefined } {
  const { queue, jobs } = provider
  const title = queue.detail ?? undefined
  if (queue.state === 'stopped')
    return { state: 'failed', label: 'Stopped', title }
  if (queue.state === 'paused')
    return { state: 'paused', label: 'Paused', title }
  if (queue.state === 'waiting' && isBlockingWait(queue.reason))
    return {
      state: 'waiting',
      label: queue.until ? `Until ${formatUntil(queue.until, now)}` : 'Waiting',
      title,
    }
  if (queue.state === 'running')
    return { state: 'running', label: 'Running', title }
  if (jobs.queued > 0)
    return { state: 'queued', label: `${jobs.queued} queued`, title }
  if (jobs.attention > 0)
    return {
      state: 'attention',
      label: `${jobs.attention} need attention`,
      title,
    }
  return { state: 'done', label: 'Idle', title }
}

/** How a waiting job or batch reads in a table cell. */
export function waitingLabel(waiting: ProviderWaiting, now: Date = new Date()) {
  return waiting.until
    ? `Resumes ${formatUntil(waiting.until, now)}`
    : waiting.detail
}
