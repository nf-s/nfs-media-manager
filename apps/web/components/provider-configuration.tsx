'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ProviderBudgetStatusSchema,
  ProviderRequestBudgetSchema,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { formatCount, formatItemCount, formatUntil } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'

const itemNouns: Record<string, { one: string; other: string }> = {
  album: { one: 'album', other: 'albums' },
  film: { one: 'film', other: 'films' },
  track: { one: 'track', other: 'tracks' },
}

function perJob(maxItems: number, noun: { one: string; other: string }) {
  const items = formatItemCount(maxItems, noun)
  return `${maxItems > 1 ? 'up to ' : ''}${items} per job`
}

/**
 * How many items a job covers: the item-scrape limit, then each task job
 * kind's own, such as `Track lookups: up to 100 tracks per job.`
 */
export function jobLimitText(
  provider: Pick<ProviderSummary, 'maxItemsPerJob' | 'mediaTypes'> &
    Partial<Pick<ProviderSummary, 'taskLimits'>>,
) {
  const [only] = provider.mediaTypes.length === 1 ? provider.mediaTypes : []
  const noun = (only && itemNouns[only]) || { one: 'item', other: 'items' }
  const item = provider.maxItemsPerJob
    ? perJob(provider.maxItemsPerJob, noun)
    : null
  return [
    item ? `${item.charAt(0).toUpperCase()}${item.slice(1)}.` : null,
    ...(provider.taskLimits ?? []).map(
      (limit) => `${limit.label}: ${perJob(limit.maxItems, limit.noun)}.`,
    ),
  ]
    .filter(Boolean)
    .map((text) => ` ${text}`)
    .join('')
}

function RequestBudgetForm({ provider }: { provider: ProviderSummary }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [period, setPeriod] = useState(
    provider.rateLimit.requestBudget?.period ?? 'day',
  )
  const [limit, setLimit] = useState(
    String(provider.rateLimit.requestBudget?.limit ?? 1000),
  )
  const parsed = ProviderRequestBudgetSchema.safeParse({
    period,
    limit: Number(limit),
  })
  const update = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${provider.id}/budget`,
        ProviderBudgetStatusSchema,
        {
          method: 'PATCH',
          body: JSON.stringify(
            ProviderRequestBudgetSchema.parse({ period, limit: Number(limit) }),
          ),
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  return (
    <Section title="Request budget">
      <form
        className="providers-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (parsed.success) update.mutate()
        }}
      >
        {provider.budgetStatus && (
          <p>
            <strong>
              {formatCount(provider.budgetStatus.used)} /{' '}
              {formatCount(provider.budgetStatus.budget.limit)}
            </strong>{' '}
            requests{' '}
            {provider.budgetStatus.budget.period === 'day'
              ? 'today (UTC)'
              : 'in the last hour'}{' '}
            · resets {formatUntil(provider.budgetStatus.resetsAt)}
          </p>
        )}
        <div className="providers-fields">
          <label className="ds-field">
            <span className="ds-label">Period</span>
            <Select
              aria-label="Budget period"
              controlSize="md"
              value={period}
              disabled={update.isPending}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'hour' || value === 'day') {
                  setPeriod(value)
                  update.reset()
                }
              }}
            >
              <option value="day">Daily (UTC)</option>
              <option value="hour">Rolling hour</option>
            </Select>
          </label>
          <label className="ds-field">
            <span className="ds-label">Request cap</span>
            <Input
              aria-label="Request cap"
              controlSize="md"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={limit}
              disabled={update.isPending}
              onChange={(event) => {
                setLimit(event.target.value)
                update.reset()
              }}
            />
          </label>
          <Button
            size="md"
            type="submit"
            disabled={update.isPending || !parsed.success}
          >
            {update.isPending ? 'Saving...' : 'Update budget'}
          </Button>
        </div>
        <p className="ds-help">
          {period === 'day'
            ? `Resets at midnight UTC.${provider.rateLimit.maxRequestsPerHour === undefined ? ' No additional hourly cap.' : ''}`
            : 'Counts requests in the preceding 60 minutes.'}{' '}
          Spacing, service quotas and cooldowns still apply. Changing the budget
          does not reset usage.
        </p>
        {update.isError && <p role="alert">{update.error.message}</p>}
        {update.isSuccess && <p role="status">Request budget updated.</p>}
      </form>
    </Section>
  )
}

/** A request limit's duration: `1.5 s`, `60 min`, Disabled or Not configured. */
export const formatLimitDuration = (ms: number | undefined) =>
  ms === undefined
    ? 'Not configured'
    : ms === 0
      ? 'Disabled'
      : ms < 1000
        ? `${ms} ms`
        : ms < 60000
          ? `${ms / 1000} s`
          : `${ms / 60000} min`

export default function ProviderConfiguration({
  provider,
}: {
  provider: ProviderSummary
}) {
  const requestLimits: { label: string; value: string }[] = [
    {
      label: 'Minimum spacing',
      value: formatLimitDuration(provider.rateLimit.minTimeMs),
    },
    {
      label: 'Concurrent requests',
      value: String(
        provider.rateLimit.concurrentRequests
          ? provider.rateLimit.maxConcurrent
          : 1,
      ),
    },
    ...(provider.rateLimit.fixedWindow
      ? [
          {
            label: 'Fixed window',
            value: `${formatCount(provider.rateLimit.fixedWindow.reads)} reads / ${formatCount(provider.rateLimit.fixedWindow.writes)} writes per ${formatLimitDuration(provider.rateLimit.fixedWindow.durationMs)}`,
          },
        ]
      : []),
    ...(provider.rateLimit.maxRequestsPerHour
      ? [
          {
            label: 'Hourly cap',
            value: `${formatCount(provider.safety?.requestsLastHour ?? 0)} / ${formatCount(provider.rateLimit.maxRequestsPerHour)} requests`,
          },
        ]
      : []),
    ...(!provider.rateLimit.configurableRequestBudget && provider.budgetStatus
      ? [
          {
            label: 'Request budget',
            value: `${formatCount(provider.budgetStatus.used)} / ${formatCount(provider.budgetStatus.budget.limit)} ${provider.budgetStatus.budget.period === 'day' ? 'today (UTC)' : 'in the last hour'}; resets ${formatUntil(provider.budgetStatus.resetsAt)}`,
          },
        ]
      : []),
    {
      label: 'Rate-limit cooldown',
      value: provider.rateLimit.retryAfterIsAuthoritative
        ? `Retry-After (${formatLimitDuration(provider.rateLimit.rateLimitCooldownMs)} fallback)`
        : formatLimitDuration(provider.rateLimit.rateLimitCooldownMs),
    },
    {
      label: 'HTTP error backoff',
      value: formatLimitDuration(provider.rateLimit.errorBackoffMs),
    },
    {
      label: 'Repeated-error cooldown',
      value: formatLimitDuration(provider.rateLimit.failureCooldownMs),
    },
  ]
  const capabilities = [
    provider.supportsScrape ? 'Scraping' : null,
    provider.supportsLegacyImport ? 'Legacy imports' : null,
  ].filter((value) => value !== null)
  return (
    <>
      {provider.rateLimit.configurableRequestBudget && (
        <RequestBudgetForm
          key={`${provider.id}:${provider.rateLimit.requestBudget?.period}:${provider.rateLimit.requestBudget?.limit}`}
          provider={provider}
        />
      )}
      <Section title="Request limits">
        <KeyValues items={requestLimits} />
        <p className="ds-help">
          Five consecutive unexpected failures stop queued work. Serial metadata
          GET requests can make up to three attempts total on HTTP 502, 503 or
          504. Requests time out after 15 seconds by default and responses are
          limited to 10 MiB.
        </p>
      </Section>
      {provider.mediaTypes.length > 0 && (
        <Section title="Lookup rules">
          <p>
            {provider.requireExplicitSelection
              ? 'Exact-item lookups only. Select an item in the library to request an update.'
              : 'More than five item/provider operations require confirmation.'}
            {jobLimitText(provider)}
          </p>
          <p className="ds-help">
            Identifiers:{' '}
            {provider.identifierTypes.join(', ') || 'None declared'}.
            {provider.supportsNameLookup
              ? ' Name lookup is also supported.'
              : ''}
            {!provider.supportsScrape ? ' No executable scraper loaded.' : ''}
          </p>
        </Section>
      )}
      <Section title="Integration details">
        <details className="providers-details">
          <summary>Show integration details</summary>
          <KeyValues
            items={[
              {
                label: 'Supports',
                value: `${capabilities.join(', ') || 'No executable capabilities'} · ${provider.mediaTypes.join(', ') || 'Account level'}`,
              },
              { label: 'Provider ID', value: <code>{provider.id}</code> },
              ...(provider.pluginPath
                ? [
                    {
                      label: 'Local package',
                      value: <code>{provider.pluginPath}</code>,
                    },
                  ]
                : []),
              {
                label: 'File imports',
                value: provider.fileImports.length ? (
                  <ul className="providers-list">
                    {provider.fileImports.map((item) => (
                      <li key={item.id}>
                        {item.label} · {item.requiredColumns.join(', ')}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None declared.'
                ),
              },
              {
                label: 'Browse fields',
                value: provider.browseFields.length ? (
                  <ul className="providers-list">
                    {provider.browseFields.map((field) => (
                      <li key={field.key}>
                        {field.label} · {field.type}
                        {field.format ? ` / ${field.format}` : ''} ·{' '}
                        {field.filterable ? 'Filterable' : 'Display only'}{' '}
                        <code>{field.key}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  'No additional fields declared.'
                ),
              },
            ]}
          />
        </details>
      </Section>
    </>
  )
}
