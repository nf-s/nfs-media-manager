'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ImportStatusSchema } from '@repo/schemas/imports'
import { fetchApiData } from '@/utils/api'
import { useConfig } from '@/components/providers'
import { SecondaryDataTable } from '../secondary-table'
import { useMediaScope } from '@/components/media-scope'
import { scopedHref } from '@/utils/media-scope'
import { ImportStatusNotice } from '@/components/imports-workspace'

export default function ImportsPageClient() {
  const { apiBaseUrl } = useConfig()
  const mediaType = useMediaScope()
  const query = useQuery({
    queryKey: ['imports', mediaType],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/imports?${new URLSearchParams({ mediaType })}`,
        ImportStatusSchema,
      ),
    staleTime: 0,
    refetchInterval: 2000,
  })
  const runs =
    query.data?.runs.filter(
      (run) => run.mediaType === null || run.mediaType === mediaType,
    ) ?? []
  return (
    <section className="admin-page imports-page">
      <h1>Recent {mediaType} imports</h1>
      <ImportStatusNotice />
      {query.isError && (
        <p role="alert">
          Could not load {mediaType} import history.{' '}
          <button onClick={() => query.refetch()}>Retry</button>
        </p>
      )}
      <section className="import-history">
        <SecondaryDataTable
          id={`import-history-${mediaType}`}
          label={`Recent ${mediaType} imports`}
          className="import-preview-scroll"
          rows={runs}
          rowKey={(run) => run.id}
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          busy={query.isFetching}
          error={query.isError}
          empty={
            query.isPending
              ? 'Loading imports...'
              : query.isError
                ? 'Imports unavailable.'
                : 'No imports yet.'
          }
          columns={[
            {
              key: 'createdAt',
              label: 'Started',
              value: (run) => Date.parse(run.createdAt),
              render: (run) => (
                <>
                  {new Date(run.createdAt).toLocaleString()}
                  {run.mediaType === null && (
                    <span className="block text-xs text-muted-foreground">
                      Mixed / legacy scope unknown
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              value: (run) => run.status,
              render: (run) => (
                <span className="job-status" data-status={run.status}>
                  {run.status}
                </span>
              ),
            },
            { key: 'stage', label: 'Stage', value: (run) => run.stage },
            {
              key: 'processed',
              label: 'Processed',
              className: 'numeric',
              value: (run) => run.processed,
            },
            {
              key: 'total',
              label: 'Total',
              className: 'numeric',
              value: (run) => run.total,
            },
            {
              key: 'result',
              label: 'Result',
              value: (run) =>
                run.errorMessage ??
                (run.result
                  ? `${run.result.created ?? run.result.albums} new, ${run.result.updated ?? run.result.films} changed`
                  : null),
              render: (run) => (
                <>
                  {run.result
                    ? `${run.result.created !== undefined ? `${run.result.created} new items, ${run.result.updated ?? 0} changed, ${run.result.unchanged ?? 0} unchanged` : `${run.result.albums} albums, ${run.result.films} film rows`}${run.result.skipped ? `, ${run.result.skipped} skipped` : ''}${run.result.failed ? `, ${run.result.failed} failed` : ''}`
                    : run.errorMessage}
                  {run.result?.jobBatchId && (
                    <p>
                      <Link
                        href={scopedHref(
                          `/jobs?batchId=${run.result.jobBatchId}`,
                          run.mediaType ?? mediaType,
                        )}
                      >
                        {run.result.queuedJobs ?? 0} metadata jobs
                      </Link>
                      {!!run.result.skippedJobs &&
                        ` · ${run.result.skippedJobs} already scraped, queued or awaiting IDs/credentials`}
                    </p>
                  )}
                  {!!run.result?.warnings?.length && (
                    <details>
                      <summary>Warnings ({run.result.warnings.length})</summary>
                      {run.result.warnings.map((warning, index) => (
                        <p key={index}>{warning}</p>
                      ))}
                    </details>
                  )}
                </>
              ),
            },
            {
              key: 'finishedAt',
              label: 'Finished',
              defaultVisible: false,
              value: (run) =>
                run.finishedAt ? Date.parse(run.finishedAt) : null,
              render: (run) =>
                run.finishedAt
                  ? new Date(run.finishedAt).toLocaleString()
                  : '-',
            },
            {
              key: 'created',
              label: 'New items',
              defaultVisible: false,
              className: 'numeric',
              value: (run) => run.result?.created,
            },
            {
              key: 'updated',
              label: 'Changed',
              defaultVisible: false,
              className: 'numeric',
              value: (run) => run.result?.updated,
            },
            {
              key: 'unchanged',
              label: 'Unchanged',
              defaultVisible: false,
              className: 'numeric',
              value: (run) => run.result?.unchanged,
            },
            {
              key: 'skipped',
              label: 'Skipped',
              defaultVisible: false,
              className: 'numeric',
              value: (run) => run.result?.skipped,
            },
            {
              key: 'failed',
              label: 'Failed',
              defaultVisible: false,
              className: 'numeric',
              value: (run) => run.result?.failed,
            },
          ]}
        />
      </section>
    </section>
  )
}
