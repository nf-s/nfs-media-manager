'use client'

import Link from 'next/link'
import { providerJobsHref } from '@/utils/provider-overview'
import type { ProviderJobSummary as ProviderJobSummaryData } from '@repo/schemas/provider'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'

/** The provider's jobs across every library, as headline figures. */
export default function ProviderJobSummary({
  summary,
  jobsHref,
}: {
  summary: ProviderJobSummaryData
  jobsHref: string
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
          <Button variant="link" asChild>
            <Link href={jobsHref} replace scroll={false}>
              View jobs
            </Link>
          </Button>
        )
      }
    >
      <Stats
        items={[
          {
            label: 'Queued',
            value: formatCount(summary.queued),
            workspaceHref: providerJobsHref(summary.provider, 'queued'),
          },
          {
            label: 'Running',
            value: formatCount(summary.running),
            workspaceHref: providerJobsHref(summary.provider, 'running'),
          },
          {
            label: 'Failed',
            value: formatCount(summary.failed),
            workspaceHref: providerJobsHref(summary.provider, 'failed'),
            tone: summary.failed > 0 ? 'danger' : undefined,
          },
          {
            label: 'Succeeded',
            value: formatCount(summary.succeeded),
            workspaceHref: providerJobsHref(summary.provider, 'succeeded'),
          },
        ]}
      />
    </Section>
  )
}
