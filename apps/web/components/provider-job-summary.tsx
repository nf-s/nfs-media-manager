'use client'

import type { ProviderJobSummary as ProviderJobSummaryData } from '@repo/schemas/provider'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'

/** The provider's jobs across every library, as headline figures. */
export default function ProviderJobSummary({
  summary,
  onOpenJobs,
}: {
  summary: ProviderJobSummaryData
  onOpenJobs: () => void
}) {
  return (
    <Section
      title="Jobs"
      note={
        summary.cancelled > 0
          ? `${formatCount(summary.total)} · ${formatCount(summary.cancelled)} cancelled`
          : formatCount(summary.total)
      }
      aside={
        summary.total > 0 && (
          <Button variant="link" onClick={onOpenJobs}>
            View jobs
          </Button>
        )
      }
    >
      <Stats
        items={[
          { label: 'Queued', value: formatCount(summary.queued) },
          { label: 'Running', value: formatCount(summary.running) },
          {
            label: 'Failed',
            value: formatCount(summary.failed),
            tone: summary.failed > 0 ? 'danger' : undefined,
          },
          { label: 'Succeeded', value: formatCount(summary.succeeded) },
        ]}
      />
    </Section>
  )
}
