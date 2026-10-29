'use client'

import Link from 'next/link'
import React from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { JobPageSchema, getJobDismissal, type Job } from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll, TableState } from '@repo/ui/components/ui/table'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'

export default function MediaHistoryJobs({
  mediaItemId,
}: {
  mediaItemId: string
}) {
  const { apiBaseUrl } = useConfig()
  const jobs = useInfiniteQuery({
    queryKey: ['jobs', 'media-history', 'infinite', mediaItemId],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ mediaItemId, page: String(pageParam), size: '25' })}`,
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
    resetKey: mediaItemId,
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
      <TableScroll
        ref={scroller}
        className="table-scroll-bounded"
        role="region"
        aria-label="Job history"
        aria-busy={jobs.isFetching}
      >
        <table className="compact-table" aria-label="Job history">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Job</th>
              <th scope="col">Created</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {!items.length && (
              <TableState colSpan={4} error={jobs.isError}>
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
                  <td>
                    <Link
                      className="underline underline-offset-2"
                      href={`/jobs?jobId=${encodeURIComponent(job.id)}`}
                      aria-label={`View ${providerLabel} job from ${new Date(job.createdAt).toLocaleString()}`}
                    >
                      {providerLabel}
                    </Link>
                  </td>
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
                  <td className="whitespace-nowrap">
                    <time dateTime={job.createdAt}>
                      {new Date(job.createdAt).toLocaleString()}
                    </time>
                  </td>
                  <td className="max-w-sm break-words">
                    {item && item.status !== job.status && (
                      <span className="block">This item: {item.status}</span>
                    )}
                    {item?.message ?? job.errorMessage ?? '-'}
                  </td>
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
      </TableScroll>
    </section>
  )
}
