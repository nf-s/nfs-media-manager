'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { JobActivitySchema } from '@repo/schemas/job'
import { Stats } from '@repo/ui/components/ds/facts'
import { Status } from '@repo/ui/components/ds/status'
import { Toolbar } from '@repo/ui/components/ds/toolbar'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { jobActivityPollInterval } from '@/utils/job-cache'
import { systemLibraryFilter } from '@/utils/media-scope'
import {
  blockedQueuedJobs,
  providerOverviewOptions,
  providerQueueStatus,
} from '@/utils/provider-health'
import { useConfig } from './providers'

/** The link that filters the jobs table to one status, keeping the library. */
function statusHref(status: string, library: string | null) {
  const params = new URLSearchParams({ status })
  if (library) params.set('mediaType', library)
  return `/jobs?${params}`
}

/**
 * The top of Jobs: what is queued, running, held back by a provider and
 * needing attention, then each busy or blocked provider's queue.
 */
export default function JobsHealth() {
  const { apiBaseUrl } = useConfig()
  const params = useSearchParams()
  const library = systemLibraryFilter(params.get('mediaType'))
  const activity = useQuery({
    queryKey: ['job-activity'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/scrape/jobs/activity',
        JobActivitySchema,
      ),
    refetchInterval: (query) => jobActivityPollInterval(query.state.data),
    staleTime: 0,
  })
  const overview = useQuery(providerOverviewOptions(apiBaseUrl, library))
  const counts = library
    ? activity.data?.libraries.find((entry) => entry.mediaType === library)
    : activity.data
  const providers = overview.data?.providers ?? []
  const shown = providers.filter((provider) => {
    const status = providerQueueStatus(provider)
    return status.state !== 'done'
  })
  const figure = (value: number | undefined, status: string, label: string) =>
    value === undefined ? (
      <span className="ds-muted">{EMPTY_VALUE}</span>
    ) : (
      <Link
        href={statusHref(status, library)}
        aria-label={`${formatCount(value)} ${label}`}
      >
        {formatCount(value)}
      </Link>
    )
  const waiting = overview.data ? blockedQueuedJobs(providers) : undefined
  return (
    <>
      <Toolbar className="ops-health" role="group" aria-label="Job summary">
        <Stats
          items={[
            {
              label: 'queued',
              value: figure(counts?.queued, 'queued', 'queued'),
            },
            {
              label: 'running',
              value: figure(counts?.running, 'running', 'running'),
              tone: counts?.running ? 'attention' : undefined,
            },
            {
              label: 'waiting',
              value:
                waiting === undefined ? (
                  <span className="ds-muted">{EMPTY_VALUE}</span>
                ) : (
                  formatCount(waiting)
                ),
              tone: waiting ? 'attention' : undefined,
            },
            {
              label: 'need attention',
              value: figure(counts?.failed, 'attention', 'need attention'),
              tone: counts?.failed ? 'danger' : undefined,
            },
          ]}
        />
      </Toolbar>
      {shown.length > 0 && (
        <div className="ds-strip" role="list" aria-label="Provider queues">
          {shown.map((provider) => {
            const status = providerQueueStatus(provider)
            return (
              <Link
                key={provider.id}
                role="listitem"
                href={`/providers/${encodeURIComponent(provider.id)}`}
                className="ds-health"
              >
                {provider.name}
                <Status state={status.state} title={status.title}>
                  {status.label}
                </Status>
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}
