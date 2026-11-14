'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ImportStatusSchema,
  ImportRunSchema,
  type ImportRun,
} from '@repo/schemas/imports'
import { fetchApiData } from '@/utils/api'
import { importIdlePollMs, importPollInterval } from '@/utils/import-cache'
import { useConfig } from '@/components/providers'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryDataTable,
} from '../secondary-table'
import { useMediaScope } from '@/components/media-scope'
import { scopedHref } from '@/utils/media-scope'
import { ImportStatusNotice } from '@/components/imports-workspace'

function resultSummary(run: ImportRun) {
  return run.result
    ? `${run.result.created !== undefined ? `${run.result.created} new items, ${run.result.updated ?? 0} changed, ${run.result.unchanged ?? 0} unchanged` : `${run.result.albums} albums, ${run.result.films} film rows`}${run.result.skipped ? `, ${run.result.skipped} skipped` : ''}${run.result.failed ? `, ${run.result.failed} failed` : ''}`
    : (run.errorMessage ?? '-')
}

export default function ImportsPageClient() {
  const [status, setStatus] = useState<ImportRun['status'][]>([])
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
    staleTime: importIdlePollMs,
    refetchInterval: (query) => importPollInterval(query.state.data?.runs),
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
          rows={runs.filter(
            (run) => !status.length || status.includes(run.status),
          )}
          totalCount={runs.length}
          countLabel="imports"
          search={{
            label: 'Search imports',
            placeholder: 'Search stage or error',
            value: (run) => `${run.stage} ${run.errorMessage ?? ''}`,
          }}
          rowKey={(run) => run.id}
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          busy={query.isFetching}
          error={query.isError}
          empty={
            query.isPending
              ? 'Loading imports...'
              : query.isError
                ? 'Imports unavailable.'
                : status.length
                  ? 'No matching imports.'
                  : 'No imports yet.'
          }
          columns={[
            {
              key: 'createdAt',
              label: 'Started',
              value: (run) => Date.parse(run.createdAt),
              render: (run) => (
                <SecondaryCell
                  text={new Date(run.createdAt).toLocaleString()}
                  label="Import scope details"
                  tone={run.mediaType === null ? 'warning' : undefined}
                  details={
                    run.mediaType === null
                      ? 'Mixed / legacy scope unknown'
                      : undefined
                  }
                >
                  {new Date(run.createdAt).toLocaleString()}
                </SecondaryCell>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              filter: (
                <SecondaryColumnFilter
                  label="Import status"
                  options={ImportRunSchema.shape.status.options.map(
                    (value) => ({ value, label: value }),
                  )}
                  value={status}
                  onChange={setStatus}
                />
              ),
              value: (run) => run.status,
              render: (run) => (
                <SecondaryCell text={run.status}>
                  <span className="job-status" data-status={run.status}>
                    {run.status}
                  </span>
                </SecondaryCell>
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
                <SecondaryCell
                  text={resultSummary(run)}
                  label="Import result details"
                  details={
                    (run.result && run.errorMessage) ||
                    run.result?.jobBatchId ||
                    run.result?.warnings?.length ? (
                      <>
                        <p>{resultSummary(run)}</p>
                        {run.result && run.errorMessage && (
                          <p>{run.errorMessage}</p>
                        )}
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
                          <div>
                            <p>Warnings ({run.result.warnings.length})</p>
                            {run.result.warnings.map((warning, index) => (
                              <p key={index}>{warning}</p>
                            ))}
                          </div>
                        )}
                      </>
                    ) : undefined
                  }
                >
                  {resultSummary(run)}
                </SecondaryCell>
              ),
            },
            {
              key: 'finishedAt',
              label: 'Finished',
              defaultVisible: false,
              value: (run) =>
                run.finishedAt ? Date.parse(run.finishedAt) : null,
              render: (run) => (
                <SecondaryCell>
                  {run.finishedAt
                    ? new Date(run.finishedAt).toLocaleString()
                    : '-'}
                </SecondaryCell>
              ),
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
