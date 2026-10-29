'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ImportStatusSchema } from '@repo/schemas/imports'
import { fetchApiData } from '@/utils/api'
import { useConfig } from '@/components/providers'
import { TableScroll, TableState } from '@repo/ui/components/ui/table'
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
        <TableScroll
          className="import-preview-scroll"
          role="region"
          aria-label={`Recent ${mediaType} imports`}
          aria-busy={query.isFetching}
        >
          <table
            className="compact-table"
            aria-label={`Recent ${mediaType} imports`}
          >
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Progress</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {!runs.length && (
                <TableState colSpan={3} error={query.isError}>
                  {query.isPending
                    ? 'Loading imports...'
                    : query.isError
                      ? 'Imports unavailable.'
                      : 'No imports yet.'}
                </TableState>
              )}
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    {new Date(run.createdAt).toLocaleString()}
                    {run.mediaType === null && (
                      <span className="block text-xs text-muted-foreground">
                        Mixed / legacy scope unknown
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="job-status" data-status={run.status}>
                      {run.status}
                    </span>
                    <br />
                    {run.stage}
                    {run.total > 0 &&
                      ` · ${run.processed.toLocaleString()} / ${run.total.toLocaleString()}`}
                  </td>
                  <td>
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
                        <summary>
                          Warnings ({run.result.warnings.length})
                        </summary>
                        {run.result.warnings.map((warning, index) => (
                          <p key={index}>{warning}</p>
                        ))}
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>
    </section>
  )
}
