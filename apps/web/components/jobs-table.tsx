'use client'

import Link from 'next/link'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import { ArtistProfileProviderSchema } from '@repo/schemas/artist-profiles'
import {
  JobSortKeySchema,
  JobListQuerySchema,
  jobStatusFilters,
  type JobSortKey,
  JobPageSchema,
  EnrichmentResultSchema,
  getJobDismissal,
  type Job,
} from '@repo/schemas/job'
import { TableState } from '@repo/ui/components/ui/table'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { scopedHref, type WorkspaceScope } from '@/utils/media-scope'
import {
  activeJobProgressLabel,
  canCancelJob,
  canDismissJob,
  canRetryJob,
  jobTaskTitle,
  updateJobSelection,
} from '@/utils/job-selection'
import { DetailLink } from './detail-link'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
  useDetailView,
} from './detail-inspector-context'
import { useConfig } from './providers'
import { useWorkspaceScope } from './media-scope'
import JobBulkActions from './job-bulk-actions'
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
} from './secondary-table'

const jobsHeadings: Record<WorkspaceScope, string> = {
  album: 'Album jobs',
  artist: 'Artist jobs',
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

type JobsTableProps = { provider?: string } & (
  | { mediaItemId: string; artistId?: never }
  | { artistId: string; mediaItemId?: never }
  | { mediaItemId?: never; artistId?: never }
)

export function JobsTable({ provider, mediaItemId, artistId }: JobsTableProps) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const workspaceSearch = useSearchParams()
  const detail = useDetailView()
  const inspector = useDetailInspector()
  const history = Boolean(mediaItemId || artistId)
  const search = history ? detail.params : workspaceSearch
  const paramKey = (key: string) =>
    history ? `jobs${key[0]?.toUpperCase()}${key.slice(1)}` : key
  const param = (key: string) => search.get(paramKey(key))
  const mediaType = useWorkspaceScope()
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
  const batchId = provider || history ? '' : (param('batchId') ?? '')
  const parsedSort = JobSortKeySchema.safeParse(param('sortBy'))
  const sortBy = parsedSort.success ? parsedSort.data : 'createdAt'
  const direction = param('direction') === 'asc' ? 'asc' : 'desc'
  const columns = useTableColumns('jobs', jobColumns)
  const shownColumns = jobColumns.filter((column) =>
    columns.visible(column.key),
  )
  const selectAll = useRef<HTMLInputElement>(null)
  const [retryConfirmed, setRetryConfirmed] = useState(false)
  const [checkedJobIds, setCheckedJobIds] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [bulkPending, setBulkPending] = useState(false)
  function setParams(updates: Record<string, string>) {
    const params = new URLSearchParams(
      history ? detail.params : window.location.search,
    )
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(paramKey(key), value)
      else params.delete(paramKey(key))
    }
    if (history) detail.replace(params)
    else
      replaceWorkspaceUrl(
        `${window.location.pathname}?${params}${window.location.hash}`,
        true,
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
      : mediaType === 'artist'
        ? ArtistProfileProviderSchema.safeParse(item.id).success
        : item.mediaTypes.some((kind) => kind === mediaType),
  )
  const jobsKey = history
    ? [
        'jobs',
        'media-history',
        'table',
        mediaItemId,
        artistId,
        providersKey,
        sortBy,
        direction,
        deferredQuery,
        statusesKey,
      ]
    : [
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
  const jobs = useVirtualTable({
    queryKey: jobsKey,
    pageSize: 25,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({
          ...(!provider && !history ? { mediaType } : {}),
          ...(mediaItemId ? { mediaItemId } : {}),
          ...(artistId ? { artistId } : {}),
          sortBy,
          direction,
          page: String(page),
          size: String(size),
          statuses: statusesKey,
          providers: providersKey,
          ...(batchId ? { batchId } : {}),
          ...(deferredQuery ? { q: deferredQuery } : {}),
        })}`,
        JobPageSchema,
        { signal },
      ),
    refetchInterval: (page) => (page?.items.some(canCancelJob) ? 3000 : false),
  })
  useEffect(() => {
    setCheckedJobIds([])
    setSelectionAnchor(null)
    setRetryConfirmed(false)
  }, [identity])
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
  const providerName = (id: string) =>
    providers.data?.find((item) => item.id === id)?.displayName ??
    (id === 'google-custom-search' ? 'Google Custom Search (legacy)' : id)
  // New jobs can move offset boundaries between reads. Loaded selection stays by job ID.
  const loadedSlots = jobs.loadedSlots
  const jobsById = useMemo(() => {
    const indexed = new Map<string, { item: Job; index: number }>()
    for (const slot of loadedSlots)
      if (!indexed.has(slot.item.id)) indexed.set(slot.item.id, slot)
    return indexed
  }, [loadedSlots])
  const actionableJobs = [...jobsById.values()]
    .map(({ item }) => item)
    .filter(
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
  function renderJobRow(job: Job, index: number) {
    const dismissal = getJobDismissal(job.options)
    const taskTitle = jobTaskTitle(job)
    const progress = activeJobProgressLabel(job)
    const title =
      taskTitle ??
      (job.items
        .map((item) => item.mediaTitle ?? 'Unavailable item')
        .join(', ') ||
        'Job')
    const item = mediaItemId
      ? job.items.find((candidate) => candidate.mediaItemId === mediaItemId)
      : undefined
    const message =
      item?.message ??
      job.errorMessage ??
      (job.items
        .map((item) => item.message)
        .filter(Boolean)
        .join(' · ') ||
        '-')
    const result =
      item && item.status !== job.status
        ? `This item: ${item.status} · ${message}`
        : message
    return (
      <tr
        key={job.id}
        className="cursor-pointer"
        aria-rowindex={index + 2}
        data-selected={
          selectedIds.includes(job.id) ||
          (inspector?.active?.kind === 'job' &&
            inspector.active.id === job.id) ||
          undefined
        }
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('a, button, input, select, textarea')
          )
            return
          inspector?.open(
            { kind: 'job', id: job.id },
            event.currentTarget.querySelector<HTMLElement>('a') ?? undefined,
          )
        }}
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
          <DetailLink
            kind="job"
            id={job.id}
            className="underline underline-offset-2"
            aria-label={`View ${providerName(job.provider)} job from ${new Date(job.createdAt).toLocaleString()}`}
          >
            View
          </DetailLink>
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
            <SecondaryCell text={`${title}${progress ? ` · ${progress}` : ''}`}>
              <DetailLink kind="job" id={job.id} className="table-title">
                {title}
              </DetailLink>
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
              {job.finishedAt ? new Date(job.finishedAt).toLocaleString() : '-'}
            </SecondaryCell>
          </td>
        )}
        {columns.visible('result') && (
          <td>
            <SecondaryCell text={result}>{result}</SecondaryCell>
          </td>
        )}
      </tr>
    )
  }
  return (
    <section
      className={history ? undefined : 'admin-page jobs-page'}
      aria-label={history ? 'Jobs' : undefined}
    >
      {history ? (
        <h2 className="text-sm font-semibold">Jobs</h2>
      ) : (
        !provider && <h1>{jobsHeadings[mediaType]}</h1>
      )}
      {batchId && (
        <div className="batch-actions">
          <strong>Import / refresh jobs</strong>
          <Link href={scopedHref('/jobs', mediaType)}>All jobs</Link>
          {!retryConfirmed && (
            <Button
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
                  variant="primary"
                  disabled={retryBatch.isPending || bulkPending}
                  onClick={() => retryBatch.mutate()}
                >
                  Confirm retry entire batch
                </Button>
                <Button
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
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label={history ? 'Search job history' : 'Search jobs'}
            placeholder="Search titles or providers"
            maxLength={200}
            value={draft}
            disabled={bulkPending}
            onChange={(event) => {
              setDraft(event.target.value)
              setParams({ q: event.target.value, page: '' })
            }}
          />
        }
        count={`${jobs.total.toLocaleString()} jobs`}
        columns={columns.controls}
      />
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
          className={history ? 'table-scroll-bounded' : 'jobs-scroll'}
          ref={jobs.scroller}
          onScroll={jobs.onScroll}
          data-inspector-scroll={history || undefined}
          role="region"
          aria-label={history ? 'Job history' : 'Jobs'}
          aria-busy={jobs.isFetching}
        >
          <table
            className="ds-table"
            aria-label={history ? 'Job history' : 'Jobs'}
          >
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
                    disabled={bulkPending || retryBatch.isPending}
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
                      : deferredQuery ||
                          statuses.length ||
                          selectedProviders.length ||
                          !history
                        ? 'No matching jobs.'
                        : 'No jobs yet.'}
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
