'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  JobSchema,
  getJobActivityStage,
  getJobDismissal,
  type Job,
  type JobSummary,
  type JobSummaryAction,
} from '@repo/schemas/job'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Status, statusLabels } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import {
  EMPTY_VALUE,
  formatCount,
  formatDateTime,
  formatElapsed,
  formatUntil,
} from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { jobActivityLabel } from '@/utils/job-activity'
import {
  activeJobProgressLabel,
  canCancelJob,
  isArtistJob,
  isSpotifyTrackSearchJob,
} from '@/utils/job-selection'
import { jobDetailOptions } from '@/utils/job-data'
import {
  jobBatchHref,
  jobStatus,
  jobTitle,
  spotifyTrackSearchResult,
} from '@/utils/job-entries'
import {
  isBlockingWait,
  providerDisplayName,
  providerListOptions,
} from '@/utils/provider-health'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import { useDetailView } from './detail-inspector-context'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { DetailLink } from './detail-link'
import JobBulkActions from './job-bulk-actions'
import { StoredJobData } from './job-data-viewer'
import { JobLogEntry } from './job-log-entry'
import { useConfig } from './providers'
import { useTableWidths } from './secondary-table'

const tabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'data', label: 'Request and response' },
  { value: 'logs', label: 'Logs' },
]

/** Fits the 600px detail inspector; the message takes any room left. */
const itemColumns = [
  { key: 'item', label: 'Item', width: 200 },
  { key: 'status', label: 'Status', width: 120 },
  { key: 'attempts', label: 'Attempts', width: 100 },
  { key: 'message', label: 'Message', width: 140 },
]

const providerActionLabels: Record<
  Exclude<JobSummaryAction, 'retry' | 'find-match'>,
  string
> = {
  'open-provider': 'Open provider',
  'resume-provider': 'Resume provider',
  'sign-in': 'Sign in',
  'add-key': 'Add key',
}

/** What the summary says when the server sent none. */
function fallbackSummary(job: Job): JobSummary {
  return {
    headline:
      job.status === 'queued' && job.waiting
        ? job.waiting.detail
        : (job.errorMessage ?? statusLabels[jobStatus(job)]),
    code: null,
    retryAt: job.waiting?.until ?? null,
    actions: [],
  }
}

/** The item a find-match action opens on its Sources tab. */
function matchTarget(
  job: Job,
): { kind: 'album' | 'film' | 'artist'; id: string } | null {
  if (isArtistJob(job) && typeof job.options.artistId === 'string')
    return { kind: 'artist', id: job.options.artistId }
  const item = job.items.find((entry) => entry.mediaItemId && entry.mediaType)
  return item?.mediaItemId && item.mediaType
    ? { kind: item.mediaType, id: item.mediaItemId }
    : null
}

export function JobDetail({
  id,
  headingLevel = 2,
}: {
  id: string
  /** 1 on the standalone job page. */
  headingLevel?: 1 | 2
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const view = useDetailView()
  const tab =
    tabs.find(({ value }) => value === view.params.get('tab'))?.value ??
    'overview'
  function tabParams(value: string) {
    const params = new URLSearchParams(view.params)
    if (value === 'overview') params.delete('tab')
    else params.set('tab', value)
    return params
  }
  const [actionPending, setActionPending] = useState(false)
  const query = useQuery(jobDetailOptions(apiBaseUrl, id))
  const providers = useQuery(providerListOptions(apiBaseUrl))
  const itemWidths = useTableWidths('job-items', itemColumns)
  const itemLayout = itemWidths.layout(itemColumns.map((column) => column.key))
  const retry = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/${encodeURIComponent(id)}/retry`,
        JobSchema,
        { method: 'POST', body: JSON.stringify({ confirmBroadRun: false }) },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
    },
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
  const now = new Date()
  const provider = providerDisplayName(providers.data, job.provider)
  const providerHref = `/providers/${encodeURIComponent(job.provider)}`
  const title = jobTitle(job)
  const dismissal = getJobDismissal(job.options)
  const activity = getJobActivityStage(job.options)
  const active = canCancelJob(job)
  const progress = activity
    ? active
      ? jobActivityLabel(activity)
      : job.status === 'failed'
        ? `Last stage · ${jobActivityLabel(activity)}`
        : null
    : activeJobProgressLabel(job)
  const state = jobStatus(job)
  const summary = job.summary ?? fallbackSummary(job)
  const target = matchTarget(job)
  const batchId =
    typeof job.options.batchId === 'string' ? job.options.batchId : null
  const singleItem =
    job.items.length === 1 &&
    job.items[0]?.mediaItemId &&
    job.items[0].mediaType
      ? job.items[0]
      : null
  const recording = job.options.acceptedTrackId ?? job.options.trackId
  const trackId =
    isSpotifyTrackSearchJob(job) && typeof recording === 'string'
      ? recording
      : null

  function actionButton(action: JobSummaryAction, primary: boolean) {
    const variant = primary ? 'primary' : 'default'
    if (action === 'retry')
      return (
        <Button
          key={action}
          size="md"
          variant={variant}
          disabled={retry.isPending || actionPending}
          onClick={() => retry.mutate()}
        >
          {retry.isPending ? 'Retrying...' : 'Retry'}
        </Button>
      )
    if (action === 'find-match')
      return target ? (
        <Button key={action} size="md" variant={variant} asChild>
          <DetailLink
            kind={target.kind}
            id={target.id}
            tab="sources"
            view={{ sourceProvider: job.provider, sourceMode: 'match' }}
          >
            Find match
          </DetailLink>
        </Button>
      ) : null
    return (
      <Button key={action} size="md" variant={variant} asChild>
        <Link href={providerHref}>{providerActionLabels[action]}</Link>
      </Button>
    )
  }

  const facts: ReactNode[] = [
    <Status
      key="status"
      state={state}
      title={job.status === 'queued' ? job.waiting?.detail : undefined}
    >
      {state === 'waiting' && job.waiting?.until
        ? `Waiting until ${formatUntil(job.waiting.until, now)}`
        : statusLabels[state]}
      {dismissal ? ' · dismissed' : ''}
    </Status>,
    <Link key="provider" href={providerHref}>
      {provider}
    </Link>,
    progress,
    spotifyTrackSearchResult(job),
    job.startedAt ? `Started ${formatDateTime(job.startedAt)}` : null,
    job.startedAt
      ? formatElapsed(
          (job.finishedAt ? Date.parse(job.finishedAt) : now.getTime()) -
            Date.parse(job.startedAt),
        )
      : null,
  ]
  const tone =
    job.status === 'failed'
      ? 'danger'
      : job.status === 'queued' &&
          job.waiting &&
          isBlockingWait(job.waiting.reason)
        ? 'attention'
        : undefined

  return (
    <article className="ops-job">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="job" />
      )}
      <DetailHeader
        kind="Job"
        title={title}
        headingLevel={headingLevel}
        facts={facts}
        actions={
          <>
            {summary.actions.map((action, index) =>
              actionButton(action, index === 0),
            )}
            <DetailActionsSpacer />
            {singleItem?.mediaItemId && singleItem.mediaType && (
              <Button variant="ghost" size="md" asChild>
                <DetailLink
                  kind={singleItem.mediaType}
                  id={singleItem.mediaItemId}
                >
                  Open {singleItem.mediaType}
                </DetailLink>
              </Button>
            )}
            {trackId && (
              <Button variant="ghost" size="md" asChild>
                <DetailLink kind="track" id={trackId} tab="sources">
                  Open track
                </DetailLink>
              </Button>
            )}
            <DetailMore
              crumb={{ title, batchHref: jobBatchHref(job) ?? undefined }}
            />
          </>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => view.replace(tabParams(value))}
      >
        <TabsList aria-label="Job details">
          {tabs.map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              {...workspaceTabLinkProps(
                view.workspaceHref(tabParams(value)),
                label,
              )}
            >
              {label}
              {value === 'logs' && job.logs.length > 0 && (
                <span className="ds-muted">{formatCount(job.logs.length)}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Section flush>
            <Notice tone={tone}>
              <span className="ops-headline">{summary.headline}</span>
              {summary.code && (
                <span className="ds-muted"> · Code {summary.code}</span>
              )}
              {summary.retryAt && (
                <span className="ds-muted">
                  {' '}
                  · {job.status === 'queued'
                    ? 'Resumes'
                    : 'Can retry after'}{' '}
                  {formatUntil(summary.retryAt, now)}
                </span>
              )}
            </Notice>
            {retry.isError && (
              <Notice tone="danger">{retry.error.message}</Notice>
            )}
            {retry.data && (
              <Notice>
                Retry queued.{' '}
                <DetailLink kind="job" id={retry.data.id}>
                  View retry
                </DetailLink>
              </Notice>
            )}
          </Section>
          <Section>
            <JobBulkActions
              jobs={[job]}
              selectedIds={[job.id]}
              single
              disabled={actionPending}
              onSelect={() => {}}
              onPending={setActionPending}
            />
            {dismissal && (
              <p className="ds-help">
                Dismissed {formatDateTime(dismissal.dismissedAt)}. Errors
                retained.
              </p>
            )}
            {typeof job.options.retryJobId === 'string' && (
              <DetailLink kind="job" id={job.options.retryJobId}>
                View retry
              </DetailLink>
            )}
          </Section>
          {job.items.length > 0 && (
            <Section title="Items" note={formatCount(job.items.length)}>
              <Table aria-label="Job items" {...itemLayout.table}>
                {itemLayout.colgroup}
                <TableHeader>
                  <TableRow>
                    <TableHead resizer={itemWidths.resizer('item')}>
                      Item
                    </TableHead>
                    <TableHead resizer={itemWidths.resizer('status')}>
                      Status
                    </TableHead>
                    <TableHead
                      align="end"
                      resizer={itemWidths.resizer('attempts')}
                    >
                      Attempts
                    </TableHead>
                    <TableHead resizer={itemWidths.resizer('message')}>
                      Message
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {job.items.map((item) => {
                    const itemState =
                      item.status === 'succeeded' ? 'done' : item.status
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          {item.mediaItemId && item.mediaType ? (
                            <DetailLink
                              kind={item.mediaType}
                              id={item.mediaItemId}
                              className="ds-cell-title"
                            >
                              {item.mediaTitle ?? 'Untitled item'}
                            </DetailLink>
                          ) : (
                            'Unavailable item'
                          )}
                        </TableCell>
                        <TableCell>
                          <Status state={itemState} />
                        </TableCell>
                        <TableCell align="end">
                          {formatCount(item.attemptCount)}{' '}
                          {item.attemptCount === 1 ? 'attempt' : 'attempts'}
                        </TableCell>
                        <TableCell title={item.message ?? undefined}>
                          {item.message && item.message !== job.errorMessage
                            ? item.message
                            : EMPTY_VALUE}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Section>
          )}
          <Section title="Details">
            <KeyValues
              items={[
                ...(batchId
                  ? [
                      {
                        label: 'Batch',
                        value: (
                          <Link
                            href={`/jobs?batchId=${encodeURIComponent(batchId)}`}
                          >
                            Jobs in this batch
                          </Link>
                        ),
                      },
                    ]
                  : []),
                ...(isArtistJob(job) && typeof job.options.artistId === 'string'
                  ? [
                      {
                        label: 'Artist',
                        value: (
                          <DetailLink kind="artist" id={job.options.artistId}>
                            {typeof job.options.artistName === 'string'
                              ? job.options.artistName
                              : 'View artist'}
                          </DetailLink>
                        ),
                      },
                    ]
                  : []),
                { label: 'Created', value: formatDateTime(job.createdAt) },
                { label: 'Started', value: formatDateTime(job.startedAt) },
                ...(activity
                  ? [
                      ...(!active && job.status !== 'failed'
                        ? [
                            {
                              label: 'Last stage',
                              value: jobActivityLabel(activity),
                            },
                          ]
                        : []),
                      {
                        label: 'Stage started',
                        value: formatDateTime(activity.startedAt),
                      },
                    ]
                  : []),
                { label: 'Finished', value: formatDateTime(job.finishedAt) },
                {
                  label: 'Job ID',
                  value: <span className="ds-mono">{job.id}</span>,
                },
              ]}
            />
          </Section>
        </TabsContent>
        <TabsContent value="data">
          {tab === 'data' && <StoredJobData job={job} />}
        </TabsContent>
        <TabsContent value="logs">
          {job.logs.length ? (
            <ol className="ds-timeline ops-log" aria-label="Job log">
              {job.logs.map((log) => (
                <JobLogEntry key={log.id} log={log} jobId={job.id} />
              ))}
            </ol>
          ) : (
            <p className="ds-help">No log entries recorded.</p>
          )}
        </TabsContent>
      </Tabs>
    </article>
  )
}
