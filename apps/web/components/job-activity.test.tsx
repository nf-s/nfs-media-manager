import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobActivitySchema, JobSchema, type JobEntry } from '@repo/schemas/job'
import JobActivity, { ActivityEntry } from './job-activity'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in activity tests')
})
const activity = JobActivitySchema.parse({
  queued: 2,
  running: 2,
  failed: 12,
  imports: 2,
  completed: 0,
  completedImports: 0,
  libraries: [
    { mediaType: 'album', queued: 2, running: 1, failed: 4, imports: 1 },
  ],
})

function renderActivity(data: unknown, error = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  if (data) client.setQueryData(['job-activity'], JobActivitySchema.parse(data))
  if (error)
    client
      .getQueryCache()
      .build(client, { queryKey: ['job-activity'] })
      .setState({
        status: 'error',
        error: new Error('Offline'),
        fetchStatus: 'idle',
      })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <JobActivity />
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('the Jobs item carries one compact trigger for an accessible native popover', () => {
  const html = renderActivity(activity)
  assert.match(
    html,
    /<button\b(?=[^>]*popoverTarget="[^"]+")(?=[^>]*aria-label="Job activity: 6 active, 12 issues")[^>]*>/,
  )
  assert.match(html, /class="ds-count" data-tone="danger">12</)
  assert.match(html, /popover="auto" role="region" tabindex="-1"/)
  assert.match(html, /class="ds-pop ops-activity"/)
  assert.match(html, /<h2 id="[^"]+">Activity<\/h2>/)
  assert.match(html, /aria-label="Close job activity"/)
})

test('counts link to the filtered Jobs page and All jobs shows what runs', () => {
  const html = renderActivity(activity)
  assert.match(
    html,
    /href="\/jobs\?status=queued"><span class="ds-status" data-status="queued">2 queued/,
  )
  assert.match(
    html,
    /href="\/jobs\?status=attention"><span class="ds-status" data-status="failed">12 need attention/,
  )
  assert.match(
    html,
    /href="\/imports"><span class="ds-status" data-status="running">2 importing/,
  )
  assert.match(
    html,
    /class="ds-menu-item" href="\/jobs">[\s\S]*All jobs<span class="ds-muted">2 running/,
  )
})

test('active work without failures shows the active count in attention tone', () => {
  const html = renderActivity({ ...activity, failed: 0 })
  assert.match(html, /class="ds-count" data-tone="attention">6</)
  assert.doesNotMatch(html, /need attention/)
})

test('loading and unavailable status never claim that jobs are idle', () => {
  assert.match(renderActivity(null), /Job activity: Checking jobs/)
  const offline = renderActivity(null, true)
  assert.match(offline, /Job activity: Status offline/)
  assert.match(offline, /Status unavailable\./)
  assert.match(offline, />Retry</)
  assert.doesNotMatch(offline, /Jobs idle/)
})

test('idle activity says so without zero-count badges', () => {
  const html = renderActivity({
    ...activity,
    queued: 0,
    running: 0,
    failed: 0,
    imports: 0,
    libraries: [],
  })
  assert.match(html, /Job activity: Jobs idle/)
  assert.match(html, /No active jobs or issues\./)
  assert.doesNotMatch(html, /ds-count|0 queued|importing/)
})

test('a waiting batch names its provider, progress and when it resumes', () => {
  const batch: JobEntry = {
    kind: 'batch',
    batchId: 'batch-1',
    provider: 'fixture-ratings',
    providers: ['fixture-ratings'],
    mediaType: 'album',
    label: 'Library import',
    importId: null,
    total: 10,
    matching: 10,
    queued: 6,
    running: 0,
    succeeded: 4,
    failed: 0,
    cancelled: 0,
    createdAt: '2026-01-02T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    waiting: {
      reason: 'cooldown',
      until: '2026-01-02T14:20:00.000Z',
      detail: 'Cooling down',
    },
  }
  const html = renderToStaticMarkup(
    <ActivityEntry
      entry={batch}
      providers={undefined}
      now={new Date('2026-01-02T14:00:00.000Z')}
    />,
  )
  assert.match(
    html,
    /href="\/jobs\?batchId=batch-1"[^>]*>Library import · 10 albums</,
  )
  assert.match(html, /fixture-ratings/)
  assert.match(html, /aria-valuenow="4"/)
  assert.match(
    html,
    /data-status="waiting" title="Cooling down">Waiting until /,
  )
})

test('a running task job links to its page and shows its pages read', () => {
  const job = JobSchema.parse({
    id: 'job-1',
    provider: 'fixture-scrobbles',
    status: 'running',
    createdAt: '2026-01-02T00:00:00Z',
    startedAt: '2026-01-02T00:00:00Z',
    finishedAt: null,
    errorMessage: null,
    scope: {},
    options: { task: 'lastfm-scrobble-sync' },
    confirmBroadRun: false,
    items: [],
    logs: [],
    waiting: null,
    progress: { done: 3, total: 12 },
  })
  const html = renderToStaticMarkup(
    <ActivityEntry entry={{ kind: 'job', job }} providers={undefined} />,
  )
  assert.match(html, /href="\/jobs\/job-1"[^>]*>Scrobble sync</)
  assert.match(html, /aria-valuenow="3"/)
  assert.doesNotMatch(html, /Waiting/)
  const saving = renderToStaticMarkup(
    <ActivityEntry
      entry={{
        kind: 'job',
        job: {
          ...job,
          options: {
            ...job.options,
            activity: {
              stage: 'Saving scrobbles',
              startedAt: job.createdAt,
            },
          },
        },
      }}
      providers={undefined}
    />,
  )
  assert.match(saving, /Saving scrobbles/)
  assert.doesNotMatch(saving, /progressbar/)
})
