'use client'

import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import type { JobActivitySchema } from '@repo/schemas/job'
import {
  ProviderActivitySchema,
  type ProviderActivityRange,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { Section } from '@repo/ui/components/ds/facts'
import { Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { Sparkline } from '@repo/ui/components/ds/trend-chart'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortButton,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { sortTableRows } from '@/utils/secondary-table'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'

const ranges: Array<{ value: ProviderActivityRange; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
]

function useProviderActivity(
  provider: Pick<ProviderSummary, 'id'>,
  range: ProviderActivityRange,
) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useQuery({
    queryKey: ['provider-activity', provider.id, range],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(provider.id)}/activity?range=${range}`,
        ProviderActivitySchema,
      ),
    refetchInterval: () => {
      const jobs = client.getQueryData<z.infer<typeof JobActivitySchema>>([
        'job-activity',
      ])
      return jobs && jobs.queued + jobs.running > 0 ? 10000 : false
    },
  })
}

/** Request attempts over the last hour, day or week, with the counts behind the line. */
export function ProviderRequests({
  provider,
}: {
  provider: Pick<ProviderSummary, 'id' | 'displayName'>
}) {
  const [range, setRange] = useState<ProviderActivityRange>('24h')
  const [sortBy, setSortBy] = useState<'start' | 'count'>('start')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const activity = useProviderActivity(provider, range)
  const data = activity.data
  const rangeLabel = ranges.find((item) => item.value === range)?.label
  function sort(key: 'start' | 'count') {
    setSortBy(key)
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
  }
  function header(key: 'start' | 'count', label: string) {
    const active = sortBy === key
    return (
      <TableHead
        align={key === 'count' ? 'end' : undefined}
        sticky={key === 'start' ? 0 : undefined}
        stickyEdge={key === 'start'}
        aria-sort={
          active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
        }
      >
        <TableSortButton
          direction={active ? direction : undefined}
          onClick={() => sort(key)}
        >
          {label}
        </TableSortButton>
      </TableHead>
    )
  }
  return (
    <Section
      title="Requests"
      note={data ? formatCount(data.total) : undefined}
      aside={
        <Segmented
          label="Request history period"
          value={range}
          options={ranges}
          onChange={setRange}
        />
      }
    >
      {activity.isPending && <Skeleton className="providers-chart" />}
      {activity.isError && (
        <State
          size="sm"
          error
          title="Could not load request history"
          action={
            <Button size="xs" onClick={() => activity.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {data && (
        <>
          {data.total > 0 ? (
            <div className="providers-chart">
              <Sparkline
                values={data.buckets.map((bucket) => bucket.count)}
                label={`${provider.displayName}: ${formatCount(data.total)} API request attempts in the last ${rangeLabel}`}
              />
            </div>
          ) : (
            <State size="sm" title="No recorded requests in this period" />
          )}
          <p className="ds-help">
            {data.recordedSince
              ? `Full history since ${formatDateTime(data.recordedSince)}. Earlier history is partial.`
              : 'History starts with the first API request.'}{' '}
            Includes failed attempts; blocked calls are not counted.
          </p>
          <details className="providers-details">
            <summary>Request counts</summary>
            <Table
              aria-label="Request counts"
              containerClassName="providers-table-bounded"
            >
              <TableHeader>
                <TableRow>
                  {header('start', 'Interval start')}
                  {header('count', 'Requests')}
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data.buckets.length && (
                  <TableState colSpan={2}>
                    No recorded requests in this period.
                  </TableState>
                )}
                {sortTableRows(
                  data.buckets,
                  { key: sortBy, direction },
                  (bucket, key) =>
                    key === 'count' ? bucket.count : Date.parse(bucket.start),
                ).map((bucket) => (
                  <TableRow key={bucket.start}>
                    <TableCell sticky={0} stickyEdge>
                      {formatDateTime(bucket.start)}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(bucket.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </>
      )}
    </Section>
  )
}

type ActivityEvent = {
  key: string
  at: string
  content: ReactNode
}

/** Benign error reviews and cooldown clears, newest first. */
export function ProviderRecentActivity({
  provider,
}: {
  provider: Pick<ProviderSummary, 'id'>
}) {
  const activity = useProviderActivity(provider, '24h')
  const data = activity.data
  const events: ActivityEvent[] = data
    ? [
        ...data.benignReviews.map((review, index) => ({
          key: `review:${review.jobId}:${index}`,
          at: review.reviewedAt,
          content: (
            <>
              Reviewed:{' '}
              <DetailLink kind="job" id={review.jobId}>
                {review.message}
              </DetailLink>
            </>
          ),
        })),
        ...data.cooldownResets.map((reset) => ({
          key: `reset:${reset.clearedAt}`,
          at: reset.clearedAt,
          content: `Cooldown cleared · wait was until ${formatDateTime(reset.previousCooldownUntil)}`,
        })),
      ].sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    : []
  return (
    <Section title="Recent activity" note={data ? events.length : undefined}>
      {activity.isPending && <Skeleton className="providers-chart" />}
      {activity.isError && (
        <State
          size="sm"
          error
          title="Could not load recent activity"
          action={
            <Button size="xs" onClick={() => activity.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {data && !events.length && (
        <State size="sm" title="No error reviews or cooldown clears" />
      )}
      {events.length > 0 && (
        <Table aria-label="Recent activity">
          <TableHeader>
            <TableRow>
              <TableHead sticky={0} stickyEdge>
                When
              </TableHead>
              <TableHead>Event</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.key}>
                <TableCell sticky={0} stickyEdge>
                  {formatDateTime(event.at)}
                </TableCell>
                <TableCell>{event.content}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

/** Historical error messages the owner can mark benign on a job's log. */
export function ProviderReviewableErrors({
  provider,
}: {
  provider: Pick<ProviderSummary, 'reviewableErrors'>
}) {
  return (
    <Section title="Error reviews">
      <p className="ds-help">
        Validated lookup misses do not count toward provider failures. Reviewing
        an error acknowledges only that occurrence.
      </p>
      {provider.reviewableErrors.length > 0 ? (
        <ul className="providers-list">
          {provider.reviewableErrors.map((rule) => (
            <li key={`${rule.name}:${rule.message}`}>
              <code>
                {rule.name}: {rule.message}
              </code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ds-help">
          No additional historical error messages are reviewable.
        </p>
      )}
    </Section>
  )
}
