'use client'

import Link from 'next/link'
import { Fragment, useDeferredValue, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { ChevronRight } from 'lucide-react'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import { JsonValueSchema } from '@repo/schemas/common'
import {
  JobSchema,
  JobSortKeySchema,
  JobListQuerySchema,
  jobStatusFilters,
  type JobSortKey,
  JobPageSchema,
  EnrichmentResultSchema,
  JobErrorDetailsSchema,
  getJobDismissal,
  type Job,
} from '@repo/schemas/job'
import {
  SecondaryColumnFilter,
  SecondaryTableFrame,
  SecondaryTableFooter,
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryTableHead,
  useTableColumns,
} from '../secondary-table'
import { TableState } from '@repo/ui/components/ui/table'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import { jobPagesPollInterval } from '@/utils/job-cache'
import JobBulkActions from '../job-bulk-actions'
import JobDataViewer from '../job-data-viewer'
import JsonTree from '../json-tree'
import { useWorkspaceScope } from '../media-scope'
import { scopedHref, type WorkspaceScope } from '@/utils/media-scope'
import { jobMatchesScope, jobMediaScope } from '@/utils/job-media-scope'
import {
  activeJobProgressLabel,
  canCancelJob,
  canDismissJob,
  canRetryJob,
  jobTaskTitle,
  updateJobSelection,
} from '@/utils/job-selection'

const jobsHeadings: Record<WorkspaceScope, string> = {
  album: 'Album jobs',
  film: 'Film jobs',
  subscription: 'Subscription jobs',
}
const jobColumns: {
  key: JobSortKey
  label: string
  defaultVisible?: boolean
}[] = [
  { key: 'provider', label: 'Provider' },
  { key: 'title', label: 'Job' },
  { key: 'status', label: 'Status' },
  { key: 'createdAt', label: 'Created' },
  { key: 'startedAt', label: 'Started', defaultVisible: false },
  { key: 'finishedAt', label: 'Finished', defaultVisible: false },
  { key: 'result', label: 'Result', defaultVisible: false },
]
const ErrorMetadataSchema = z.object({ error: JobErrorDetailsSchema })
const DiagnosticMetadataSchema = z.object({ diagnostics: JsonValueSchema })
const LegacyJobContextSchema = z.object({
  jobHistorySplit: z.object({ context: z.literal('legacy-batch') }),
})

export function JobLogEntry({
  log,
  jobId,
}: {
  log: Job['logs'][number]
  jobId: string
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const review = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/${jobId}/logs/${log.id}/benign`,
        JobSchema,
        {
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        },
      ),
    onSuccess: async () => {
      setConfirming(false)
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
    },
  })
  const parsed = ErrorMetadataSchema.safeParse(log.metadata)
  const error = parsed.success ? parsed.data.error : null
  const diagnosticMetadata = DiagnosticMetadataSchema.safeParse(log.metadata)
  return (
    <li className="job-log" data-level={log.level}>
      <time dateTime={log.createdAt}>
        {new Date(log.createdAt).toLocaleTimeString()}
      </time>
      <span className="job-log-level">{log.level}</span>
      <div>
        <p>{log.message}</p>
        {LegacyJobContextSchema.safeParse(log.metadata).success && (
          <p className="muted">
            Original batch context, not an item-specific event.
          </p>
        )}
        {log.benignReview ? (
          <p className="muted">
            Marked benign ·{' '}
            {new Date(log.benignReview.reviewedAt).toLocaleString()}
          </p>
        ) : log.canMarkBenign ? (
          <div>
            {confirming && (
              <p className="muted">
                Only this error will be dismissed. No retry, limit reset or rule
                for future errors.
              </p>
            )}
            <Button
              variant="outline"
              disabled={review.isPending}
              onClick={() =>
                confirming ? review.mutate() : setConfirming(true)
              }
            >
              {review.isPending
                ? 'Saving...'
                : confirming
                  ? 'Confirm benign'
                  : 'Mark benign'}
            </Button>
            {confirming && (
              <Button
                variant="ghost"
                disabled={review.isPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            )}
            {review.isError && <p role="alert">{review.error.message}</p>}
          </div>
        ) : null}
        {error ? (
          <pre className="job-error">
            {[
              error.stack ?? `${error.name}: ${error.message}`,
              ...error.causes.map(
                (cause) =>
                  `Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`,
              ),
            ].join('\n\n')}
          </pre>
        ) : log.level === 'error' ? (
          <p className="muted">
            No error details were recorded for this entry.
          </p>
        ) : null}
        {diagnosticMetadata.success &&
          diagnosticMetadata.data.diagnostics !== null && (
            <details
              onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
            >
              <summary>Diagnostics</summary>
              {diagnosticsOpen && (
                <JsonTree value={diagnosticMetadata.data.diagnostics} />
              )}
            </details>
          )}
      </div>
    </li>
  )
}

export default function JobsPageClient() {
  return <JobsTable />
}

export function JobsTable({ provider }: { provider?: string }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const mediaType = useWorkspaceScope()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const parsedStatuses = JobListQuerySchema.shape.statuses.safeParse(
    search.get('statuses') ?? undefined,
  )
  const parsedStatus = JobListQuerySchema.shape.status.safeParse(
    search.get('status') ?? undefined,
  )
  const statuses =
    parsedStatuses.success && parsedStatuses.data.length
      ? parsedStatuses.data
      : parsedStatus.success && parsedStatus.data
        ? [parsedStatus.data]
        : []
  const parsedProviders = JobListQuerySchema.shape.providers.safeParse(
    search.get('providers') ?? undefined,
  )
  const selectedProviders = provider
    ? [provider]
    : parsedProviders.success && parsedProviders.data.length
      ? parsedProviders.data
      : search.get('provider')
        ? [search.get('provider') ?? '']
        : []
  const statusesKey = JSON.stringify(statuses)
  const providersKey = JSON.stringify(selectedProviders)
  const batchId = provider ? '' : (search.get('batchId') ?? '')
  const parsedSort = JobSortKeySchema.safeParse(search.get('sortBy'))
  const sortBy = parsedSort.success ? parsedSort.data : 'createdAt'
  const direction = search.get('direction') === 'asc' ? 'asc' : 'desc'
  const columns = useTableColumns(
    provider ? `provider-jobs-${provider}` : `jobs-${mediaType}`,
    jobColumns,
  )
  const shownColumns = jobColumns.filter((column) =>
    columns.visible(column.key),
  )
  const selectAll = useRef<HTMLInputElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [retryConfirmed, setRetryConfirmed] = useState(false)
  const [checkedJobIds, setCheckedJobIds] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [bulkPending, setBulkPending] = useState(false)
  const [expandedJobIds, setExpandedJobIds] = useState<string[]>([])
  function setParams(updates: Record<string, string>) {
    const params = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`,
    )
  }
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
      ),
  })
  const providerOptions = (providers.data ?? []).filter((item) =>
    mediaType === 'subscription'
      ? item.subscriptions
      : item.mediaTypes.some((kind) => kind === mediaType),
  )
  const jobs = useInfiniteQuery({
    queryKey: [
      'jobs',
      'infinite',
      provider ? null : mediaType,
      statusesKey,
      batchId,
      deferredQuery,
      providersKey,
      sortBy,
      direction,
    ],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ ...(!provider ? { mediaType } : {}), sortBy, direction, page: String(pageParam), size: '25', statuses: statusesKey, providers: providersKey, ...(batchId ? { batchId } : {}), ...(deferredQuery ? { q: deferredQuery } : {}) })}`,
        JobPageSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
    refetchInterval: (query) => jobPagesPollInterval(query.state.data?.pages),
  })
  const { hasNextPage, isFetching, isError, fetchNextPage } = jobs
  useEffect(() => {
    if (
      !sentinel.current ||
      !scroller.current ||
      !hasNextPage ||
      isFetching ||
      isError
    )
      return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void fetchNextPage({ cancelRefetch: false })
      },
      { root: scroller.current, rootMargin: '300px' },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [hasNextPage, isFetching, isError, fetchNextPage])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    setCheckedJobIds([])
    setSelectionAnchor(null)
    setRetryConfirmed(false)
  }, [
    mediaType,
    statusesKey,
    batchId,
    deferredQuery,
    providersKey,
    sortBy,
    direction,
  ])
  const selectedJobId = search.get('jobId')
  const selectedJob = useQuery({
    queryKey: ['jobs', 'detail', selectedJobId],
    enabled: !!selectedJobId,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/${selectedJobId}`,
        JobSchema,
      ),
    refetchInterval: (query) =>
      query.state.data && canCancelJob(query.state.data) ? 3000 : false,
  })
  const retryBatch = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/batches/${batchId}/retry`,
        EnrichmentResultSchema,
        {
          method: 'POST',
          body: JSON.stringify({ confirmBroadRun: retryConfirmed }),
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      setRetryConfirmed(false)
    },
  })
  useEffect(() => {
    if (provider || search.has('mediaType') || !selectedJob.data) return
    const scope = jobMediaScope(selectedJob.data)
    if (scope) {
      const params = new URLSearchParams(window.location.search)
      params.set('mediaType', scope)
      window.history.replaceState(null, '', `/jobs?${params}`)
    }
  }, [provider, search, selectedJob.data])
  const providerName = (id: string) =>
    providers.data?.find((item) => item.id === id)?.displayName ?? id
  // New jobs can move offset boundaries between requests. Keep each job once.
  const jobsById = new Map<string, Job>()
  for (const page of jobs.data?.pages ?? [])
    for (const job of page.items)
      if (!jobsById.has(job.id)) jobsById.set(job.id, job)
  const loadedJobs = [...jobsById.values()]
  const matchingSelectedJob =
    selectedJob.data &&
    (provider
      ? selectedJob.data.provider === provider
      : jobMatchesScope(selectedJob.data, mediaType))
      ? selectedJob.data
      : undefined
  const visibleJobs = matchingSelectedJob
    ? [
        matchingSelectedJob,
        ...loadedJobs.filter((job) => job.id !== matchingSelectedJob.id),
      ]
    : loadedJobs
  const actionableJobs = visibleJobs.filter(
    (job) => canRetryJob(job) || canDismissJob(job) || canCancelJob(job),
  )
  const actionableIds = actionableJobs.map((job) => job.id)
  const selectedIds = checkedJobIds.filter((id) => actionableIds.includes(id))
  const allChecked =
    actionableIds.length > 0 &&
    actionableIds.every((id) => selectedIds.includes(id))
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = selectedIds.length > 0 && !allChecked
  }, [selectedIds.length, allChecked])
  function selectJobs(ids: string[]) {
    setCheckedJobIds(ids)
    setSelectionAnchor(null)
  }
  function toggleJob(id: string, checked: boolean, shift: boolean) {
    const next = updateJobSelection(
      selectedIds,
      actionableIds,
      id,
      selectionAnchor,
      shift,
      checked,
    )
    setCheckedJobIds(next)
    if (!shift || !selectionAnchor || !actionableIds.includes(selectionAnchor))
      setSelectionAnchor(id)
  }
  return (
    <section className="admin-page jobs-page">
      {!provider && <h1>{jobsHeadings[mediaType]}</h1>}
      {selectedJob.data && !matchingSelectedJob && (
        <p className="muted">
          This job belongs to another {provider ? 'provider' : 'library'}.{' '}
          <Link
            href={scopedHref(
              `/jobs?jobId=${selectedJob.data.id}`,
              jobMediaScope(selectedJob.data) ?? 'film',
            )}
          >
            Open {jobMediaScope(selectedJob.data)} job
          </Link>
        </p>
      )}
      {jobs.isError && !jobs.isFetchNextPageError && (
        <p role="alert">
          Could not load jobs.{' '}
          <button onClick={() => jobs.refetch()}>Retry</button>
        </p>
      )}
      {batchId && (
        <div className="batch-actions">
          <strong>Import / refresh jobs</strong>
          <Link href={scopedHref('/jobs', mediaType)}>All jobs</Link>
          {!retryConfirmed && (
            <Button
              size="sm"
              variant="outline"
              disabled={retryBatch.isPending || bulkPending}
              onClick={() => setRetryConfirmed(true)}
            >
              Review batch retry
            </Button>
          )}
          {retryConfirmed && (
            <div
              className="job-action-review"
              role="region"
              aria-label="Review batch retry"
            >
              <p>
                Queue all unfinished work in this batch, including jobs beyond
                the loaded list. Provider limits and cooldowns apply.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={retryBatch.isPending || bulkPending}
                  onClick={() => retryBatch.mutate()}
                >
                  Confirm retry entire batch
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={retryBatch.isPending}
                  onClick={() => setRetryConfirmed(false)}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
          {retryBatch.isError && <p role="alert">{retryBatch.error.message}</p>}
          {retryBatch.data && (
            <p role="status">
              {retryBatch.data.queued} queued, {retryBatch.data.skipped}{' '}
              skipped.
              {retryBatch.data.warnings.map((warning) => (
                <span className="block" key={warning}>
                  {warning}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      {selectedJob.isError && (
        <p role="alert">Could not load the selected job.</p>
      )}
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search jobs"
            placeholder="Search titles or providers"
            value={query}
            disabled={bulkPending}
            onChange={(event) => {
              setQuery(event.target.value)
              setParams({ page: '' })
            }}
          />
        }
        count={`${jobs.data?.pages[0]?.totalCount ?? 0} jobs`}
        columns={columns.controls}
      />
      <SecondaryTableFrame>
        <SecondaryTableScroll
          className="jobs-scroll"
          ref={scroller}
          role="region"
          aria-label="Jobs"
          aria-busy={jobs.isFetching}
        >
          <table className="compact-table" aria-label="Jobs">
            <thead>
              <tr>
                <th scope="col" className="table-selection-cell">
                  <input
                    ref={selectAll}
                    type="checkbox"
                    aria-label="Select all loaded eligible jobs"
                    checked={allChecked}
                    disabled={
                      bulkPending ||
                      retryBatch.isPending ||
                      !actionableIds.length
                    }
                    onChange={(event) =>
                      selectJobs(event.target.checked ? actionableIds : [])
                    }
                  />
                </th>
                <th scope="col">
                  <span className="sr-only">Details</span>
                </th>
                {shownColumns.map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    filter={
                      column.key === 'status' ? (
                        <SecondaryColumnFilter
                          label="Job status"
                          options={jobStatusFilters}
                          value={statuses}
                          disabled={bulkPending}
                          onChange={(next) =>
                            setParams({
                              statuses: next.length ? JSON.stringify(next) : '',
                              status: '',
                              page: '',
                              jobId: '',
                            })
                          }
                        />
                      ) : column.key === 'provider' && !provider ? (
                        <SecondaryColumnFilter
                          label="Job provider"
                          options={[
                            ...providerOptions.map((item) => ({
                              value: item.id,
                              label: item.displayName,
                            })),
                            ...selectedProviders
                              .filter(
                                (id) =>
                                  !providerOptions.some(
                                    (item) => item.id === id,
                                  ),
                              )
                              .map((id) => ({ value: id, label: id })),
                          ]}
                          value={selectedProviders}
                          disabled={bulkPending}
                          onChange={(next) =>
                            setParams({
                              providers: next.length
                                ? JSON.stringify(next)
                                : '',
                              provider: '',
                              page: '',
                              jobId: '',
                            })
                          }
                        />
                      ) : undefined
                    }
                    sortBy={sortBy}
                    direction={direction}
                    disabled={bulkPending || retryBatch.isPending}
                    onSort={(key) =>
                      setParams({
                        sortBy: key,
                        direction:
                          key === sortBy && direction === 'asc'
                            ? 'desc'
                            : 'asc',
                        jobId: '',
                      })
                    }
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {!visibleJobs.length && (
                <TableState colSpan={columns.count + 2} error={jobs.isError}>
                  {jobs.isPending
                    ? 'Loading jobs...'
                    : jobs.isError
                      ? 'Jobs unavailable.'
                      : 'No matching jobs.'}
                </TableState>
              )}
              {visibleJobs.map((job) => {
                const dismissal = getJobDismissal(job.options)
                const taskTitle = jobTaskTitle(job)
                const progress = activeJobProgressLabel(job)
                const title =
                  taskTitle ??
                  job.items
                    .map((item) => item.mediaTitle ?? 'Unavailable item')
                    .join(', ')
                const result =
                  job.errorMessage ??
                  (job.items
                    .map((item) => item.message)
                    .filter(Boolean)
                    .join(' · ') ||
                    '-')
                const expanded =
                  expandedJobIds.includes(job.id) || selectedJobId === job.id
                return (
                  <Fragment key={job.id}>
                    <tr
                      data-selected={selectedIds.includes(job.id) || undefined}
                    >
                      <td className="table-selection-cell">
                        {actionableIds.includes(job.id) ? (
                          <input
                            type="checkbox"
                            className="job-select"
                            aria-label={`Select ${providerName(job.provider)} job for ${taskTitle ?? job.items[0]?.mediaTitle ?? 'unavailable item'}`}
                            title="Shift-click to select a range"
                            disabled={bulkPending || retryBatch.isPending}
                            checked={selectedIds.includes(job.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              toggleJob(
                                job.id,
                                event.target.checked,
                                'shiftKey' in event.nativeEvent &&
                                  event.nativeEvent.shiftKey === true,
                              )
                            }
                          />
                        ) : (
                          <span aria-hidden="true" />
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="flex items-center"
                          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${providerName(job.provider)} job`}
                          aria-expanded={expanded}
                          aria-controls={`job-details-${job.id}`}
                          onClick={() => {
                            if (selectedJobId === job.id)
                              setParams({ jobId: '' })
                            setExpandedJobIds((ids) =>
                              expanded
                                ? ids.filter((id) => id !== job.id)
                                : [...ids, job.id],
                            )
                          }}
                        >
                          <ChevronRight
                            size={14}
                            aria-hidden="true"
                            className={expanded ? 'rotate-90' : ''}
                          />
                        </button>
                      </td>
                      {columns.visible('provider') && (
                        <td>
                          <SecondaryCell text={providerName(job.provider)}>
                            {providerName(job.provider)}
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('title') && (
                        <td>
                          <SecondaryCell
                            text={`${title}${progress ? ` · ${progress}` : ''}`}
                          >
                            {taskTitle ??
                              job.items
                                .slice(0, 2)
                                .map(
                                  (item) =>
                                    item.mediaTitle ?? 'Unavailable item',
                                )
                                .join(', ')}
                            {job.items.length > 2
                              ? ` +${job.items.length - 2}`
                              : ''}
                            {progress && (
                              <span className="quiet"> · {progress}</span>
                            )}
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('status') && (
                        <td>
                          <SecondaryCell
                            text={`${job.status}${dismissal ? ' · dismissed' : ''}`}
                          >
                            <span
                              className="job-status"
                              data-status={job.status}
                            >
                              {job.status}
                              {dismissal ? ' · dismissed' : ''}
                            </span>
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('createdAt') && (
                        <td className="whitespace-nowrap">
                          <SecondaryCell
                            text={new Date(job.createdAt).toLocaleString()}
                          >
                            <time dateTime={job.createdAt}>
                              {new Date(job.createdAt).toLocaleString()}
                            </time>
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('startedAt') && (
                        <td className="whitespace-nowrap">
                          <SecondaryCell>
                            {job.startedAt
                              ? new Date(job.startedAt).toLocaleString()
                              : '-'}
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('finishedAt') && (
                        <td className="whitespace-nowrap">
                          <SecondaryCell>
                            {job.finishedAt
                              ? new Date(job.finishedAt).toLocaleString()
                              : '-'}
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('result') && (
                        <td>
                          <SecondaryCell text={result}>{result}</SecondaryCell>
                        </td>
                      )}
                    </tr>
                    {expanded && (
                      <tr
                        id={`job-details-${job.id}`}
                        className="secondary-table-detail-row"
                      >
                        <td colSpan={columns.count + 2}>
                          <div className="job-content">
                            {job.errorMessage && (
                              <p role="alert">{job.errorMessage}</p>
                            )}
                            <JobBulkActions
                              jobs={[job]}
                              selectedIds={[job.id]}
                              single
                              disabled={bulkPending || retryBatch.isPending}
                              onSelect={() => {}}
                              onPending={setBulkPending}
                            />
                            {dismissal && (
                              <p className="muted">
                                Dismissed{' '}
                                {new Date(
                                  dismissal.dismissedAt,
                                ).toLocaleString()}
                                . Errors retained.
                              </p>
                            )}
                            {typeof job.options.retryJobId === 'string' && (
                              <Link
                                href={scopedHref(
                                  `/jobs?jobId=${job.options.retryJobId}`,
                                  jobMediaScope(job) ?? mediaType,
                                )}
                              >
                                View retry
                              </Link>
                            )}
                            <JobDataViewer job={job} visible={expanded} />
                            {job.items.map((item) => (
                              <p
                                key={item.id}
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                              >
                                {item.mediaItemId && item.mediaType ? (
                                  <Link
                                    href={`/${item.mediaType === 'album' ? 'albums' : 'films'}/${item.mediaItemId}`}
                                  >
                                    {item.mediaTitle ?? 'Untitled item'}
                                  </Link>
                                ) : (
                                  'Unavailable item'
                                )}
                                <span className="muted">
                                  {item.attemptCount}{' '}
                                  {item.attemptCount === 1
                                    ? 'attempt'
                                    : 'attempts'}
                                </span>
                                {item.message &&
                                  item.message !== job.errorMessage && (
                                    <span>{item.message}</span>
                                  )}
                              </p>
                            ))}
                            <details
                              className="job-logs"
                              open={job.status === 'failed' ? true : undefined}
                            >
                              <summary>Log ({job.logs.length})</summary>
                              <ol>
                                {job.logs.map((log) => (
                                  <JobLogEntry
                                    key={log.id}
                                    log={log}
                                    jobId={job.id}
                                  />
                                ))}
                              </ol>
                            </details>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          <div
            ref={sentinel}
            className="py-3 text-center text-sm text-muted-foreground"
          >
            {jobs.isFetchingNextPage && (
              <span role="status">Loading more jobs...</span>
            )}
            {jobs.isFetchNextPageError && (
              <p role="alert">
                Could not load more jobs.{' '}
                <button
                  onClick={() => jobs.fetchNextPage({ cancelRefetch: false })}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
        </SecondaryTableScroll>
        <SecondaryTableFooter selectedCount={selectedIds.length}>
          <JobBulkActions
            jobs={actionableJobs}
            selectedIds={selectedIds}
            onSelect={selectJobs}
            onPending={setBulkPending}
            disabled={bulkPending || retryBatch.isPending}
          />
        </SecondaryTableFooter>
      </SecondaryTableFrame>
    </section>
  )
}
