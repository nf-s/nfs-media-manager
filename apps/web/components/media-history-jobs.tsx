'use client'

import Link from 'next/link'
import React, { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  JobPageSchema,
  getJobDismissal,
  type Job,
  type JobSortKey,
} from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { TableState } from '@repo/ui/components/ui/table'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import {
  SecondaryTableScroll,
  SecondaryTableHead,
  useTableColumns,
} from './secondary-table'

export default function MediaHistoryJobs({
  mediaItemId,
}: {
  mediaItemId: string
}) {
  const columns = useTableColumns('media-job-history', [
    { key: 'provider', label: 'Provider' },
    { key: 'status', label: 'Job' },
    { key: 'createdAt', label: 'Created' },
    { key: 'result', label: 'Result' },
    { key: 'startedAt', label: 'Started', defaultVisible: false },
    { key: 'finishedAt', label: 'Finished', defaultVisible: false },
  ])
  const [sortBy, setSortBy] = useState<JobSortKey>('createdAt')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  function sort(key: JobSortKey) {
    setSortBy(key)
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
  }
  const { apiBaseUrl } = useConfig()
  const jobs = useInfiniteQuery({
    queryKey: [
      'jobs',
      'media-history',
      'infinite',
      mediaItemId,
      sortBy,
      direction,
    ],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ mediaItemId, sortBy, direction, page: String(pageParam), size: '25' })}`,
        JobPageSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
    staleTime: 0,
    refetchInterval: 3000,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: jobs.hasNextPage && !jobs.isFetching && !jobs.isError,
    fetchNextPage: jobs.fetchNextPage,
    resetKey: JSON.stringify([mediaItemId, sortBy, direction]),
  })
  // New jobs can move offset boundaries between requests. Keep each job once.
  const jobsById = new Map<string, Job>()
  for (const page of jobs.data?.pages ?? [])
    for (const job of page.items)
      if (!jobsById.has(job.id)) jobsById.set(job.id, job)
  const items = [...jobsById.values()]
  return (
    <section aria-label="Jobs">
      <h2 className="text-sm font-semibold">
        Jobs{jobs.data ? ` (${jobs.data.pages[0]?.totalCount ?? 0})` : ''}
      </h2>
      {jobs.isError && items.length > 0 && !jobs.isFetchNextPageError && (
        <p role="alert">
          Could not load jobs.{' '}
          <button type="button" onClick={() => jobs.refetch()}>
            Retry
          </button>
        </p>
      )}
      {columns.controls}
      <SecondaryTableScroll
        ref={scroller}
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
            {!items.length && (
              <TableState colSpan={columns.count} error={jobs.isError}>
                {jobs.isPending
                  ? 'Loading jobs...'
                  : jobs.isError
                    ? 'Could not load jobs.'
                    : 'No jobs yet.'}
                {jobs.isError && (
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => jobs.refetch()}
                  >
                    Retry
                  </button>
                )}
              </TableState>
            )}
            {items.map((job) => {
              const providerLabel =
                job.provider === 'google-custom-search'
                  ? 'Google Custom Search (legacy)'
                  : job.provider
              const item = job.items.find(
                (candidate) => candidate.mediaItemId === mediaItemId,
              )
              const dismissal = getJobDismissal(job.options)
              return (
                <tr key={job.id}>
                  {columns.visible('provider') && (
                    <td>
                      <Link
                        className="underline underline-offset-2"
                        href={`/jobs?jobId=${encodeURIComponent(job.id)}`}
                        aria-label={`View ${providerLabel} job from ${new Date(job.createdAt).toLocaleString()}`}
                      >
                        {providerLabel}
                      </Link>
                    </td>
                  )}
                  {columns.visible('status') && (
                    <td>
                      <span className="job-status" data-status={job.status}>
                        {job.status}
                      </span>
                      {dismissal && (
                        <span
                          className="muted block"
                          title={`Dismissed ${new Date(dismissal.dismissedAt).toLocaleString()}`}
                        >
                          Dismissed
                        </span>
                      )}
                    </td>
                  )}
                  {columns.visible('createdAt') && (
                    <td className="whitespace-nowrap">
                      <time dateTime={job.createdAt}>
                        {new Date(job.createdAt).toLocaleString()}
                      </time>
                    </td>
                  )}
                  {columns.visible('result') && (
                    <td className="max-w-sm break-words">
                      {item && item.status !== job.status && (
                        <span className="block">This item: {item.status}</span>
                      )}
                      {item?.message ?? job.errorMessage ?? '-'}
                    </td>
                  )}
                  {columns.visible('startedAt') && (
                    <td className="whitespace-nowrap">
                      {job.startedAt
                        ? new Date(job.startedAt).toLocaleString()
                        : '-'}
                    </td>
                  )}
                  {columns.visible('finishedAt') && (
                    <td className="whitespace-nowrap">
                      {job.finishedAt
                        ? new Date(job.finishedAt).toLocaleString()
                        : '-'}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        <div ref={sentinel} className="py-2 text-center">
          {jobs.isFetchingNextPage && (
            <p role="status" className="muted">
              Loading more jobs...
            </p>
          )}
          {jobs.isFetchNextPageError && (
            <p role="alert">Could not load more jobs.</p>
          )}
          {jobs.hasNextPage && !jobs.isFetchingNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={jobs.isFetching}
              onClick={() => jobs.fetchNextPage({ cancelRefetch: false })}
            >
              {jobs.isFetchNextPageError
                ? 'Retry loading jobs'
                : 'Load more jobs'}
            </Button>
          )}
          {!jobs.hasNextPage && items.length > 0 && (
            <p className="muted">
              All {items.length.toLocaleString()} jobs loaded.
            </p>
          )}
        </div>
      </SecondaryTableScroll>
    </section>
  )
}
