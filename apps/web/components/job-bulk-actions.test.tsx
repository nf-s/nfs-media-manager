import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobSchema, type Job } from '@repo/schemas/job'
import JobBulkActions from './job-bulk-actions'
import { JobLogEntry } from './pages/jobs-page-client'

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

test('selection keeps select-all and a range hint without showing unused actions', () => {
  const html = render([job('running', 'running')], [])
  assert.match(html, /aria-label="Select all loaded jobs"/)
  assert.doesNotMatch(html, /disabled/)
  assert.match(html, /Shift-click to select a range/)
  assert.doesNotMatch(html, /Choose action|Review action|Confirm/)
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
      assert.match(html, /<details><summary>Diagnostics<\/summary><\/details>/)
    else assert.doesNotMatch(html, /Diagnostics/)
    assert.doesNotMatch(html, /onerror|<img|Raw JSON/)
  }
})
