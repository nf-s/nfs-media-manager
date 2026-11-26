'use client'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import type { z } from 'zod'
import type { JobActivitySchema } from '@repo/schemas/job'
import {
  ProviderActivitySchema,
  ProviderLibraryCoverageSchema,
  ProviderRequestSeriesSchema,
  type ProviderActivityRange,
  type ProviderRequestSeries,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { Section } from '@repo/ui/components/ds/facts'
import { Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Coverage } from '@repo/ui/components/ds/meter'
import { TrendChart } from '@repo/ui/components/ds/trend-chart'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import { formatDateTime } from '@repo/ui/lib/format'
import { DAY_MS, utcDay, type TrendRange } from '@repo/ui/lib/trend'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'
import { useTableWidths } from './secondary-table'

/** Refresh every 10 seconds while jobs are queued or running. */
function whileJobsRun(client: QueryClient) {
  const jobs = client.getQueryData<z.infer<typeof JobActivitySchema>>([
    'job-activity',
  ])
  return jobs && jobs.queued + jobs.running > 0 ? 10000 : false
}

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
    refetchInterval: () => whileJobsRun(client),
  })
}

function useProviderRequestSeries(provider: Pick<ProviderSummary, 'id'>) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useQuery({
    queryKey: ['provider-activity', provider.id, 'daily'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(provider.id)}/requests/daily`,
        ProviderRequestSeriesSchema,
      ),
    refetchInterval: () => whileJobsRun(client),
  })
}

/**
 * The ranges the stored history can fill. The server returns the last 90
 * days; 90d is offered once complete recording began before the 30-day range.
 */
export function requestRanges(
  series: Pick<ProviderRequestSeries, 'recordedSince' | 'daysTo'>,
): TrendRange[] {
  const thirtyDays = utcDay(series.daysTo) - 29 * DAY_MS
  return series.recordedSince === null ||
    Date.parse(series.recordedSince) < thirtyDays
    ? ['30d', '90d']
    : ['30d']
}

/** Request attempts per day as the shared trend chart. */
export function ProviderRequests({
  provider,
}: {
  provider: Pick<ProviderSummary, 'id'>
}) {
  const series = useProviderRequestSeries(provider)
  const data = series.data
  return (
    <Section title="Requests">
      {series.isPending && <Skeleton className="providers-chart" />}
      {series.isError && (
        <State
          size="sm"
          error
          title="Could not load request history"
          action={
            <ReadButton size="xs" read={() => series.refetch()}>
              Retry
            </ReadButton>
          }
        />
      )}
      {data && (
        <>
          {data.total > 0 ? (
            <TrendChart
              days={data.days}
              unit="requests"
              defaultRange="30d"
              ranges={requestRanges(data)}
              now={new Date(utcDay(data.daysTo))}
              partialDay
            />
          ) : (
            <State size="sm" title="No recorded requests in the last 90 days" />
          )}
          <p className="ds-help">
            {data.recordedSince
              ? `Full history since ${formatDateTime(data.recordedSince)}. Earlier history is partial.`
              : 'History starts with the first API request.'}{' '}
            Includes failed attempts; blocked calls are not counted.
          </p>
        </>
      )}
    </Section>
  )
}

const libraryLabels = { album: 'Albums', film: 'Films', track: 'Tracks' }
const itemPages = {
  album: 'From each album page',
  film: 'From each film page',
  track: 'From each track page',
}

/**
 * How much of each library the provider has data for, with a link to the
 * library's Metadata selection to fill the rest. Account-level providers have
 * no media types and no coverage.
 */
export function ProviderCoverage({
  provider,
}: {
  provider: Pick<ProviderSummary, 'id' | 'mediaTypes'>
}) {
  const { apiBaseUrl } = useConfig()
  const applies = provider.mediaTypes.length > 0
  const coverage = useQuery({
    queryKey: ['provider-activity', provider.id, 'coverage'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(provider.id)}/coverage`,
        ProviderLibraryCoverageSchema,
      ),
    enabled: applies,
  })
  if (!applies) return null
  const rows = coverage.data?.mediaTypes.filter((row) => row.total > 0) ?? []
  return (
    <Section title="Coverage" note="items with data from this provider">
      {coverage.isPending && <Skeleton className="providers-field" />}
      {coverage.isError && (
        <State
          size="sm"
          error
          title="Could not load coverage"
          action={
            <ReadButton size="xs" read={() => coverage.refetch()}>
              Retry
            </ReadButton>
          }
        />
      )}
      {coverage.data && !rows.length && (
        <State
          size="sm"
          title={`No ${coverage.data.mediaTypes
            .map((row) => libraryLabels[row.mediaType].toLowerCase())
            .join(' or ')} in the library`}
        />
      )}
      {rows.map((row) => (
        <Coverage
          key={row.mediaType}
          label={libraryLabels[row.mediaType]}
          have={row.covered}
          total={row.total}
          action={
            row.covered >= row.total ? undefined : row.queueFrom === 'item' ? (
              <span className="ds-muted">{itemPages[row.mediaType]}</span>
            ) : (
              <Button size="xs" asChild>
                <Link href={scopedHref('/jobs/metadata', row.mediaType)}>
                  Metadata
                </Link>
              </Button>
            )
          }
        />
      ))}
    </Section>
  )
}

type ActivityEvent = {
  key: string
  at: string
  content: ReactNode
}

const activityColumns = [
  { key: 'at', label: 'When', width: 150 },
  { key: 'event', label: 'Event', width: 320 },
]

/** Benign error reviews and cooldown clears, newest first. */
export function ProviderRecentActivity({
  provider,
}: {
  provider: Pick<ProviderSummary, 'id'>
}) {
  const activity = useProviderActivity(provider, '24h')
  const widths = useTableWidths('provider-recent-activity', activityColumns)
  const layout = widths.layout(activityColumns.map((column) => column.key))
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
            <ReadButton size="xs" read={() => activity.refetch()}>
              Retry
            </ReadButton>
          }
        />
      )}
      {data && !events.length && (
        <State size="sm" title="No error reviews or cooldown clears" />
      )}
      {events.length > 0 && (
        <Table aria-label="Recent activity" {...layout.table}>
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              <TableHead sticky={0} stickyEdge resizer={widths.resizer('at')}>
                When
              </TableHead>
              <TableHead resizer={widths.resizer('event')}>Event</TableHead>
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
