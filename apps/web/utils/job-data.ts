import { queryOptions } from '@tanstack/react-query'
import { JobDataSchema, type Job } from '@repo/schemas/job'
import { fetchApiData } from './api'

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
    staleTime: 0,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval:
      job.status === 'queued' || job.status === 'running' ? 3000 : false,
  })
}
