'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { getJobDismissal } from '@repo/schemas/job'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { fetchApiData } from '@/utils/api'
import {
  activeJobProgressLabel,
  isArtistEnrichmentJob,
  jobTaskTitle,
} from '@/utils/job-selection'
import { jobDetailOptions } from '@/utils/job-data'
import { CreatorDetailState } from './creator-detail-state'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import JobBulkActions from './job-bulk-actions'
import { StoredJobData } from './job-data-viewer'
import { JobLogEntry } from './job-log-entry'
import { useConfig } from './providers'

const tabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'data', label: 'Stored JSON' },
  { value: 'logs', label: 'Logs' },
]

export function JobDetail({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const tab =
    tabs.find(({ value }) => value === view.params.get('tab'))?.value ??
    'overview'
  const [actionPending, setActionPending] = useState(false)
  const query = useQuery(jobDetailOptions(apiBaseUrl, id))
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
        { signal },
      ),
  })
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={query.refetch}
        subject="job"
      />
    )
  const job = query.data
  const provider =
    providers.data?.find(({ id }) => id === job.provider)?.displayName ??
    job.provider
  const title =
    jobTaskTitle(job) ??
    (job.items
      .map((item) => item.mediaTitle ?? 'Unavailable item')
      .join(', ') ||
      'Job details')
  const dismissal = getJobDismissal(job.options)
  const progress = activeJobProgressLabel(job)

  return (
    <article className="media-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="job" />
      )}
      <header className="mb-4 min-w-0">
        <h1 className="break-words text-xl font-semibold">{title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>{provider}</span>
          <span className="job-status" data-status={job.status}>
            {job.status}
            {dismissal ? ' · dismissed' : ''}
          </span>
          {progress && <span className="quiet">{progress}</span>}
        </p>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === 'overview') view.params.delete('tab')
          else view.params.set('tab', value)
          view.replace(view.params)
        }}
      >
        <TabsList
          aria-label="Job details"
          className="max-w-full justify-start overflow-x-auto"
        >
          {tabs.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="mt-3 grid gap-4">
          {job.errorMessage && (
            <p role="alert" className="break-words">
              {job.errorMessage}
            </p>
          )}
          <JobBulkActions
            jobs={[job]}
            selectedIds={[job.id]}
            single
            disabled={actionPending}
            onSelect={() => {}}
            onPending={setActionPending}
          />
          {dismissal && (
            <p className="muted">
              Dismissed {new Date(dismissal.dismissedAt).toLocaleString()}.
              Errors retained.
            </p>
          )}
          {typeof job.options.retryJobId === 'string' && (
            <DetailLink kind="job" id={job.options.retryJobId}>
              View retry
            </DetailLink>
          )}
          <dl className="detail-metrics">
            {[
              { label: 'Created', date: job.createdAt },
              { label: 'Started', date: job.startedAt },
              { label: 'Finished', date: job.finishedAt },
            ].map(({ label, date }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {date ? (
                    <time dateTime={date}>
                      {new Date(date).toLocaleString()}
                    </time>
                  ) : (
                    '-'
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {isArtistEnrichmentJob(job) &&
            typeof job.options.artistId === 'string' && (
              <DetailLink kind="artist" id={job.options.artistId}>
                {typeof job.options.artistName === 'string'
                  ? job.options.artistName
                  : 'View artist'}
              </DetailLink>
            )}
          {job.items.length > 0 && (
            <ul className="grid gap-3" aria-label="Job items">
              {job.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                >
                  {item.mediaItemId && item.mediaType ? (
                    <DetailLink
                      kind={item.mediaType}
                      id={item.mediaItemId}
                      className="break-words"
                    >
                      {item.mediaTitle ?? 'Untitled item'}
                    </DetailLink>
                  ) : (
                    'Unavailable item'
                  )}
                  <span className="job-status" data-status={item.status}>
                    {item.status}
                  </span>
                  <span className="muted">
                    {item.attemptCount}{' '}
                    {item.attemptCount === 1 ? 'attempt' : 'attempts'}
                  </span>
                  {item.message && item.message !== job.errorMessage && (
                    <span className="break-words">{item.message}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="quiet break-all text-xs">Job ID: {job.id}</p>
        </TabsContent>
        <TabsContent value="data" className="mt-3 min-w-0">
          {tab === 'data' && <StoredJobData job={job} />}
        </TabsContent>
        <TabsContent value="logs" className="job-logs mt-3 min-w-0">
          {job.logs.length ? (
            <ol>
              {job.logs.map((log) => (
                <JobLogEntry key={log.id} log={log} jobId={job.id} />
              ))}
            </ol>
          ) : (
            <p className="muted">No log entries recorded.</p>
          )}
        </TabsContent>
      </Tabs>
    </article>
  )
}
