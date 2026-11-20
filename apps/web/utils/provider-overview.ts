import type { JobStatusFilter } from '@repo/schemas/job'
import { queryOptions } from '@tanstack/react-query'
import {
  ProviderLibrarySchema,
  ProviderOverviewSchema,
  type ProviderOverviewItem,
  type ProviderWaitReason,
} from '@repo/schemas/provider'
import type { StatusState } from '@repo/ui/components/ds/status'
import { formatUntil } from '@repo/ui/lib/format'
import { fetchApiData } from './api'
import { detailLocation } from './detail-inspector'

export type ProviderLibrary = ProviderOverviewItem['roles'][number]
export type ProviderLibraryFilter = Exclude<ProviderLibrary, 'account'>
export type ProviderTab = 'overview' | 'jobs' | 'settings'

/** The overview is bounded and safe to poll. */
export const PROVIDER_OVERVIEW_POLL_MS = 30_000

export const providerLibraryOptions: readonly {
  value: ProviderLibraryFilter | ''
  label: string
}[] = [
  { value: '', label: 'All libraries' },
  { value: 'album', label: 'Albums' },
  { value: 'film', label: 'Films' },
  { value: 'artist', label: 'Artists' },
  { value: 'subscription', label: 'Subscriptions' },
  { value: 'mix', label: 'Mixes' },
]

const roleLabels: Record<ProviderLibrary, string> = {
  album: 'Albums',
  film: 'Films',
  artist: 'Artists',
  subscription: 'Subscriptions',
  mix: 'Mixes',
  account: 'Account',
}

/** The library filter in the URL; anything else lists every provider. */
export function parseProviderLibrary(
  value: string | null,
): ProviderLibraryFilter | null {
  const parsed = ProviderLibrarySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function providerOverviewQuery(
  apiBaseUrl: string,
  library: ProviderLibraryFilter | null,
) {
  return queryOptions({
    queryKey: ['providers', 'overview', library ?? 'all'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/overview${library ? `?${new URLSearchParams({ mediaType: library })}` : ''}`,
        ProviderOverviewSchema,
        { signal },
      ),
    refetchInterval: PROVIDER_OVERVIEW_POLL_MS,
  })
}

export function providerHref(
  id: string,
  tab: ProviderTab = 'overview',
  search = '',
) {
  const path = `/providers/${encodeURIComponent(id)}`
  const params = new URLSearchParams(search)
  if (tab === 'overview') params.delete('tab')
  else params.set('tab', tab)
  return detailLocation(path, params)
}

export function parseProviderTab(value: string | null): ProviderTab {
  return value === 'jobs' || value === 'settings' ? value : 'overview'
}

/** The Jobs page filtered to one provider and, optionally, one status. */
export function providerJobsHref(id: string, status?: JobStatusFilter) {
  const params = new URLSearchParams({ provider: id })
  if (status) params.set('status', status)
  return `/jobs?${params}`
}

/**
 * Old links named the provider and tab in the query
 * (`/providers?provider=x&section=credentials`). They open the provider page.
 */
export function legacyProviderHref(params: URLSearchParams) {
  const id = params.get('provider')
  if (!id) return null
  const section = params.get('section')
  return providerHref(
    id,
    section === 'jobs'
      ? 'jobs'
      : section === 'credentials' || section === 'settings'
        ? 'settings'
        : 'overview',
  )
}

/** What the provider is for: its description, or the libraries it supplies. */
export function providerPurpose(item: ProviderOverviewItem) {
  return (
    item.description.trim() ||
    item.roles.map((role) => roleLabels[role]).join(', ')
  )
}

export function providerRoleLabel(role: ProviderLibrary) {
  return roleLabels[role]
}

type StatusView = { state: StatusState; label: string; title?: string }

export function connectionStatus(
  connection: ProviderOverviewItem['connection'],
): StatusView {
  const title = connection.detail ?? undefined
  switch (connection.state) {
    case 'connected':
      return {
        state: 'done',
        label: connection.method === 'key' ? 'Key set' : 'Connected',
        title,
      }
    case 'needs-sign-in':
      return { state: 'attention', label: 'Needs sign-in', title }
    case 'needs-key':
      return { state: 'attention', label: 'Needs key', title }
    case 'not-required':
      return { state: 'never', label: 'Not required', title }
    case 'unavailable':
      return { state: 'never', label: 'Unavailable', title }
  }
}

const reasonLabels: Record<ProviderWaitReason, string> = {
  'access-denied': 'access denied',
  stopped: 'stopped',
  paused: 'paused',
  'not-configured': 'not configured',
  'worker-offline': 'worker offline',
  cooldown: 'cooldown',
  budget: 'budget used',
  'rate-limit': 'rate limit',
  concurrency: 'all slots busy',
  queued: 'next in line',
}

/** Queue state with its reason or time in the label, and the detail as the tooltip. */
export function queueStatus(
  queue: ProviderOverviewItem['queue'],
  now: Date = new Date(),
): StatusView {
  const title = queue.detail ?? undefined
  switch (queue.state) {
    case 'running':
      return { state: 'running', label: 'Running', title }
    case 'idle':
      return { state: 'done', label: 'Idle', title }
    case 'paused':
      return { state: 'paused', label: 'Paused', title }
    case 'stopped':
      return {
        state: 'attention',
        label:
          queue.reason === 'access-denied'
            ? 'Stopped · access denied'
            : 'Stopped',
        title,
      }
    case 'waiting':
      return {
        state: 'waiting',
        label: queue.until
          ? `Waiting until ${formatUntil(queue.until, now)}`
          : queue.reason
            ? `Waiting · ${reasonLabels[queue.reason]}`
            : 'Waiting',
        title,
      }
  }
}

/** A queue that is held back by something other than its own turn. */
export function queueBlocked(queue: ProviderOverviewItem['queue']) {
  return (
    queue.state === 'paused' ||
    queue.state === 'stopped' ||
    (queue.state === 'waiting' &&
      queue.reason !== null &&
      queue.reason !== 'queued' &&
      queue.reason !== 'concurrency')
  )
}

export function connectionNeedsAction(
  connection: ProviderOverviewItem['connection'],
) {
  return (
    connection.state === 'needs-sign-in' || connection.state === 'needs-key'
  )
}

export function providerNeedsAttention(item: ProviderOverviewItem) {
  return (
    connectionNeedsAction(item.connection) ||
    queueBlocked(item.queue) ||
    item.jobs.attention > 0
  )
}

/** The cooldown end the clear request must name, while one is active. */
export function activeCooldownUntil(
  queue: ProviderOverviewItem['queue'],
  now: Date = new Date(),
) {
  return queue.reason === 'cooldown' &&
    queue.until &&
    Date.parse(queue.until) > now.getTime()
    ? queue.until
    : null
}

export function runsOnLabel(
  item: Pick<ProviderOverviewItem, 'runsOn' | 'worker'>,
) {
  if (item.runsOn === 'server') return 'Server'
  if (!item.worker) return 'Local worker'
  return `Local worker · ${
    item.worker.blocked
      ? 'needs review'
      : !item.worker.paired
        ? 'not paired'
        : item.worker.online
          ? 'online'
          : 'offline'
  }`
}

export function budgetShare(
  budget: NonNullable<ProviderOverviewItem['budget']>,
) {
  return Math.max(
    0,
    Math.min(100, Math.round((budget.used / budget.limit) * 100)),
  )
}
