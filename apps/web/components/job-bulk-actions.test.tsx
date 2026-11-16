import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobSchema, type Job, type JobBatchEntry } from '@repo/schemas/job'
import { LASTFM_SCROBBLE_SYNC_TASK } from '@repo/schemas/lastfm'
import { SPOTIFY_PODCAST_SYNC_TASK } from '@repo/schemas/subscriptions'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import JobBulkActions from './job-bulk-actions'
import { JobLogEntry } from './job-log-entry'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in bulk action tests')
})
function job(id: string, status: Job['status'], itemCount = 1): Job {
  return JobSchema.parse({
    id,
    status,
    provider: 'fixture',
    createdAt: '2026-01-01',
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    scope: {},
    options: {},
    confirmBroadRun: false,
    logs: [],
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `${id}-${i}`,
      mediaItemId: `film-${i}`,
      provider: 'fixture',
      status,
      attemptCount: 1,
      message: null,
      createdAt: '2026-01-01',
      startedAt: null,
      finishedAt: null,
    })),
  })
}
function render(jobs: Job[], selectedIds: string[]) {
  return renderControl(
    <JobBulkActions
      jobs={jobs}
      selectedIds={selectedIds}
      onSelect={() => {}}
      onPending={() => {}}
    />,
  )
}
function renderControl(children: ReactNode) {
  const client = new QueryClient()
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}
function button(html: string, text: string) {
  const value = [...html.matchAll(/<button\b[^>]*>.*?<\/button>/g)].find(
    ([markup]) => markup.includes(text),
  )?.[0]
  assert.ok(value, `Missing ${text} button`)
  return value
}

test('empty selection renders nothing, so the selection bar stays hidden', () => {
  assert.equal(render([job('running', 'running')], []), '')
})

test('queued selection offers only cancellation and requires action review', () => {
  const html = render([job('queued', 'queued')], ['queued'])
  assert.match(html, /<option value="cancel">Cancel \(1\)/)
  assert.doesNotMatch(html, /value="retry"|value="dismiss"/)
  assert.match(button(html, 'Review action'), / disabled=""/)
  assert.doesNotMatch(html, /Confirm|type="checkbox"[^>]*checked[^>]*>Confirm/)
})

test('running selection retains cancellation and cancellation with retry', () => {
  const html = render([job('running', 'running')], ['running'])
  assert.match(html, /value="retry">Cancel and retry \(1\)/)
  assert.match(html, /value="cancel">Cancel \(1\)/)
  assert.doesNotMatch(html, /value="dismiss"/)
  assert.match(button(html, 'Review action'), / disabled=""/)
})

test('terminal unfinished work keeps retry and dismissal without a cancellation action', () => {
  const html = render(
    [job('failed', 'failed'), job('cancelled', 'cancelled')],
    ['failed', 'cancelled'],
  )
  assert.match(html, /value="retry">Retry \(2\)/)
  assert.match(html, /value="dismiss">Dismiss \(2\)/)
  assert.doesNotMatch(html, /value="cancel"/)
})

test('running work with no remaining media still supports cancellation but no retry', () => {
  const html = render([job('running', 'running', 0)], ['running'])
  assert.match(html, /value="cancel">Cancel \(1\)/)
  assert.doesNotMatch(html, /value="retry"/)
})

test('scrobble sync jobs without media items keep retry, dismissal and cancellation', () => {
  const sync = (id: string, status: Job['status']) =>
    JobSchema.parse({
      ...job(id, status, 0),
      provider: 'lastfm',
      options: { task: LASTFM_SCROBBLE_SYNC_TASK },
    })
  const failed = render([sync('failed', 'failed')], ['failed'])
  assert.match(failed, /value="retry">Retry \(1\)/)
  assert.match(failed, /value="dismiss">Dismiss \(1\)/)
  const running = render([sync('running', 'running')], ['running'])
  assert.match(running, /value="retry">Cancel and retry \(1\)/)
  assert.match(running, /value="cancel">Cancel \(1\)/)
})

test('YouTube and podcast subscription syncs without media items keep retry, dismissal and cancellation', () => {
  for (const [provider, task] of [
    ['youtube', YOUTUBE_SYNC_TASK],
    ['spotify', SPOTIFY_PODCAST_SYNC_TASK],
  ]) {
    const sync = (id: string, status: Job['status']) =>
      JobSchema.parse({
        ...job(id, status, 0),
        provider,
        options: { task },
      })
    const failed = render([sync('failed', 'failed')], ['failed'])
    assert.match(failed, /value="retry">Retry \(1\)/)
    assert.match(failed, /value="dismiss">Dismiss \(1\)/)
    const running = render([sync('running', 'running')], ['running'])
    assert.match(running, /value="retry">Cancel and retry \(1\)/)
    assert.match(running, /value="cancel">Cancel \(1\)/)
  }
})

test('mixed statuses retain the independent eligibility counts', () => {
  const html = render(
    [
      job('queued', 'queued'),
      job('running', 'running'),
      job('failed', 'failed'),
    ],
    ['queued', 'running', 'failed'],
  )
  assert.match(html, /value="retry">Cancel and retry \(2\)/)
  assert.match(html, /value="cancel">Cancel \(2\)/)
  assert.match(html, /value="dismiss">Dismiss \(1\)/)
})

test('single-job actions use the same review flow without another selection checkbox', () => {
  const html = renderControl(
    <JobBulkActions
      jobs={[job('failed', 'failed', 6)]}
      selectedIds={['failed']}
      single
      onSelect={() => {}}
      onPending={() => {}}
    />,
  )
  assert.match(html, /aria-label="Job action"/)
  assert.doesNotMatch(html, /type="checkbox"|Select loaded|selected job action/)
  assert.match(button(html, 'Review action'), / disabled=""/)
})

test('a row action chooses its action and opens the review for that job', () => {
  const cases: {
    status: Job['status']
    action: 'retry' | 'cancel'
    label: string
  }[] = [
    { status: 'failed', action: 'retry', label: 'Confirm retry' },
    { status: 'queued', action: 'cancel', label: 'Confirm cancel jobs' },
  ]
  for (const { status, action, label } of cases) {
    const html = renderControl(
      <JobBulkActions
        jobs={[job('row', status)]}
        selectedIds={['row']}
        request={{ action, jobId: 'row', at: 1 }}
        onSelect={() => {}}
        onPending={() => {}}
      />,
    )
    assert.match(html, new RegExp(`<option value="${action}" selected=""`))
    assert.match(html, /role="region" aria-label="Review job action"/)
    assert.match(html, new RegExp(`>${label}</button>`))
  }
})

function batch(overrides: Partial<JobBatchEntry> = {}): JobBatchEntry {
  return {
    kind: 'batch',
    batchId: 'batch-1',
    provider: 'fixture',
    providers: ['fixture'],
    mediaType: 'album',
    label: null,
    importId: null,
    total: 240,
    matching: 240,
    queued: 142,
    running: 2,
    succeeded: 94,
    failed: 2,
    cancelled: 0,
    createdAt: '2026-01-02T00:00:00.000Z',
    startedAt: '2026-01-02T00:02:00.000Z',
    finishedAt: null,
    waiting: null,
    ...overrides,
  }
}

test("a batch row's Cancel reviews every unfinished job and keeps finished ones", () => {
  const html = renderControl(
    <JobBulkActions
      jobs={[]}
      selectedIds={[]}
      batches={[batch()]}
      selectedBatchIds={['batch-1']}
      request={{ action: 'cancel', batchId: 'batch-1', at: 1 }}
      onSelect={() => {}}
      onPending={() => {}}
    />,
  )
  assert.match(html, /<option value="cancel" selected="">Cancel \(144\)/)
  assert.doesNotMatch(html, /value="retry"|value="dismiss"/)
  assert.match(html, /role="region" aria-label="Review job action"/)
  assert.match(html, /<strong>Cancel jobs<\/strong> · 144 jobs/)
  assert.match(html, /Stop 2 running/)
  assert.match(
    html,
    /Cancel 144 unfinished jobs in this batch, including jobs not loaded here. Keep 96 finished jobs and their results./,
  )
  assert.doesNotMatch(html, /Stop queued and running work/)
  assert.match(html, />Confirm cancel jobs<\/button>/)
})

test('selected batch jobs are not counted twice and other actions skip the batch', () => {
  const child = JobSchema.parse({
    ...job('child', 'queued'),
    options: { batchId: 'batch-1' },
  })
  const failed = job('failed', 'failed')
  const props = {
    jobs: [child, failed],
    selectedIds: ['child', 'failed'],
    batches: [batch({ running: 0 })],
    selectedBatchIds: ['batch-1'],
    onSelect: () => {},
    onPending: () => {},
  }
  const cancel = renderControl(
    <JobBulkActions
      {...props}
      request={{ action: 'cancel', batchId: 'batch-1', at: 1 }}
    />,
  )
  assert.match(cancel, /value="cancel" selected="">Cancel \(142\)/)
  assert.match(cancel, /· 142 jobs · 1 ineligible jobs will be skipped/)
  assert.doesNotMatch(cancel, /running/)
  const retry = renderControl(
    <JobBulkActions
      {...props}
      request={{ action: 'retry', jobId: 'failed', at: 1 }}
    />,
  )
  assert.match(retry, /value="retry" selected="">Retry \(1\)/)
  assert.match(retry, / · 1 batch will be skipped/)
})

test('a finished batch offers no cancellation', () => {
  const html = renderControl(
    <JobBulkActions
      jobs={[]}
      selectedIds={[]}
      batches={[batch({ queued: 0, running: 0, succeeded: 238 })]}
      selectedBatchIds={['batch-1']}
      onSelect={() => {}}
      onPending={() => {}}
    />,
  )
  assert.equal(html, '')
})

test('successful single jobs render no unavailable action controls', () => {
  const html = renderControl(
    <JobBulkActions
      jobs={[job('done', 'succeeded')]}
      selectedIds={['done']}
      single
      onSelect={() => {}}
      onPending={() => {}}
    />,
  )
  assert.equal(html, '')
})

test('job diagnostics are optional, collapsed and do not render payloads on page load', () => {
  for (const metadata of [
    null,
    {},
    { diagnostics: null },
    { diagnostics: { reason: '<img src=x onerror=alert(1)>' } },
  ]) {
    const log = JobSchema.shape.logs.element.parse({
      id: 'log',
      level: 'warn',
      message: 'Lookup did not match',
      metadata,
      createdAt: '2026-01-01',
    })
    const html = renderControl(<JobLogEntry log={log} jobId="job" />)
    if (metadata && 'diagnostics' in metadata && metadata.diagnostics !== null)
      assert.match(
        html,
        /<details class="ops-disclosure"><summary>Diagnostics<\/summary><\/details>/,
      )
    else assert.doesNotMatch(html, /Diagnostics/)
    assert.doesNotMatch(html, /onerror|<img|Raw JSON/)
  }
})

function renderRequestError(error: unknown) {
  const log = JobSchema.shape.logs.element.parse({
    id: 'request-error',
    level: 'error',
    message: 'Request failed',
    metadata: { error },
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  return renderControl(<JobLogEntry log={log} jobId="fixture-job" />)
}

test('request errors show actual response status, receipt time, retry policy and quota values', () => {
  const html = renderRequestError({
    name: 'ProviderRequestError',
    message: 'Provider rate limit reached',
    stack: null,
    causes: [],
    code: 'rate-limit',
    retryAt: 1767225660000,
    diagnostics: {
      source: 'provider-response',
      httpStatus: 429,
      responseReceivedAt: '2026-01-01T00:00:00.000Z',
      retryAfter: { seconds: 60 },
      quotaHeaders: {
        'x-discogs-ratelimit': 60,
        'x-discogs-ratelimit-used': 60,
        'x-discogs-ratelimit-remaining': 0,
      },
    },
  })
  assert.match(html, /Provider response · HTTP 429/)
  assert.match(html, /Received/)
  assert.match(html, /2026-01-01T00:00:00.000Z/)
  assert.match(html, /<dt>Retry-After<\/dt><dd>60 seconds<\/dd>/)
  assert.match(html, /Request retry time/)
  assert.match(
    html,
    /Provider cooldowns and dispatch pauses can delay execution/,
  )
  assert.match(html, /2026-01-01T00:01:00.000Z/)
  assert.match(html, /<dt>Discogs limit<\/dt><dd>60<\/dd>/)
  assert.match(html, /<dt>Discogs used<\/dt><dd>60<\/dd>/)
  assert.match(html, /<dt>Discogs remaining<\/dt><dd>0<\/dd>/)
})

test('local safety errors explicitly identify that no outgoing request occurred', () => {
  for (const source of [
    'local-cooldown',
    'local-budget',
    'local-access-halt',
  ]) {
    const html = renderRequestError({
      name: 'ProviderRequestError',
      message: 'Locally blocked',
      stack: null,
      causes: [],
      retryAt: 1767225660000,
      diagnostics: { source },
    })
    assert.match(html, /No outgoing request/)
    assert.match(html, /Local retry time/)
    assert.doesNotMatch(html, /Provider response|HTTP|Received/)
    assert.doesNotMatch(html, /dispatch pauses can delay execution/)
  }
})

test('HTTP success with a quota error remains distinct from HTTP 429 and cause evidence is shown once', () => {
  const cause = {
    name: 'ProviderRequestError',
    message: 'Provider quota error',
    stack: null,
    diagnostics: {
      source: 'provider-response',
      httpStatus: 200,
      responseReceivedAt: '2026-01-01T00:00:00.000Z',
      quotaError: true,
      retryAfter: { at: '2026-01-01T00:05:00.000Z' },
    },
  }
  const html = renderRequestError({ ...cause, causes: [cause] })
  assert.equal((html.match(/Provider response · HTTP 200/g) ?? []).length, 1)
  assert.match(html, /Provider reported a quota error/)
  assert.match(html, /2026-01-01T00:05:00.000Z/)
  assert.doesNotMatch(html, /HTTP 429/)
  const onlyCause = renderRequestError({
    name: 'Error',
    message: 'Failed to complete',
    stack: null,
    causes: [cause],
  })
  assert.match(onlyCause, /Provider response · HTTP 200/)
})

test('legacy error text does not invent response status or local request provenance', () => {
  const html = renderRequestError({
    name: 'ProviderRequestError',
    message: 'Provider rate limit reached',
    stack: null,
    causes: [],
  })
  assert.match(html, /Provider rate limit reached/)
  assert.doesNotMatch(
    html,
    /HTTP 429|No outgoing request|Request error details|Received/,
  )
})
