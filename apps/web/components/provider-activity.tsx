'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ProviderActivitySchema,
  ProviderSafetySchema,
  type ProviderActivityRange,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll, TableState } from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'

const ranges: Array<{ value: ProviderActivityRange; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
]

export default function ProviderActivity({
  provider,
}: {
  provider: ProviderSummary
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [range, setRange] = useState<ProviderActivityRange>('24h')
  const [confirming, setConfirming] = useState<string | null>(null)
  const activity = useQuery({
    queryKey: ['provider-activity', provider.id, range],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${provider.id}/activity?range=${range}`,
        ProviderActivitySchema,
      ),
    staleTime: 0,
    refetchInterval: 10000,
  })
  const clear = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${provider.id}/cooldown/clear`,
        ProviderSafetySchema,
        {
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
            expectedCooldownUntil: confirming,
          }),
        },
      ),
    onSuccess: async () => {
      setConfirming(null)
      await client.invalidateQueries({ queryKey: ['providers'] })
      await client.invalidateQueries({
        queryKey: ['provider-activity', provider.id],
      })
      await client.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  const data = activity.data
  const maximum = Math.max(
    1,
    ...(data?.buckets.map((bucket) => bucket.count) ?? []),
  )
  const timeLabel = (value: string) =>
    new Date(value).toLocaleString(
      undefined,
      range === '7d'
        ? { month: 'short', day: 'numeric', hour: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' },
    )
  return (
    <>
      {provider.safety?.cooldownUntil && (
        <div className="provider-cooldown" role="status">
          <p>
            Cooling down until{' '}
            {new Date(provider.safety.cooldownUntil).toLocaleString()}.
          </p>
          {provider.safety.lastError && (
            <p className="muted">{provider.safety.lastError}</p>
          )}
          {confirming ? (
            <>
              <p>
                Clear this cooldown early? Queued jobs may resume. Request
                spacing, request budgets and access blocks stay enforced.
              </p>
              <div className="form-actions">
                <Button
                  disabled={clear.isPending}
                  onClick={() => clear.mutate()}
                >
                  {clear.isPending ? 'Clearing...' : 'Confirm clear cooldown'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={clear.isPending}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                clear.reset()
                setConfirming(provider.safety?.cooldownUntil ?? null)
              }}
            >
              Clear cooldown
            </Button>
          )}
        </div>
      )}
      {clear.isError && <p role="alert">{clear.error.message}</p>}
      {clear.isSuccess && (
        <p role="status">Cooldown cleared. Request limits remain enforced.</p>
      )}
      <section className="provider-activity" aria-label="API request activity">
        <div className="provider-activity-heading">
          <h2>
            API requests{' '}
            {data && (
              <span className="muted">· {data.total.toLocaleString()}</span>
            )}
          </h2>
          <div className="form-actions" aria-label="Request history period">
            {ranges.map((item) => (
              <Button
                key={item.value}
                size="sm"
                variant={range === item.value ? 'default' : 'ghost'}
                aria-pressed={range === item.value}
                onClick={() => setRange(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>
        {activity.isPending && <p role="status">Loading request history...</p>}
        {activity.isError && (
          <p role="alert">
            Could not load request history.{' '}
            <button onClick={() => activity.refetch()}>Retry</button>
          </p>
        )}
        {data && (
          <>
            <svg
              viewBox="0 0 720 170"
              className="provider-request-chart"
              role="img"
              aria-label={`${provider.displayName}: ${data.total} API request attempts in the last ${ranges.find((item) => item.value === range)?.label}`}
            >
              <title>API request attempts over time</title>
              <line x1="40" x2="710" y1="20" y2="20" className="chart-grid" />
              <line x1="40" x2="710" y1="135" y2="135" className="chart-grid" />
              <text x="32" y="24" textAnchor="end">
                {maximum}
              </text>
              <text x="32" y="139" textAnchor="end">
                0
              </text>
              {data.buckets.map((bucket, index) => (
                <rect
                  key={index}
                  x={40 + (index * 670) / data.buckets.length}
                  y={135 - (bucket.count / maximum) * 115}
                  width={Math.max(1, 670 / data.buckets.length - 2)}
                  height={(bucket.count / maximum) * 115}
                  className="chart-bar"
                >
                  <title>
                    {timeLabel(bucket.start)}: {bucket.count} requests
                  </title>
                </rect>
              ))}
              <text x="40" y="159">
                {timeLabel(data.from)}
              </text>
              <text x="710" y="159" textAnchor="end">
                {timeLabel(data.to)}
              </text>
            </svg>
            {!data.total && (
              <p className="muted">No recorded requests in this period.</p>
            )}
            <p className="muted">
              {data.recordedSince
                ? `Full history since ${new Date(data.recordedSince).toLocaleString()}. Earlier history is partial.`
                : 'History starts with the first API request.'}{' '}
              Includes failed attempts; blocked calls are not counted.
            </p>
            <details className="import-notes">
              <summary>Request counts</summary>
              <TableScroll
                className="table-scroll-bounded"
                role="region"
                aria-label="Request counts"
              >
                <table className="compact-table" aria-label="Request counts">
                  <thead>
                    <tr>
                      <th scope="col">Interval start</th>
                      <th scope="col">Requests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!data.buckets.length && (
                      <TableState colSpan={2}>
                        No recorded requests in this period.
                      </TableState>
                    )}
                    {data.buckets.map((bucket) => (
                      <tr key={bucket.start}>
                        <td>{new Date(bucket.start).toLocaleString()}</td>
                        <td>{bucket.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </details>
          </>
        )}
      </section>
      <details className="provider-review-history">
        <summary>Error reviews and cooldown history</summary>
        <p className="muted">
          Validated lookup misses do not count toward provider failures.
          Reviewing an error acknowledges only that occurrence.
        </p>
        {provider.reviewableErrors.length > 0 ? (
          <ul>
            {provider.reviewableErrors.map((rule) => (
              <li key={`${rule.name}:${rule.message}`}>
                <code>
                  {rule.name}: {rule.message}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            No additional historical error messages are reviewable.
          </p>
        )}
        {!!data?.benignReviews.length && (
          <section>
            <h3>Recent reviews ({data.benignReviews.length})</h3>
            <ul>
              {data.benignReviews.map((review, index) => (
                <li key={`${review.jobId}:${index}`}>
                  <Link
                    href={`/jobs?jobId=${encodeURIComponent(review.jobId)}`}
                  >
                    {review.message}
                  </Link>{' '}
                  <span className="muted">
                    · {new Date(review.reviewedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!data?.cooldownResets.length && (
          <section>
            <h3>Recent cooldown clears</h3>
            <ul>
              {data.cooldownResets.map((reset) => (
                <li key={reset.clearedAt}>
                  {new Date(reset.clearedAt).toLocaleString()}{' '}
                  <span className="muted">
                    · cleared wait until{' '}
                    {new Date(reset.previousCooldownUntil).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </details>
    </>
  )
}
