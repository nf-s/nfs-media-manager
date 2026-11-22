'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SonovaultRefreshInputSchema,
  SonovaultRemovalInputSchema,
  SonovaultRemovalSchema,
  SonovaultSummarySchema,
  type SonovaultSummary,
} from '@repo/schemas/sonovault'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import {
  formatAge,
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { ConfirmAction } from './confirm-action'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import { invalidateSpotifySearchJobs } from './spotify-track-search'

const RECORDS = { one: 'record', other: 'records' }
const summaryKey = ['providers', 'sonovault', 'summary']

export function SonovaultSummaryValues({
  summary,
}: {
  summary: SonovaultSummary
}) {
  const { lookups, credits } = summary
  return (
    <KeyValues
      items={[
        { label: 'Records matched', value: formatCount(lookups.matched) },
        { label: 'Verified', value: formatCount(lookups.verified) },
        { label: 'Not found', value: formatCount(lookups.notFound) },
        { label: 'Due for refresh', value: formatCount(lookups.dueForRefresh) },
        { label: 'References', value: formatCount(summary.references) },
        {
          label: 'Primary ISRCs given',
          value: formatCount(summary.primaryIsrcs),
        },
        { label: 'Stored responses', value: formatCount(summary.responses) },
        {
          label: 'Credits left',
          value:
            credits.remaining === null ? (
              <EmptyValue />
            ) : (
              <>
                {formatCount(credits.remaining)}
                {credits.reportedAt && (
                  <>
                    {' '}
                    <time
                      className="ds-muted"
                      dateTime={credits.reportedAt}
                      title={formatDateTime(credits.reportedAt)}
                    >
                      reported {formatAge(credits.reportedAt)}
                    </time>
                  </>
                )}
              </>
            ),
        },
        {
          label: 'Monthly credits',
          value: formatCount(credits.monthlyCredits),
        },
        { label: 'Reserve', value: formatCount(credits.reserve) },
      ]}
    />
  )
}

/**
 * What is stored from Sonovault, the credits left, the refresh the terms
 * require and the removal of everything stored from it (SONO-10).
 */
export default function SonovaultProviderSettings() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [batchId, setBatchId] = useState('')
  const summary = useQuery({
    queryKey: summaryKey,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonovault/summary',
        SonovaultSummarySchema,
        { signal },
      ),
  })
  async function invalidate() {
    await Promise.all([
      client.invalidateQueries({ queryKey: summaryKey }),
      invalidateSpotifySearchJobs(client),
    ])
  }
  const refresh = useMutation({
    retry: false,
    mutationFn: () => {
      const batch = crypto.randomUUID()
      setBatchId(batch)
      return fetchApiData(
        apiBaseUrl,
        '/api/v1/sonovault/refresh',
        EnrichmentResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            SonovaultRefreshInputSchema.parse({
              batchId: batch,
              confirmBroadRun: true,
            }),
          ),
        },
      )
    },
    onSettled: invalidate,
  })
  const remove = useMutation({
    retry: false,
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonovault/remove',
        SonovaultRemovalSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            SonovaultRemovalInputSchema.parse({ confirm: true }),
          ),
        },
      ),
    onSettled: invalidate,
  })
  const due = summary.data?.lookups.dueForRefresh ?? 0
  const busy = refresh.isPending || remove.isPending
  return (
    <Section title="Stored data">
      {summary.isPending && <Skeleton height={160} />}
      {summary.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => summary.refetch()}>
              Retry
            </Button>
          }
        >
          Could not load Sonovault data.
        </Notice>
      )}
      {summary.data && <SonovaultSummaryValues summary={summary.data} />}
      <div className="ds-actions flex-wrap">
        <ConfirmAction
          question={`Refresh ${formatItemCount(due, RECORDS)}?`}
          details="Looks up again every matched record older than 11 months. Each record uses one Sonovault credit."
          confirmLabel="Refresh records"
          disabled={busy || !summary.data || due === 0}
          onConfirm={() => refresh.mutate()}
        >
          Refresh records older than 11 months
        </ConfirmAction>
        <ConfirmAction
          confirmVariant="danger"
          question="Remove Sonovault data?"
          details="Removes every stored Sonovault response, reference and lookup, and the primary ISRCs Sonovault gave tracks. This cannot be undone."
          confirmLabel="Remove Sonovault data"
          disabled={busy || !summary.data}
          onConfirm={() => remove.mutate()}
        >
          Remove Sonovault data
        </ConfirmAction>
      </div>
      {refresh.isError && (
        <Notice tone="danger">
          {errorMessage(refresh.error, 'Could not queue the refresh.')}
        </Notice>
      )}
      {refresh.data && (
        <p className="ds-muted" role="status">
          {formatCount(refresh.data.queued)} queued ·{' '}
          {formatCount(refresh.data.skipped)} skipped.{' '}
          {batchId && refresh.data.queued > 0 && (
            <Link
              href={scopedHref(
                `/jobs?batchId=${encodeURIComponent(batchId)}`,
                'track',
              )}
            >
              View refresh jobs
            </Link>
          )}
        </p>
      )}
      {remove.isError && (
        <Notice tone="danger">
          {errorMessage(remove.error, 'Could not remove Sonovault data.')}
        </Notice>
      )}
      {remove.data && (
        <p className="ds-muted" role="status">
          Removed{' '}
          {formatItemCount(remove.data.references, {
            one: 'reference',
            other: 'references',
          })}
          ,{' '}
          {formatItemCount(remove.data.lookups, {
            one: 'lookup',
            other: 'lookups',
          })}
          ,{' '}
          {formatItemCount(remove.data.primaryIsrcs, {
            one: 'primary ISRC',
            other: 'primary ISRCs',
          })}{' '}
          and{' '}
          {formatItemCount(remove.data.responses, {
            one: 'response',
            other: 'responses',
          })}
          .
        </p>
      )}
    </Section>
  )
}
