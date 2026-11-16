'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  ProviderSummarySchema,
  type ProviderOverviewItem,
} from '@repo/schemas/provider'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import {
  PageHead,
  Select,
  Toolbar,
  ToolbarCount,
} from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import {
  connectionNeedsAction,
  connectionStatus,
  parseProviderLibrary,
  providerHref,
  providerLibraryOptions,
  providerNeedsAttention,
  providerOverviewQuery,
  queueBlocked,
  queueStatus,
} from '@/utils/provider-overview'
import { useConfig } from '../providers'
import { ProviderOverviewTable } from '../provider-overview-table'

/** A provider that needs the owner, with the sentence that says why. */
function ProviderProblem({ item }: { item: ProviderOverviewItem }) {
  const blocked = queueBlocked(item.queue)
  const signIn = connectionNeedsAction(item.connection)
  const reason = blocked
    ? (item.queue.detail ?? queueStatus(item.queue).label)
    : (item.connection.detail ?? connectionStatus(item.connection).label)
  const queued =
    blocked && item.jobs.queued > 0
      ? ` ${formatItemCount(item.jobs.queued, { one: 'job is', other: 'jobs are' })} queued.`
      : ''
  return (
    <Notice
      tone={signIn || item.queue.state === 'stopped' ? 'danger' : 'attention'}
      action={
        <Button size="xs" asChild>
          <Link
            href={providerHref(
              item.id,
              item.connection.state === 'needs-key' ? 'settings' : 'overview',
            )}
          >
            {item.connection.state === 'needs-key' ? 'Add key' : 'Open'}
          </Link>
        </Button>
      }
    >
      {item.name}: {reason}
      {queued}
    </Notice>
  )
}

export default function ProvidersPageClient() {
  const { apiBaseUrl } = useConfig()
  const search = useSearchParams()
  const library = parseProviderLibrary(search.get('mediaType'))
  const overview = useQuery(providerOverviewQuery(apiBaseUrl, library))
  const summaries = useQuery({
    queryKey: ['providers'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
      ),
  })
  const items = overview.data?.providers ?? []
  const problems = items.filter(
    (item) =>
      connectionNeedsAction(item.connection) || queueBlocked(item.queue),
  )
  const attention = items.filter(providerNeedsAttention).length
  function selectLibrary(value: string) {
    const params = new URLSearchParams(window.location.search)
    const next = parseProviderLibrary(value)
    if (next) params.set('mediaType', next)
    else params.delete('mediaType')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    )
  }
  return (
    <section className="providers-overview" aria-label="Providers">
      <PageHead
        title="Providers"
        note={attention > 0 && `${formatCount(attention)} need attention`}
      />
      <Toolbar>
        <Select
          aria-label="Library"
          value={library ?? ''}
          onChange={(event) => selectLibrary(event.target.value)}
        >
          {providerLibraryOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {overview.data && (
          <ToolbarCount>
            {formatItemCount(items.length, {
              one: 'provider',
              other: 'providers',
            })}
          </ToolbarCount>
        )}
      </Toolbar>
      {problems.length > 0 && (
        <div className="providers-notices">
          {problems.map((item) => (
            <ProviderProblem key={item.id} item={item} />
          ))}
        </div>
      )}
      {overview.isError && !overview.data ? (
        <State
          error
          title="Could not load providers"
          action={<Button onClick={() => overview.refetch()}>Retry</Button>}
        />
      ) : overview.data && !items.length ? (
        library ? (
          <State
            title="No providers for this library"
            action={
              <Button onClick={() => selectLibrary('')}>
                Show all libraries
              </Button>
            }
          />
        ) : (
          <State title="No providers configured" />
        )
      ) : (
        <ProviderOverviewTable
          items={items}
          summaries={summaries.data ?? []}
          loading={overview.isPending}
        />
      )}
    </section>
  )
}
