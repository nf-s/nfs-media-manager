'use client'

import type { ProviderJobSummary as ProviderJobSummaryData } from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'

export default function ProviderJobSummary({
  summary,
  onOpenJobs,
}: {
  summary: ProviderJobSummaryData
  onOpenJobs: () => void
}) {
  const counts = [
    { label: 'Queued', count: summary.queued },
    { label: 'Running', count: summary.running },
    { label: 'Succeeded', count: summary.succeeded },
    { label: 'Failed', count: summary.failed },
    { label: 'Cancelled', count: summary.cancelled },
  ]
  return (
    <section aria-label="Provider jobs" className="mb-4">
      <div className="provider-activity-heading">
        <h2>Jobs · {summary.total.toLocaleString()}</h2>
        {summary.total > 0 && (
          <Button variant="ghost" size="sm" onClick={onOpenJobs}>
            View jobs
          </Button>
        )}
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {counts.map(({ label, count }) => (
          <div key={label}>
            <dt className="muted">{label}</dt>
            <dd className="font-mono tabular-nums">{count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
