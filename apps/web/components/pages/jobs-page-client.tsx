'use client'

import Link from 'next/link'
import { DetailLink } from '../detail-link'
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  type JobErrorDetails,
} from '@repo/schemas/job'
import {
  SecondaryColumnFilter,
  SecondaryTableFrame,
  SecondaryTableFooter,
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryTableHead,
  SecondaryVirtualRows,
  useTableColumns,
} from '../secondary-table'
import { TableState } from '@repo/ui/components/ui/table'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
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

function JobRequestError({
  error,
}: {
  error: JobErrorDetails['causes'][number]
}) {
  const { diagnostics, code, retryAt } = error
  const quotaLabels: Record<string, string> = {
    'x-ratelimit-limit': 'Limit',
    'x-ratelimit-remaining': 'Remaining',
    'x-ratelimit-reset': 'Reset',
    'x-discogs-ratelimit': 'Discogs limit',
    'x-discogs-ratelimit-used': 'Discogs used',
    'x-discogs-ratelimit-remaining': 'Discogs remaining',
  }
  return (
    <div className="grid gap-1" aria-label="Request error details">
      <p>
        <strong>
          {diagnostics?.source === 'provider-response'
            ? `Provider response${diagnostics.httpStatus !== undefined ? ` · HTTP ${diagnostics.httpStatus}` : ''}`
            : diagnostics?.source === 'local-cooldown'
              ? 'Local cooldown · No outgoing request'
              : diagnostics?.source === 'local-budget'
                ? 'Local request budget · No outgoing request'
                : diagnostics?.source === 'local-access-halt'
                  ? 'Local access block · No outgoing request'
                  : 'Provider request error'}
        </strong>
      </p>
      {code && <p>Code: {code}</p>}
      {diagnostics?.quotaError && <p>Provider reported a quota error.</p>}
      {diagnostics?.responseReceivedAt && (
        <p>
          Received{' '}
          <time dateTime={diagnostics.responseReceivedAt}>
            {new Date(diagnostics.responseReceivedAt).toLocaleString()}
          </time>
        </p>
      )}
      {diagnostics?.retryAfter && (
        <p>
          Retry-After:{' '}
          {'seconds' in diagnostics.retryAfter ? (
            `${diagnostics.retryAfter.seconds} seconds`
          ) : (
            <time dateTime={diagnostics.retryAfter.at}>
              {new Date(diagnostics.retryAfter.at).toLocaleString()}
            </time>
          )}
        </p>
      )}
      {retryAt !== undefined && retryAt !== null && (
        <>
          <p>
            {diagnostics?.source === 'provider-response'
              ? 'Request retry time'
              : diagnostics
                ? 'Local retry time'
                : 'Recorded retry time'}{' '}
            <time dateTime={new Date(retryAt).toISOString()}>
              {new Date(retryAt).toLocaleString()}
            </time>
          </p>
          {diagnostics?.source === 'provider-response' && (
            <p className="muted">
              Provider cooldowns and dispatch pauses can delay execution.
            </p>
          )}
        </>
      )}
      {diagnostics?.quotaHeaders && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(diagnostics.quotaHeaders).map(([name, value]) => (
            <div key={name} className="flex gap-1" title={name}>
              <dt>{quotaLabels[name] ?? name}:</dt>
              <dd>{value?.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

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
  const requestErrors = new Map<string, JobErrorDetails['causes'][number]>()
  for (const entry of error ? [error, ...error.causes] : []) {
    if (entry.diagnostics || entry.code || entry.retryAt !== undefined) {
      const identity = JSON.stringify({
        code: entry.code,
        retryAt: entry.retryAt,
        diagnostics: entry.diagnostics,
      })
      if (!requestErrors.has(identity)) requestErrors.set(identity, entry)
    }
  }
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
        {[...requestErrors].map(([identity, entry]) => (
          <JobRequestError key={identity} error={entry} />
        ))}
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
  const selectedJobId = search.get('jobId')
  const jobsKey = [
    'jobs',
    'table',
    provider ? null : mediaType,
    statusesKey,
    batchId,
    deferredQuery,
    providersKey,
    sortBy,
    direction,
  ]
  const identity = JSON.stringify(jobsKey)
  const [measured, setMeasured] = useState<{
    identity: string
    rows: Map<string, { index: number; height: number }>
  }>({ identity, rows: new Map() })
  const extraRowHeights = new Map<number, number>()
  if (measured.identity === identity)
    for (const [id, { index, height }] of measured.rows)
      if (expandedJobIds.includes(id) || selectedJobId === id)
        extraRowHeights.set(index, height)
  function observeDetails(
    id: string,
    index: number,
    element: HTMLTableRowElement,
  ) {
    function measure() {
      const height = Math.ceil(element.getBoundingClientRect().height)
      setMeasured((current) => {
        const rows =
          current.identity === identity
            ? current.rows
            : new Map<string, { index: number; height: number }>()
        const prior = rows.get(id)
        if (prior?.index === index && prior.height === height) return current
        return { identity, rows: new Map([...rows, [id, { index, height }]]) }
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }
  const jobs = useVirtualTable({
    queryKey: jobsKey,
    pageSize: 25,
    extraRowHeights,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ ...(!provider ? { mediaType } : {}), sortBy, direction, page: String(page), size: String(size), statuses: statusesKey, providers: providersKey, ...(batchId ? { batchId } : {}), ...(deferredQuery ? { q: deferredQuery } : {}) })}`,
        JobPageSchema,
        { signal },
      ),
    refetchInterval: (page) => (page?.items.some(canCancelJob) ? 3000 : false),
  })
  const setVirtualScroller = jobs.scroller
  const setScroller = useCallback(
    (element: HTMLDivElement | null) => {
      scroller.current = element
      setVirtualScroller(element)
    },
    [setVirtualScroller],
  )
  useEffect(() => {
    setCheckedJobIds([])
    setSelectionAnchor(null)
    setRetryConfirmed(false)
    setExpandedJobIds([])
  }, [identity])
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
  // New jobs can move offset boundaries between reads. Loaded selection stays by job ID.
  const loadedSlots = jobs.loadedSlots
  const jobsById = useMemo(() => {
    const indexed = new Map<string, { item: Job; index: number }>()
    for (const slot of loadedSlots)
      if (!indexed.has(slot.item.id)) indexed.set(slot.item.id, slot)
    return indexed
  }, [loadedSlots])
  useLayoutEffect(() => {
    if (measured.identity !== identity) return
    let rows: typeof measured.rows | undefined
    for (const [id, dimensions] of measured.rows) {
      const index = jobsById.get(id)?.index
      if (index === undefined || index === dimensions.index) continue
      rows ??= new Map(measured.rows)
      rows.set(id, { ...dimensions, index })
    }
    if (rows) setMeasured({ identity, rows })
  }, [identity, jobsById, measured])
  const matchingSelectedJob =
    selectedJob.data &&
    (provider
      ? selectedJob.data.provider === provider
      : jobMatchesScope(selectedJob.data, mediaType))
      ? selectedJob.data
      : undefined
  const selectedIndex = matchingSelectedJob
    ? jobsById.get(matchingSelectedJob.id)?.index
    : undefined
  const pinnedJob =
    selectedIndex === undefined ? matchingSelectedJob : undefined
  const loadedJobs = [...jobsById.values()].map(({ item }) => item)
  const visibleJobs = pinnedJob ? [pinnedJob, ...loadedJobs] : loadedJobs
  let selectedTop =
    selectedIndex === undefined ? undefined : selectedIndex * jobs.rowHeight
  if (selectedTop !== undefined && selectedIndex !== undefined)
    for (const [index, height] of extraRowHeights)
      if (index < selectedIndex) selectedTop += height
  useLayoutEffect(() => {
    if (selectedTop !== undefined)
      scroller.current?.scrollTo({ top: selectedTop })
  }, [selectedJobId, selectedTop])
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
  function renderJobRow(job: Job, index?: number) {
    const dismissal = getJobDismissal(job.options)
    const taskTitle = jobTaskTitle(job)
    const progress = activeJobProgressLabel(job)
    const title =
      taskTitle ??
      job.items.map((item) => item.mediaTitle ?? 'Unavailable item').join(', ')
    const result =
      job.errorMessage ??
      (job.items
        .map((item) => item.message)
        .filter(Boolean)
        .join(' · ') ||
        '-')
    const expanded = expandedJobIds.includes(job.id) || selectedJobId === job.id
    return (
      <Fragment key={job.id}>
        <tr data-selected={selectedIds.includes(job.id) || undefined}>
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
                if (selectedJobId === job.id) setParams({ jobId: '' })
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
                    .map((item) => item.mediaTitle ?? 'Unavailable item')
                    .join(', ')}
                {job.items.length > 2 ? ` +${job.items.length - 2}` : ''}
                {progress && <span className="quiet"> · {progress}</span>}
              </SecondaryCell>
            </td>
          )}
          {columns.visible('status') && (
            <td>
              <SecondaryCell
                text={`${job.status}${dismissal ? ' · dismissed' : ''}`}
              >
                <span className="job-status" data-status={job.status}>
                  {job.status}
                  {dismissal ? ' · dismissed' : ''}
                </span>
              </SecondaryCell>
            </td>
          )}
          {columns.visible('createdAt') && (
            <td className="whitespace-nowrap">
              <SecondaryCell text={new Date(job.createdAt).toLocaleString()}>
                <time dateTime={job.createdAt}>
                  {new Date(job.createdAt).toLocaleString()}
                </time>
              </SecondaryCell>
            </td>
          )}
          {columns.visible('startedAt') && (
            <td className="whitespace-nowrap">
              <SecondaryCell>
                {job.startedAt ? new Date(job.startedAt).toLocaleString() : '-'}
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
            ref={(element) =>
              index === undefined || !element
                ? undefined
                : observeDetails(job.id, index, element)
            }
            id={`job-details-${job.id}`}
            className="secondary-table-detail-row"
          >
            <td colSpan={columns.count + 2}>
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
                    Dismissed {new Date(dismissal.dismissedAt).toLocaleString()}
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
                      <DetailLink kind={item.mediaType} id={item.mediaItemId}>
                        {item.mediaTitle ?? 'Untitled item'}
                      </DetailLink>
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
            </td>
          </tr>
        )}
      </Fragment>
    )
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
        count={`${jobs.total} jobs`}
        columns={columns.controls}
      />
      {pinnedJob && (
        <SecondaryTableScroll
          className="max-h-[min(340px,35dvh)] shrink-0"
          role="region"
          aria-label="Selected job"
        >
          <table className="compact-table" aria-label="Selected job">
            <tbody>{renderJobRow(pinnedJob)}</tbody>
          </table>
        </SecondaryTableScroll>
      )}
      {jobs.isError && jobs.hasTotal && (
        <p role="alert">
          Could not load jobs.{' '}
          <button type="button" onClick={jobs.retry}>
            Retry
          </button>
        </p>
      )}
      <SecondaryTableFrame>
        <SecondaryTableScroll
          className="jobs-scroll"
          ref={setScroller}
          onScroll={jobs.onScroll}
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
              {!jobs.total && (
                <TableState colSpan={columns.count + 2} error={jobs.isError}>
                  {jobs.isPending
                    ? 'Loading jobs...'
                    : jobs.isError
                      ? 'Jobs unavailable.'
                      : 'No matching jobs.'}
                  {jobs.isError && (
                    <button
                      type="button"
                      className="ml-1 underline"
                      onClick={jobs.retry}
                    >
                      Retry
                    </button>
                  )}
                </TableState>
              )}
              {(!jobs.isError || jobs.hasTotal) && (
                <SecondaryVirtualRows
                  window={jobs}
                  colSpan={columns.count + 2}
                  renderRow={(job, index) =>
                    jobsById.get(job.id)?.index === index ? (
                      renderJobRow(job, index)
                    ) : (
                      <tr aria-hidden="true">
                        <td
                          colSpan={columns.count + 2}
                          style={{
                            height: jobs.rowHeight,
                            padding: 0,
                            border: 0,
                          }}
                        />
                      </tr>
                    )
                  }
                />
              )}
            </tbody>
          </table>
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
