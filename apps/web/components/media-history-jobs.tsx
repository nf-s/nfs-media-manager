'use client'

import Link from 'next/link'
import React, { useDeferredValue, useState } from 'react'
import {
  JobPageSchema,
  jobStatusFilters,
  type JobStatusFilter,
  getJobDismissal,
  type JobSortKey,
} from '@repo/schemas/job'
import { Input } from '@repo/ui/components/ui/input'
import { TableState } from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { canCancelJob } from '@/utils/job-selection'
import { useConfig } from './providers'
import {
  SecondaryColumnFilter,
  SecondaryCell,
  SecondaryTableToolbar,
  SecondaryTableScroll,
  SecondaryTableHead,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'

export default function MediaHistoryJobs({
  mediaItemId,
  artistId,
  provider,
}: (
  | { mediaItemId: string; artistId?: never }
  | { artistId: string; mediaItemId?: never }
) & { provider?: string }) {
  const columns = useTableColumns('media-job-history', [
    { key: 'provider', label: 'Provider' },
    { key: 'status', label: 'Job' },
    { key: 'createdAt', label: 'Created' },
    { key: 'result', label: 'Result' },
    { key: 'startedAt', label: 'Started', defaultVisible: false },
    { key: 'finishedAt', label: 'Finished', defaultVisible: false },
  ])
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const [statuses, setStatuses] = useState<JobStatusFilter[]>([])
  const [sortBy, setSortBy] = useState<JobSortKey>('createdAt')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  function sort(key: JobSortKey) {
    setSortBy(key)
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
  }
  const { apiBaseUrl } = useConfig()
  const jobs = useVirtualTable({
    queryKey: [
      'jobs',
      'media-history',
      'table',
      mediaItemId,
      artistId,
      provider,
      sortBy,
      direction,
      query,
      statuses,
    ],
    pageSize: 25,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ ...(mediaItemId ? { mediaItemId } : { artistId: artistId ?? '' }), ...(provider ? { provider } : {}), sortBy, direction, page: String(page), size: String(size), ...(query ? { q: query } : {}), statuses: JSON.stringify(statuses) })}`,
        JobPageSchema,
        { signal },
      ),
    refetchInterval: (page) => (page?.items.some(canCancelJob) ? 3000 : false),
  })
  return (
    <section aria-label="Jobs">
      <h2 className="text-sm font-semibold">Jobs</h2>
      {jobs.isError && jobs.total > 0 && (
        <p role="alert">
          Could not load jobs.{' '}
          <button type="button" onClick={jobs.retry}>
            Retry
          </button>
        </p>
      )}
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search job history"
            placeholder="Search titles or providers"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        count={`${jobs.total.toLocaleString()} jobs`}
        columns={columns.controls}
      />
      <SecondaryTableScroll
        ref={jobs.scroller}
        onScroll={jobs.onScroll}
        className="table-scroll-bounded"
        role="region"
        aria-label="Job history"
        aria-busy={jobs.isFetching}
      >
        <table className="compact-table" aria-label="Job history">
          <thead>
            <tr>
              {columns.visible('provider') && (
                <SecondaryTableHead
                  sortKey="provider"
                  label="Provider"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                />
              )}
              {columns.visible('status') && (
                <SecondaryTableHead
                  sortKey="status"
                  label="Job"
                  filter={
                    <SecondaryColumnFilter
                      label="Job history status"
                      options={jobStatusFilters}
                      value={statuses}
                      onChange={setStatuses}
                    />
                  }
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                />
              )}
              {columns.visible('createdAt') && (
                <SecondaryTableHead
                  sortKey="createdAt"
                  label="Created"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                />
              )}
              {columns.visible('result') && (
                <SecondaryTableHead
                  sortKey="result"
                  label="Result"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                />
              )}
              {columns.visible('startedAt') && (
                <SecondaryTableHead
                  sortKey="startedAt"
                  label="Started"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                />
              )}
              {columns.visible('finishedAt') && (
                <SecondaryTableHead
                  sortKey="finishedAt"
                  label="Finished"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                />
              )}
            </tr>
          </thead>
          <tbody>
            {!jobs.total && (
              <TableState colSpan={columns.count} error={jobs.isError}>
                {jobs.isPending
                  ? 'Loading jobs...'
                  : jobs.isError
                    ? 'Could not load jobs.'
                    : query || statuses.length
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
                colSpan={columns.count}
                renderRow={(job) => {
                  const providerLabel =
                    job.provider === 'google-custom-search'
                      ? 'Google Custom Search (legacy)'
                      : job.provider
                  const item = job.items.find(
                    (candidate) => candidate.mediaItemId === mediaItemId,
                  )
                  const dismissal = getJobDismissal(job.options)
                  const result = item?.message ?? job.errorMessage ?? '-'
                  const itemStatus =
                    item && item.status !== job.status
                      ? `This item: ${item.status}`
                      : undefined
                  return (
                    <tr key={job.id}>
                      {columns.visible('provider') && (
                        <td>
                          <SecondaryCell text={providerLabel}>
                            <Link
                              className="underline underline-offset-2"
                              href={`/jobs?jobId=${encodeURIComponent(job.id)}`}
                              aria-label={`View ${providerLabel} job from ${new Date(job.createdAt).toLocaleString()}`}
                            >
                              {providerLabel}
                            </Link>
                          </SecondaryCell>
                        </td>
                      )}
                      {columns.visible('status') && (
                        <td>
                          <SecondaryCell
                            text={`${job.status}${dismissal ? ' · dismissed' : ''}`}
                            details={
                              dismissal
                                ? `Dismissed ${new Date(dismissal.dismissedAt).toLocaleString()}. Errors retained.`
                                : undefined
                            }
                            label="Dismissal details"
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
                      {columns.visible('result') && (
                        <td>
                          <SecondaryCell
                            text={[itemStatus, result]
                              .filter(Boolean)
                              .join(' · ')}
                            label="Job result details"
                          >
                            {itemStatus ? `${itemStatus} · ` : ''}
                            {result}
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
                    </tr>
                  )
                }}
              />
            )}
          </tbody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
