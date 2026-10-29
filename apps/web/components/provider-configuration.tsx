'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ProviderBudgetStatusSchema,
  ProviderRequestBudgetSchema,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'

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
    <form
      className="provider-budget"
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success) update.mutate()
      }}
    >
      <h2>Request budget</h2>
      {provider.budgetStatus && (
        <p>
          <strong>
            {provider.budgetStatus.used.toLocaleString()} /{' '}
            {provider.budgetStatus.budget.limit.toLocaleString()}
          </strong>{' '}
          requests{' '}
          {provider.budgetStatus.budget.period === 'day'
            ? 'today (UTC)'
            : 'in the last hour'}{' '}
          · resets {new Date(provider.budgetStatus.resetsAt).toLocaleString()}
        </p>
      )}
      <div className="provider-budget-fields">
        <label>
          Period
          <select
            aria-label="Budget period"
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
          </select>
        </label>
        <label>
          Request cap
          <Input
            aria-label="Request cap"
            className="w-28"
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
        <Button type="submit" disabled={update.isPending || !parsed.success}>
          {update.isPending ? 'Saving...' : 'Update budget'}
        </Button>
      </div>
      <p className="muted">
        {period === 'day'
          ? `Resets at midnight UTC.${provider.rateLimit.maxRequestsPerHour === undefined ? ' No additional hourly cap.' : ''}`
          : 'Counts requests in the preceding 60 minutes.'}{' '}
        Spacing, service quotas and cooldowns still apply. Changing the budget
        does not reset usage.
      </p>
      {update.isError && <p role="alert">{update.error.message}</p>}
      {update.isSuccess && <p role="status">Request budget updated.</p>}
    </form>
  )
}

const duration = (ms: number | undefined) =>
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
  const requestLimits = [
    ['Minimum spacing', duration(provider.rateLimit.minTimeMs)],
    [
      'Concurrent requests',
      String(
        provider.rateLimit.concurrentRequests
          ? provider.rateLimit.maxConcurrent
          : 1,
      ),
    ],
    ...(provider.rateLimit.fixedWindow
      ? [
          [
            'Fixed window',
            `${provider.rateLimit.fixedWindow.reads.toLocaleString()} reads / ${provider.rateLimit.fixedWindow.writes.toLocaleString()} writes per ${duration(provider.rateLimit.fixedWindow.durationMs)}`,
          ],
        ]
      : []),
    ...(provider.rateLimit.maxRequestsPerHour
      ? [
          [
            'Hourly cap',
            `${provider.safety?.requestsLastHour ?? 0} / ${provider.rateLimit.maxRequestsPerHour.toLocaleString()} requests`,
          ],
        ]
      : []),
    ...(!provider.rateLimit.configurableRequestBudget && provider.budgetStatus
      ? [
          [
            'Request budget',
            `${provider.budgetStatus.used.toLocaleString()} / ${provider.budgetStatus.budget.limit.toLocaleString()} ${provider.budgetStatus.budget.period === 'day' ? 'today (UTC)' : 'in the last hour'}; resets ${new Date(provider.budgetStatus.resetsAt).toLocaleString()}`,
          ],
        ]
      : []),
    [
      'Rate-limit cooldown',
      provider.rateLimit.retryAfterIsAuthoritative
        ? `Retry-After (${duration(provider.rateLimit.rateLimitCooldownMs)} fallback)`
        : duration(provider.rateLimit.rateLimitCooldownMs),
    ],
    ['HTTP error backoff', duration(provider.rateLimit.errorBackoffMs)],
    ['Repeated-error cooldown', duration(provider.rateLimit.failureCooldownMs)],
  ]
  const capabilities = [
    provider.supportsScrape ? 'Scraping' : null,
    provider.supportsLegacyImport ? 'Legacy imports' : null,
    provider.supportsSync ? 'Account sync' : null,
  ].filter((value) => value !== null)
  return (
    <section className="provider-settings">
      {provider.rateLimit.configurableRequestBudget && (
        <RequestBudgetForm
          key={`${provider.id}:${provider.rateLimit.requestBudget?.period}:${provider.rateLimit.requestBudget?.limit}`}
          provider={provider}
        />
      )}
      <section className="provider-settings-group">
        <h2>Request limits</h2>
        <dl className="provider-config-grid">
          {requestLimits.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="muted">
          Two unexpected failures stop queued work. No automatic retries.
          Requests time out after 15 seconds and responses are limited to 10
          MiB.
        </p>
      </section>
      <section className="provider-settings-group">
        <h2>Lookup rules</h2>
        <p>
          {provider.requireExplicitSelection
            ? 'Exact-item lookups only. Select an item in the library to request an update.'
            : 'More than five item/provider operations require confirmation.'}
          {provider.maxItemsPerJob
            ? ` Up to ${provider.maxItemsPerJob} items per job.`
            : ''}
        </p>
        <p className="muted">
          Identifiers: {provider.identifierTypes.join(', ') || 'None declared'}.
          {provider.supportsNameLookup ? ' Name lookup is also supported.' : ''}
          {!provider.supportsScrape ? ' No executable scraper loaded.' : ''}
        </p>
      </section>
      <details className="import-notes">
        <summary>Integration details</summary>
        <p>
          Supports: {capabilities.join(', ') || 'No executable capabilities'} ·{' '}
          {provider.mediaTypes.join(', ')}
        </p>
        <p>
          Provider ID: <code>{provider.id}</code>
        </p>
        {provider.pluginPath && (
          <p>
            Local package: <code>{provider.pluginPath}</code>
          </p>
        )}
        <h4>File imports</h4>
        {provider.fileImports.length ? (
          <ul>
            {provider.fileImports.map((item) => (
              <li key={item.id}>
                {item.label} · {item.requiredColumns.join(', ')}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None declared.</p>
        )}
        <h4>Browse fields</h4>
        {provider.browseFields.length ? (
          <ul>
            {provider.browseFields.map((field) => (
              <li key={field.key}>
                {field.label} · {field.type}
                {field.format ? ` / ${field.format}` : ''} ·{' '}
                {field.filterable ? 'Filterable' : 'Display only'}
                <code>{field.key}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No additional fields declared.</p>
        )}
      </details>
    </section>
  )
}
