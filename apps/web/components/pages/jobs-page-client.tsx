'use client'

import Link from 'next/link'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
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
  JobPageSchema,
  EnrichmentResultSchema,
  JobErrorDetailsSchema,
  getJobDismissal,
  type Job,
} from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import JobBulkActions from '../job-bulk-actions'
import JobDataViewer from '../job-data-viewer'
import JsonTree from '../json-tree'
import { useMediaScope } from '../media-scope'
import { scopedHref } from '@/utils/media-scope'
import { jobMatchesScope, jobMediaScope } from '@/utils/job-media-scope'
import {
  canCancelJob,
  canDismissJob,
  canRetryJob,
  updateJobSelection,
} from '@/utils/job-selection'

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
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const mediaType = useMediaScope()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const status = search.get('status') ?? ''
  const batchId = search.get('batchId') ?? ''
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
    window.history.replaceState(null, '', `/jobs?${params}`)
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
  const jobs = useInfiniteQuery({
    queryKey: ['jobs', 'infinite', mediaType, status, batchId, deferredQuery],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ mediaType, page: String(pageParam), size: '25', ...(status ? { status } : {}), ...(batchId ? { batchId } : {}), ...(deferredQuery ? { q: deferredQuery } : {}) })}`,
        JobPageSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 3000,
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
  }, [mediaType, status, batchId, deferredQuery])
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
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 3000,
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
    if (search.has('mediaType') || !selectedJob.data) return
    const scope = jobMediaScope(selectedJob.data)
    if (scope) {
      const params = new URLSearchParams(window.location.search)
      params.set('mediaType', scope)
      window.history.replaceState(null, '', `/jobs?${params}`)
    }
  }, [search, selectedJob.data])
  const providerName = (id: string) =>
    providers.data?.find((item) => item.id === id)?.displayName ?? id
  // New jobs can move offset boundaries between requests. Keep each job once.
  const jobsById = new Map<string, Job>()
  for (const page of jobs.data?.pages ?? [])
    for (const job of page.items)
      if (!jobsById.has(job.id)) jobsById.set(job.id, job)
  const loadedJobs = [...jobsById.values()]
  const matchingSelectedJob =
    selectedJob.data && jobMatchesScope(selectedJob.data, mediaType)
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
  const completed =
    loadedJobs
      .filter((job) => job.finishedAt)
      .map((job) => `${job.id}:${job.status}`)
      .join(',') ?? ''
  useEffect(() => {
    if (completed)
      void client.invalidateQueries({
        predicate: (query) =>
          ['albums', 'films', 'album', 'film', 'history', 'providers'].includes(
            String(query.queryKey[0]),
          ),
      })
  }, [completed, client])
  return (
    <section className="admin-page jobs-page">
      <h1>{mediaType === 'album' ? 'Album' : 'Film'} jobs</h1>
      {selectedJob.data && !matchingSelectedJob && (
        <p className="muted">
          This job belongs to another library.{' '}
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
      <div className="job-toolbar">
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
        <select
          aria-label="Job status"
          value={status}
          disabled={bulkPending}
          onChange={(event) =>
            setParams({ status: event.target.value, page: '', jobId: '' })
          }
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="attention">Needs attention</option>
          {['queued', 'running', 'succeeded', 'failed', 'cancelled'].map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ),
          )}
        </select>
        <span className="muted">
          {jobs.data?.pages[0]?.totalCount ?? 0} jobs
        </span>
      </div>
      <JobBulkActions
        jobs={actionableJobs}
        selectedIds={selectedIds}
        onSelect={selectJobs}
        onPending={setBulkPending}
        disabled={bulkPending || retryBatch.isPending}
      />
      <div className="jobs-scroll" ref={scroller} aria-busy={jobs.isFetching}>
        {jobs.isPending && (
          <p className="muted" role="status">
            Loading jobs...
          </p>
        )}
        {!jobs.isPending && !jobs.isError && visibleJobs.length === 0 && (
          <p className="muted" role="status">
            No matching jobs.
          </p>
        )}
        <div className="job-list">
          {visibleJobs.map((job) => {
            const dismissal = getJobDismissal(job.options)
            return (
              <details
                key={job.id}
                data-selected={selectedIds.includes(job.id) || undefined}
                open={search.get('jobId') === job.id ? true : undefined}
                onToggle={(event) => {
                  if (event.target !== event.currentTarget) return
                  const open = event.currentTarget.open
                  setExpandedJobIds((ids) =>
                    open
                      ? ids.includes(job.id)
                        ? ids
                        : [...ids, job.id]
                      : ids.filter((id) => id !== job.id),
                  )
                }}
              >
                <summary>
                  {actionableIds.includes(job.id) ? (
                    <input
                      type="checkbox"
                      className="job-select"
                      aria-label={`Select ${providerName(job.provider)} job for ${job.items[0]?.mediaTitle ?? 'unavailable item'}`}
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
                  <ChevronRight
                    size={14}
                    className="job-chevron"
                    aria-hidden="true"
                  />
                  <strong>{providerName(job.provider)}</strong>
                  <span className="job-titles">
                    {job.items
                      .slice(0, 2)
                      .map((item) => item.mediaTitle ?? 'Unavailable item')
                      .join(', ')}
                    {job.items.length > 2 ? ` +${job.items.length - 2}` : ''}
                  </span>
                  <span className="job-status" data-status={job.status}>
                    {job.status}
                    {dismissal ? ' · dismissed' : ''}
                  </span>
                  <time dateTime={job.createdAt}>
                    {new Date(job.createdAt).toLocaleString()}
                  </time>
                </summary>
                <div className="job-content">
                  {job.errorMessage && <p role="alert">{job.errorMessage}</p>}
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
                      {new Date(dismissal.dismissedAt).toLocaleString()}. Errors
                      retained.
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
                  <JobDataViewer
                    job={job}
                    visible={expandedJobIds.includes(job.id)}
                  />
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
                        {item.attemptCount === 1 ? 'attempt' : 'attempts'}
                      </span>
                      {item.message && item.message !== job.errorMessage && (
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
                        <JobLogEntry key={log.id} log={log} jobId={job.id} />
                      ))}
                    </ol>
                  </details>
                </div>
              </details>
            )
          })}
        </div>
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
      </div>
    </section>
  )
}
