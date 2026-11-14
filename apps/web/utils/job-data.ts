import { queryOptions } from '@tanstack/react-query'
import { JobDataSchema, type Job } from '@repo/schemas/job'
import { fetchApiData } from './api'
import { canCancelJob } from './job-selection'
import { clientCacheStaleTime } from './query-cache'

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
