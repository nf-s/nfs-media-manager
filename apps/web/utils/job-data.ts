import { queryOptions } from '@tanstack/react-query'
import { JobDataSchema, JobSchema, type Job } from '@repo/schemas/job'
import { fetchApiData } from './api'
import { canCancelJob } from './job-selection'
import { clientCacheStaleTime } from './query-cache'

export function jobDetailOptions(apiBaseUrl: string, id: string) {
  return queryOptions({
    queryKey: ['jobs', 'detail', id],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/${encodeURIComponent(id)}`,
        JobSchema,
        { signal },
      ),
    staleTime: (query) =>
      query.state.data && canCancelJob(query.state.data)
        ? 0
        : clientCacheStaleTime,
    refetchInterval: (query) =>
      query.state.data && canCancelJob(query.state.data) ? 3000 : false,
  })
}

export function jobDataOptions(
  apiBaseUrl: string,
  job: Pick<Job, 'id' | 'status'>,
) {
  return queryOptions({
    // A terminal status needs one final read after active polling stops.
    queryKey: ['jobs', 'data', job.id, job.status],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/${encodeURIComponent(job.id)}/data`,
        JobDataSchema,
        { signal },
      ),
    staleTime: canCancelJob(job) ? 0 : clientCacheStaleTime,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: canCancelJob(job) ? 3000 : false,
  })
}
