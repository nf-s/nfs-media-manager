'use client'

import Link from 'next/link'
import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'next/navigation'
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { supportsArtistEnrichment } from '@/utils/artist-providers'
import {
  JobSortKeySchema,
  JobListQuerySchema,
  jobStatusFilters,
  type JobSortKey,
  JobPageSchema,
  JobEntryPageSchema,
  EnrichmentResultSchema,
  getJobDismissal,
  type Job,
  type JobBatchEntry,
  type JobEntry,
  type JobEntryPage,
  type JobPage,
} from '@repo/schemas/job'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Status, statusLabels } from '@repo/ui/components/ds/status'
import {
  Select,
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import {
  TableHead,
  TableRow,
  TableCell,
  TableSelectionBar,
  TableState,
} from '@repo/ui/components/ui/table'
import { Button } from '@repo/ui/components/ui/button'
import {
  EMPTY_VALUE,
  formatCount,
  formatDateTime,
  formatElapsed,
  formatItemCount,
  formatUntil,
} from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { systemLibraryFilter, type WorkspaceScope } from '@/utils/media-scope'
import {
  activeJobProgressLabel,
  canCancelJob,
  canDismissJob,
  canRetryJob,
  jobTaskTitle,
  updateJobSelection,
} from '@/utils/job-selection'
import {
  batchDone,
  batchResult,
  batchStatus,
  batchTarget,
  batchTitle,
  entryKey,
  formatWhen,
  jobResult,
  jobStatus,
  jobTitle,
} from '@/utils/job-entries'
import {
  providerDisplayName,
  providerListOptions,
} from '@/utils/provider-health'
import { DetailLink } from './detail-link'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { useConfig } from './providers'
import JobBulkActions, {
  unfinishedBatchJobs,
  type JobActionRequest,
} from './job-bulk-actions'
import {
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'

const rowHeight = 32
const headerHeight = 28
/** Width of the selection column, which the job column is pinned after. */
const selectionWidth = 36
const batchPageSize = 25

const libraryOptions: { value: WorkspaceScope | ''; label: string }[] = [
  { value: '', label: 'All libraries' },
  { value: 'album', label: 'Albums' },
  { value: 'film', label: 'Films' },
  { value: 'artist', label: 'Artists' },
  { value: 'subscription', label: 'Subscriptions' },
]

type ColumnKey =
  | 'title'
  | 'status'
  | 'provider'
  | 'progress'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
  | 'duration'
  | 'result'

const jobColumns: {
  key: ColumnKey
  label: string
  sort?: JobSortKey
  align?: 'end'
  defaultVisible?: boolean
  required?: boolean
}[] = [
  { key: 'title', label: 'Job', sort: 'title', required: true },
  { key: 'status', label: 'Status', sort: 'status' },
  { key: 'provider', label: 'Provider', sort: 'provider' },
  { key: 'progress', label: 'Progress' },
  { key: 'createdAt', label: 'Created', sort: 'createdAt' },
  {
    key: 'startedAt',
    label: 'Started',
    sort: 'startedAt',
    defaultVisible: false,
  },
  {
    key: 'finishedAt',
    label: 'Finished',
    sort: 'finishedAt',
    defaultVisible: false,
  },
  { key: 'duration', label: 'Duration', align: 'end' },
  { key: 'result', label: 'Result', sort: 'result' },
]

type RowItem = Job | JobEntry

function asEntry(item: RowItem): JobEntry {
  return 'kind' in item ? item : { kind: 'job', job: item }
}

function elapsed(
  startedAt: string | null,
  finishedAt: string | null,
  now: Date,
) {
  if (!startedAt) return EMPTY_VALUE
  const end = finishedAt ? Date.parse(finishedAt) : now.getTime()
  return formatElapsed(end - Date.parse(startedAt))
}

function When({ value, now }: { value: string | null; now: Date }) {
  if (!value) return <span className="ds-muted">{EMPTY_VALUE}</span>
  return (
    <time dateTime={value} title={formatDateTime(value)}>
      {formatWhen(value, now)}
    </time>
  )
}

/** The System jobs list, or one provider's jobs when `provider` is set. */
export function JobsTable({ provider }: { provider?: string }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const inspector = useDetailInspector()
  const param = (key: string) => search.get(key)
  const library = provider ? null : systemLibraryFilter(param('mediaType'))
  const query = param('q')?.slice(0, 200) ?? ''
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])
  const deferredQuery = useDeferredValue(query.trim())
  const parsedStatuses = JobListQuerySchema.shape.statuses.safeParse(
    param('statuses') ?? undefined,
  )
  const parsedStatus = JobListQuerySchema.shape.status.safeParse(
    param('status') ?? undefined,
  )
  const statuses =
    parsedStatuses.success && parsedStatuses.data.length
      ? parsedStatuses.data
      : parsedStatus.success && parsedStatus.data
        ? [parsedStatus.data]
        : []
  const parsedProviders = JobListQuerySchema.shape.providers.safeParse(
    param('providers') ?? undefined,
  )
  const selectedProviders = provider
    ? [provider]
    : parsedProviders.success && parsedProviders.data.length
      ? parsedProviders.data
      : param('provider')
        ? [param('provider') ?? '']
        : []
  const statusesKey = JSON.stringify(statuses)
  const providersKey = JSON.stringify(selectedProviders)
  const batchId = provider ? '' : (param('batchId') ?? '')
  /** Batches are one row that expands; a single batch lists its jobs. */
  const grouped = !batchId
  const parsedSort = JobSortKeySchema.safeParse(param('sortBy'))
  const sortBy = parsedSort.success ? parsedSort.data : 'createdAt'
  const direction = param('direction') === 'asc' ? 'asc' : 'desc'
  const columns = useTableColumns('jobs', jobColumns)
  const shownColumns = jobColumns.filter((column) =>
    columns.visible(column.key),
  )
  const colSpan = shownColumns.length + 2
  const selectAll = useRef<HTMLInputElement>(null)
  const [retryBatchId, setRetryBatchId] = useState<string | null>(null)
  const [batchRetryConfirmed, setBatchRetryConfirmed] = useState(false)
  const reviewedBatch = batchId || retryBatchId
  const [checkedJobIds, setCheckedJobIds] = useState<string[]>([])
  const [checkedBatchIds, setCheckedBatchIds] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [bulkPending, setBulkPending] = useState(false)
  const [request, setRequest] = useState<JobActionRequest | null>(null)
  const [expanded, setExpanded] = useState<Map<string, number>>(() => new Map())
  const now = new Date()
  function setParams(updates: Record<string, string>) {
    const params = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    replaceWorkspaceUrl(
      `${window.location.pathname}?${params}${window.location.hash}`,
      true,
    )
  }
  const providers = useQuery(providerListOptions(apiBaseUrl))
  const providerOptions = (providers.data ?? []).filter((item) =>
    library === 'subscription'
      ? item.subscriptions
      : library === 'artist'
        ? supportsArtistEnrichment(item)
        : library
          ? item.mediaTypes.some((kind) => kind === library)
          : item.surface === 'provider',
  )
  const filters = {
    ...(library ? { mediaType: library } : {}),
    sortBy,
    direction,
    statuses: statusesKey,
    providers: providersKey,
    ...(deferredQuery ? { q: deferredQuery } : {}),
  }
  const jobsKey = [
    'jobs',
    grouped ? 'entries' : 'table',
    library,
    statusesKey,
    batchId,
    deferredQuery,
    providersKey,
    sortBy,
    direction,
  ]
  const identity = JSON.stringify(jobsKey)
  const expandedIds = [...expanded.keys()]
  const children = useQueries({
    queries: expandedIds.map((id) =>
      queryOptions({
        queryKey: [
          'jobs',
          'batch-children',
          id,
          library,
          statusesKey,
          deferredQuery,
          providersKey,
          sortBy,
          direction,
        ],
        queryFn: ({ signal }) =>
          fetchApiData(
            apiBaseUrl,
            `/api/v1/scrape/jobs?${new URLSearchParams({
              ...filters,
              batchId: id,
              page: '1',
              size: String(batchPageSize),
            })}`,
            JobPageSchema,
            { signal },
          ),
        refetchInterval: (state) =>
          state.state.data?.items.some(canCancelJob) ? 3000 : false,
      }),
    ),
  })
  const childPages = new Map(
    expandedIds.map((id, index) => [id, children[index]]),
  )
  // Expanded batches add their child rows to the virtual height.
  const extraRowHeights = new Map<number, number>()
  for (const [id, index] of expanded) {
    const page = childPages.get(id)?.data
    const rows = page
      ? Math.max(1, page.items.length) +
        (page.totalCount > page.items.length ? 1 : 0)
      : 1
    extraRowHeights.set(index, rows * rowHeight)
  }
  const jobs = useVirtualTable({
    queryKey: jobsKey,
    pageSize: 25,
    rowHeight,
    headerHeight,
    extraRowHeights,
    loadPage: (page, size, signal): Promise<JobPage | JobEntryPage> => {
      const params = new URLSearchParams({
        ...filters,
        ...(batchId ? { batchId } : {}),
        page: String(page),
        size: String(size),
      })
      return grouped
        ? fetchApiData(
            apiBaseUrl,
            `/api/v1/scrape/jobs/entries?${params}`,
            JobEntryPageSchema,
            { signal },
          )
        : fetchApiData(
            apiBaseUrl,
            `/api/v1/scrape/jobs?${params}`,
            JobPageSchema,
            { signal },
          )
    },
    refetchInterval: (page) =>
      page?.items.some((item) => {
        const entry = asEntry(item)
        return entry.kind === 'batch'
          ? entry.queued + entry.running > 0
          : canCancelJob(entry.job)
      })
        ? 3000
        : false,
  })
  const loadedSlots = jobs.loadedSlots
  // New jobs can move offset boundaries between reads. Rows stay keyed by ID.
  const entries = useMemo(() => {
    const indexed = new Map<string, { entry: JobEntry; index: number }>()
    for (const slot of loadedSlots) {
      const entry = asEntry(slot.item)
      const key = entryKey(entry)
      if (!indexed.has(key)) indexed.set(key, { entry, index: slot.index })
    }
    return indexed
  }, [loadedSlots])
  // Keep each open batch's extra height on its current row as entries move.
  const moved = [...expanded].some(
    ([id, index]) => entries.get(`batch:${id}`)?.index !== index,
  )
  useEffect(() => {
    if (!moved) return
    setExpanded((current) => {
      const next = new Map<string, number>()
      for (const id of current.keys()) {
        const index = entries.get(`batch:${id}`)?.index
        if (index !== undefined) next.set(id, index)
      }
      return next
    })
  }, [moved, entries])
  useEffect(() => {
    setCheckedJobIds([])
    setCheckedBatchIds([])
    setSelectionAnchor(null)
    setRetryBatchId(null)
    setBatchRetryConfirmed(false)
    setExpanded(new Map())
  }, [identity])
  const retryBatch = useMutation({
    mutationFn: ({ id, confirmed }: { id: string; confirmed: boolean }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/batches/${encodeURIComponent(id)}/retry`,
        EnrichmentResultSchema,
        {
          method: 'POST',
          body: JSON.stringify({ confirmBroadRun: confirmed }),
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      setRetryBatchId(null)
    },
  })
  const providerName = (id: string) => providerDisplayName(providers.data, id)
  const orderedJobs: Job[] = []
  /** Batches with unfinished jobs, which can be selected and cancelled. */
  const cancellableBatches: JobBatchEntry[] = []
  for (const { entry } of [...entries.values()].sort(
    (a, b) => a.index - b.index,
  )) {
    if (entry.kind === 'job') orderedJobs.push(entry.job)
    else {
      if (unfinishedBatchJobs(entry) > 0) cancellableBatches.push(entry)
      orderedJobs.push(...(childPages.get(entry.batchId)?.data?.items ?? []))
    }
  }
  const actionableJobs = orderedJobs.filter(
    (job) => canRetryJob(job) || canDismissJob(job) || canCancelJob(job),
  )
  const actionableIds = actionableJobs.map((job) => job.id)
  const selectedIds = checkedJobIds.filter((id) => actionableIds.includes(id))
  const batchIds = cancellableBatches.map((batch) => batch.batchId)
  const selectedBatchIds = checkedBatchIds.filter((id) => batchIds.includes(id))
  const selectedCount = selectedIds.length + selectedBatchIds.length
  const allChecked =
    actionableIds.length + batchIds.length > 0 &&
    actionableIds.every((id) => selectedIds.includes(id)) &&
    batchIds.every((id) => selectedBatchIds.includes(id))
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = selectedCount > 0 && !allChecked
  }, [selectedCount, allChecked])
  const busy = bulkPending || retryBatch.isPending
  function selectJobs(ids: string[]) {
    setCheckedJobIds(ids)
    setSelectionAnchor(null)
  }
  function toggleJob(id: string, checked: boolean, shift: boolean) {
    setCheckedJobIds(
      updateJobSelection(
        selectedIds,
        actionableIds,
        id,
        selectionAnchor,
        shift,
        checked,
      ),
    )
    if (!shift || !selectionAnchor || !actionableIds.includes(selectionAnchor))
      setSelectionAnchor(id)
  }
  function toggleBatchSelection(id: string, checked: boolean) {
    setCheckedBatchIds((current) =>
      checked
        ? [...current.filter((other) => other !== id), id]
        : current.filter((other) => other !== id),
    )
  }
  function toggleBatch(id: string, index: number) {
    setExpanded((current) => {
      const next = new Map(current)
      if (next.has(id)) next.delete(id)
      else next.set(id, index)
      return next
    })
  }
  function cells(values: Record<ColumnKey, ReactNode>) {
    return shownColumns.map((column) => (
      <TableCell
        key={column.key}
        align={column.align}
        sticky={column.key === 'title' ? selectionWidth : undefined}
        stickyEdge={column.key === 'title'}
      >
        {values[column.key]}
      </TableCell>
    ))
  }
  function renderJobRow(job: Job, options: { child?: boolean } = {}) {
    const dismissal = getJobDismissal(job.options)
    const title = jobTitle(job)
    const state = jobStatus(job)
    const result = jobResult(job, undefined, now)
    const progressLabel = activeJobProgressLabel(job)
    const actionable = actionableIds.includes(job.id)
    const rowAction: JobActionRequest['action'] | null = !actionable
      ? null
      : canCancelJob(job) && job.status !== 'running'
        ? 'cancel'
        : canRetryJob(job)
          ? 'retry'
          : canCancelJob(job)
            ? 'cancel'
            : null
    return (
      <TableRow
        key={job.id}
        child={options.child}
        selected={
          selectedIds.includes(job.id) ||
          (inspector?.active?.kind === 'job' && inspector.active.id === job.id)
        }
      >
        <TableCell sticky={0}>
          {actionable ? (
            <input
              type="checkbox"
              className="ds-check"
              aria-label={`Select ${providerName(job.provider)} job for ${jobTaskTitle(job) ?? job.items[0]?.mediaTitle ?? 'unavailable item'}`}
              title="Shift-click to select a range"
              disabled={busy}
              checked={selectedIds.includes(job.id)}
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
        </TableCell>
        {cells({
          title: (
            <span className="ds-cell-id">
              <DetailLink
                kind="job"
                id={job.id}
                className="ds-cell-title"
                title={title}
                aria-label={`View ${providerName(job.provider)} job from ${formatDateTime(job.createdAt)}`}
              >
                {title}
              </DetailLink>
            </span>
          ),
          status: (
            <Status
              state={state}
              title={job.status === 'queued' ? job.waiting?.detail : undefined}
            >
              {state === 'waiting' && job.waiting?.until
                ? `Until ${formatUntil(job.waiting.until, now)}`
                : statusLabels[state]}
              {dismissal ? ' · dismissed' : ''}
            </Status>
          ),
          provider: (
            <Link href={`/providers/${encodeURIComponent(job.provider)}`}>
              {providerName(job.provider)}
            </Link>
          ),
          progress: job.progress?.total ? (
            <Progress
              done={job.progress.done}
              total={job.progress.total}
              compact
            />
          ) : progressLabel ? (
            <span className="ds-muted">{progressLabel}</span>
          ) : null,
          createdAt: <When value={job.createdAt} now={now} />,
          startedAt: <When value={job.startedAt} now={now} />,
          finishedAt: <When value={job.finishedAt} now={now} />,
          duration: elapsed(job.startedAt, job.finishedAt, now),
          result: result ? (
            <span
              className={job.status === 'failed' ? 'ops-danger' : undefined}
              title={result}
            >
              {result}
            </span>
          ) : (
            <span className="ds-muted">{EMPTY_VALUE}</span>
          ),
        })}
        <TableCell align="end">
          {rowAction && (
            <Button
              size="xs"
              disabled={busy}
              onClick={() => {
                setCheckedBatchIds([])
                selectJobs([job.id])
                setRequest({ action: rowAction, jobId: job.id, at: Date.now() })
              }}
            >
              {rowAction === 'retry' ? 'Retry' : 'Cancel'}
            </Button>
          )}
        </TableCell>
      </TableRow>
    )
  }
  function renderBatchRows(batch: JobBatchEntry, index: number) {
    const open = expanded.has(batch.batchId)
    const state = batchStatus(batch)
    const title = batchTitle(batch)
    const target = batchTarget(batch)
    const result = batchResult(batch, now)
    const page = childPages.get(batch.batchId)
    const href = `/jobs?batchId=${encodeURIComponent(batch.batchId)}`
    const cancellable = batchIds.includes(batch.batchId)
    const retryable =
      batch.failed + batch.cancelled > 0 && unfinishedBatchJobs(batch) === 0
    return (
      <Fragment key={`batch:${batch.batchId}`}>
        <TableRow group selected={selectedBatchIds.includes(batch.batchId)}>
          <TableCell sticky={0}>
            {cancellable ? (
              <input
                type="checkbox"
                className="ds-check"
                aria-label={`Select batch ${title} · ${target}`}
                disabled={busy}
                checked={selectedBatchIds.includes(batch.batchId)}
                onChange={(event) =>
                  toggleBatchSelection(batch.batchId, event.target.checked)
                }
              />
            ) : (
              <span aria-hidden="true" />
            )}
          </TableCell>
          {cells({
            title: (
              <span className="ds-cell-id">
                <Button
                  variant="ghost"
                  size="xs"
                  icon
                  aria-expanded={open}
                  aria-label={`${open ? 'Hide' : 'Show'} jobs in ${title} · ${target}`}
                  onClick={() => toggleBatch(batch.batchId, index)}
                >
                  {open ? (
                    <ChevronDown className="ds-i" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="ds-i" aria-hidden="true" />
                  )}
                </Button>
                <Link href={href} className="ds-cell-title">
                  {title}
                </Link>
                <span className="ds-cell-sub">{target}</span>
              </span>
            ),
            status: (
              <Status state={state} title={batch.waiting?.detail}>
                {state === 'waiting' && batch.waiting?.until
                  ? `Until ${formatUntil(batch.waiting.until, now)}`
                  : statusLabels[state]}
              </Status>
            ),
            provider: batch.provider ? (
              <Link href={`/providers/${encodeURIComponent(batch.provider)}`}>
                {providerName(batch.provider)}
              </Link>
            ) : (
              <span
                className="ds-muted"
                title={batch.providers.map(providerName).join(', ')}
              >
                {formatCount(batch.providers.length)} providers
              </span>
            ),
            progress: (
              <Progress done={batchDone(batch)} total={batch.total} compact />
            ),
            createdAt: <When value={batch.createdAt} now={now} />,
            startedAt: <When value={batch.startedAt} now={now} />,
            finishedAt: <When value={batch.finishedAt} now={now} />,
            duration: elapsed(batch.startedAt, batch.finishedAt, now),
            result: result ? (
              <span
                className={batch.failed ? 'ops-danger' : undefined}
                title={batch.waiting?.detail ?? result}
              >
                {result}
              </span>
            ) : (
              <span className="ds-muted">{EMPTY_VALUE}</span>
            ),
          })}
          <TableCell align="end">
            {cancellable && (
              <Button
                size="xs"
                disabled={busy}
                onClick={() => {
                  selectJobs([])
                  setCheckedBatchIds([batch.batchId])
                  setRequest({
                    action: 'cancel',
                    batchId: batch.batchId,
                    at: Date.now(),
                  })
                }}
              >
                Cancel
              </Button>
            )}
            {retryable && (
              <Button
                size="xs"
                disabled={busy}
                onClick={() => {
                  retryBatch.reset()
                  setRetryBatchId(batch.batchId)
                  setBatchRetryConfirmed(false)
                }}
              >
                Retry
              </Button>
            )}
          </TableCell>
        </TableRow>
        {open &&
          (page?.data ? (
            <>
              {page.data.items.map((job) => renderJobRow(job, { child: true }))}
              {!page.data.items.length && (
                <TableRow child>
                  <TableCell colSpan={colSpan} className="ds-muted">
                    No matching jobs in this batch.
                  </TableCell>
                </TableRow>
              )}
              {page.data.totalCount > page.data.items.length && (
                <TableRow child>
                  <TableCell colSpan={colSpan} className="ds-muted">
                    Showing {formatCount(page.data.items.length)} of{' '}
                    {formatCount(page.data.totalCount)} ·{' '}
                    <Link href={href}>Open batch</Link>
                  </TableCell>
                </TableRow>
              )}
            </>
          ) : (
            <TableRow child>
              <TableCell colSpan={colSpan} className="ds-muted">
                {page?.isError ? (
                  <span role="alert">
                    Could not load jobs.{' '}
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() => page.refetch()}
                    >
                      Retry
                    </Button>
                  </span>
                ) : (
                  <span role="status">Loading jobs...</span>
                )}
              </TableCell>
            </TableRow>
          ))}
      </Fragment>
    )
  }
  const countLabel = grouped
    ? formatItemCount(jobs.total, {
        one: 'job or batch',
        other: 'jobs and batches',
      })
    : formatItemCount(jobs.total, { one: 'job', other: 'jobs' })
  const table = (
    <>
      {reviewedBatch && (
        <Toolbar className="ops-batch">
          {batchId && (
            <>
              <strong>Import / refresh jobs</strong>
              <Link href="/jobs">All jobs</Link>
            </>
          )}
          {retryBatch.data ? (
            <span role="status">
              {formatCount(retryBatch.data.queued)} queued,{' '}
              {formatCount(retryBatch.data.skipped)} skipped.
              {retryBatch.data.warnings.map((warning) => (
                <span className="block" key={warning}>
                  {warning}
                </span>
              ))}
            </span>
          ) : !batchRetryConfirmed ? (
            <Button
              disabled={busy}
              onClick={() => setBatchRetryConfirmed(true)}
            >
              Review batch retry
            </Button>
          ) : (
            <div
              className="ops-review"
              role="region"
              aria-label="Review batch retry"
            >
              <Notice
                tone="attention"
                action={
                  <span className="ds-actions">
                    <Button
                      variant="primary"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        retryBatch.mutate({
                          id: reviewedBatch,
                          confirmed: true,
                        })
                      }
                    >
                      Confirm retry entire batch
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={retryBatch.isPending}
                      onClick={() => {
                        setBatchRetryConfirmed(false)
                        if (!batchId) setRetryBatchId(null)
                      }}
                    >
                      Back
                    </Button>
                  </span>
                }
              >
                Queue all unfinished work in this batch, including jobs beyond
                the loaded list. Provider limits and cooldowns apply.
              </Notice>
            </div>
          )}
          {retryBatch.isError && (
            <span role="alert" className="ops-danger">
              {retryBatch.error.message}
            </span>
          )}
        </Toolbar>
      )}
      <Toolbar>
        <SecondaryTableSearch
          label="Search jobs"
          placeholder="Search titles or providers"
          maxLength={200}
          value={draft}
          disabled={bulkPending}
          onChange={(value) => {
            setDraft(value)
            setParams({ q: value, page: '' })
          }}
        />
        {!provider && (
          <Select
            aria-label="Library"
            value={library ?? ''}
            disabled={bulkPending}
            onChange={(event) =>
              setParams({
                mediaType: systemLibraryFilter(event.target.value) ?? '',
                page: '',
              })
            }
          >
            {libraryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
        <ToolbarCount>{countLabel}</ToolbarCount>
        {columns.controls && <ToolbarEnd>{columns.controls}</ToolbarEnd>}
      </Toolbar>
      {jobs.isError && jobs.hasTotal && (
        <div className="ops-notice">
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={jobs.retry}>
                Retry
              </Button>
            }
          >
            Could not load jobs.
          </Notice>
        </div>
      )}
      <SecondaryTableScroll
        ref={jobs.scroller}
        onScroll={jobs.onScroll}
        role="region"
        aria-label="Jobs"
        aria-busy={jobs.isFetching}
      >
        <table className="ds-table ops-jobs-table" aria-label="Jobs">
          <thead>
            <tr>
              <TableHead sticky={0} style={{ width: selectionWidth }}>
                <input
                  ref={selectAll}
                  type="checkbox"
                  className="ds-check"
                  aria-label="Select all loaded eligible jobs"
                  checked={allChecked}
                  disabled={
                    busy || actionableIds.length + batchIds.length === 0
                  }
                  onChange={(event) => {
                    selectJobs(event.target.checked ? actionableIds : [])
                    setCheckedBatchIds(event.target.checked ? batchIds : [])
                  }}
                />
              </TableHead>
              {shownColumns.map((column) => {
                const layout = {
                  align: column.align,
                  sticky: column.key === 'title' ? selectionWidth : undefined,
                  stickyEdge: column.key === 'title',
                }
                if (!column.sort)
                  return (
                    <TableHead key={column.key} {...layout}>
                      {column.label}
                    </TableHead>
                  )
                return (
                  <SecondaryTableHead
                    key={column.key}
                    {...layout}
                    sortKey={column.sort}
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
                              .map((id) => ({
                                value: id,
                                label: providerName(id),
                              })),
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
                            })
                          }
                        />
                      ) : undefined
                    }
                    sortBy={sortBy}
                    direction={direction}
                    disabled={busy}
                    onSort={(key) =>
                      setParams({
                        sortBy: key,
                        direction:
                          key === sortBy && direction === 'asc'
                            ? 'desc'
                            : 'asc',
                      })
                    }
                  />
                )
              })}
              <TableHead align="end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </tr>
          </thead>
          <tbody>
            {!jobs.total && (
              <TableState colSpan={colSpan} error={jobs.isError}>
                {jobs.isPending
                  ? 'Loading jobs...'
                  : jobs.isError
                    ? 'Jobs unavailable.'
                    : 'No matching jobs.'}
                {jobs.isError && (
                  <Button variant="link" size="xs" onClick={jobs.retry}>
                    Retry
                  </Button>
                )}
              </TableState>
            )}
            {(!jobs.isError || jobs.hasTotal) && (
              <SecondaryVirtualRows
                window={jobs}
                colSpan={colSpan}
                renderRow={(item, index) => {
                  const entry = asEntry(item)
                  return entries.get(entryKey(entry))?.index === index ? (
                    entry.kind === 'batch' ? (
                      renderBatchRows(entry, index)
                    ) : (
                      renderJobRow(entry.job)
                    )
                  ) : (
                    <tr aria-hidden="true">
                      <td
                        colSpan={colSpan}
                        style={{ height: rowHeight, padding: 0, border: 0 }}
                      />
                    </tr>
                  )
                }}
              />
            )}
          </tbody>
        </table>
      </SecondaryTableScroll>
      {(actionableIds.length + batchIds.length > 0 || bulkPending) && (
        <TableSelectionBar>
          {selectedCount > 0 && (
            <span role="status">
              <b>{formatCount(selectedCount)} selected</b>
            </span>
          )}
          <JobBulkActions
            jobs={actionableJobs}
            selectedIds={selectedIds}
            onSelect={selectJobs}
            onPending={setBulkPending}
            disabled={busy}
            request={request}
            batches={cancellableBatches}
            selectedBatchIds={selectedBatchIds}
            onSelectBatches={setCheckedBatchIds}
          />
        </TableSelectionBar>
      )}
    </>
  )
  return <section className="ops-jobs">{table}</section>
}
