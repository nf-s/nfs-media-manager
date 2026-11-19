'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ImportStatusSchema,
  ImportRunSchema,
  type ImportRun,
} from '@repo/schemas/imports'
import { Button } from '@repo/ui/components/ui/button'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { EMPTY_VALUE, formatCount, formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { importIdlePollMs, importPollInterval } from '@/utils/import-cache'
import { runStatusLabel, runStatusStates } from '@/utils/run-status'
import { useConfig } from '@/components/providers'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryDataTable,
} from '../secondary-table'
import { useMediaScope } from '@/components/media-scope'
import { scopedHref } from '@/utils/media-scope'
import { ImportStatusNotice } from '@/components/imports-workspace'

/** What an import did, in words: created, updated, unchanged, skipped, failed. */
export function resultSummary(run: ImportRun) {
  if (!run.result) return run.errorMessage ?? EMPTY_VALUE
  const { result } = run
  const counts =
    result.created !== undefined
      ? [
          `${formatCount(result.created)} created`,
          `${formatCount(result.updated ?? 0)} updated`,
          ...(result.unchanged
            ? [`${formatCount(result.unchanged)} unchanged`]
            : []),
        ]
      : [
          `${formatCount(result.albums)} albums`,
          `${formatCount(result.films)} films`,
        ]
  return [
    ...counts,
    ...(result.skipped ? [`${formatCount(result.skipped)} skipped`] : []),
    ...(result.failed ? [`${formatCount(result.failed)} failed`] : []),
  ].join(' · ')
}

/** A queued or running import's progress bar, or a finished import's counts. */
export function ImportProgress({ run }: { run: ImportRun }) {
  const active = run.status === 'queued' || run.status === 'running'
  if (!run.total) return <span className="ds-muted">{EMPTY_VALUE}</span>
  if (active) return <Progress done={run.processed} total={run.total} />
  return (
    <>
      {formatCount(run.processed)} of {formatCount(run.total)}
    </>
  )
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
    <section className="sec-page">
      <PageHead title={`Recent ${mediaType} imports`} />
      <div className="sec-notices">
        <ImportStatusNotice />
        {query.isError && (
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={() => query.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load {mediaType} import history.
          </Notice>
        )}
      </div>
      <SecondaryDataTable
        id={`import-history-${mediaType}`}
        label={`Recent ${mediaType} imports`}
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
          query.isPending ? (
            <Skeleton width="40%" height={12} />
          ) : query.isError ? (
            'Could not load imports.'
          ) : status.length ? (
            'No imports match.'
          ) : (
            'No imports yet.'
          )
        }
        columns={[
          {
            key: 'createdAt',
            label: 'Started',
            width: 170,
            sticky: 0,
            stickyEdge: true,
            value: (run) => Date.parse(run.createdAt),
            render: (run) => (
              <SecondaryCell
                text={formatDateTime(run.createdAt)}
                label="Import scope details"
                tone={run.mediaType === null ? 'warning' : undefined}
                details={
                  run.mediaType === null
                    ? 'Mixed / legacy scope unknown'
                    : undefined
                }
              >
                {formatDateTime(run.createdAt)}
              </SecondaryCell>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            width: 130,
            filter: (
              <SecondaryColumnFilter
                label="Import status"
                options={ImportRunSchema.shape.status.options.map((value) => ({
                  value,
                  label: runStatusLabel(value),
                }))}
                value={status}
                onChange={setStatus}
              />
            ),
            value: (run) => run.status,
            render: (run) => <Status state={runStatusStates[run.status]} />,
          },
          {
            key: 'stage',
            label: 'Stage',
            width: 140,
            value: (run) => run.stage,
          },
          {
            key: 'progress',
            label: 'Progress',
            width: 140,
            value: (run) => (run.total ? run.processed / run.total : null),
            render: (run) => <ImportProgress run={run} />,
          },
          {
            key: 'processed',
            label: 'Processed',
            width: 100,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.processed,
          },
          {
            key: 'total',
            label: 'Total',
            width: 90,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.total,
          },
          {
            key: 'result',
            label: 'Result',
            width: 320,
            value: (run) => run.errorMessage ?? resultSummary(run),
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
                            {formatCount(run.result.queuedJobs ?? 0)} metadata
                            jobs
                          </Link>
                          {!!run.result.skippedJobs &&
                            ` · ${formatCount(run.result.skippedJobs)} already scraped, queued or awaiting IDs/credentials`}
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
            width: 150,
            defaultVisible: false,
            value: (run) =>
              run.finishedAt ? Date.parse(run.finishedAt) : null,
            render: (run) => (
              <SecondaryCell>{formatDateTime(run.finishedAt)}</SecondaryCell>
            ),
          },
          {
            key: 'created',
            label: 'Created',
            width: 90,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.result?.created,
          },
          {
            key: 'updated',
            label: 'Updated',
            width: 90,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.result?.updated,
          },
          {
            key: 'unchanged',
            label: 'Unchanged',
            width: 100,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.result?.unchanged,
          },
          {
            key: 'skipped',
            label: 'Skipped',
            width: 90,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.result?.skipped,
          },
          {
            key: 'failed',
            label: 'Failed',
            width: 80,
            defaultVisible: false,
            align: 'end',
            value: (run) => run.result?.failed,
          },
        ]}
      />
    </section>
  )
}
