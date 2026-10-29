import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobActivitySchema } from '@repo/schemas/job'
import JobActivity, { MediaJobActivity } from './job-activity'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in activity tests')
})
const empty = { queued: 0, running: 0, failed: 0, imports: 0 }
const activity = JobActivitySchema.parse({
  queued: 2,
  running: 2,
  failed: 12,
  imports: 2,
  completed: 0,
  completedImports: 0,
  libraries: [
    { mediaType: 'album', queued: 2, running: 1, failed: 4, imports: 1 },
    { mediaType: 'film', queued: 0, running: 1, failed: 8, imports: 0 },
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

test('activity groups link each running, queued, attention and import count to its library', () => {
  const html = renderToStaticMarkup(
    <MediaJobActivity mediaType="album" counts={activity.libraries[0]} />,
  )
  for (const status of ['running', 'queued', 'attention'])
    assert.ok(
      html.includes(`href="/jobs?status=${status}&amp;mediaType=album"`),
    )
  assert.match(html, /aria-label="Albums: 4 needs attention"/)
  assert.match(html, /aria-label="Albums: 2 queued"/)
  assert.match(html, /href="\/imports\?mediaType=album"/)
  assert.match(html, /aria-label="Albums jobs and history"/)
  assert.doesNotMatch(html, /mediaType=film/)
})

test('idle libraries retain a jobs history link without zero-count status badges', () => {
  const html = renderToStaticMarkup(
    <MediaJobActivity mediaType="album" counts={empty} />,
  )
  assert.match(html, /No active jobs or issues/)
  assert.match(html, /href="\/jobs\?mediaType=album"/)
  assert.doesNotMatch(html, /status=|<strong>0/)
})

test('one compact trigger exposes all library links inside an accessible native popover', () => {
  const html = renderActivity(activity)
  assert.equal((html.match(/popoverTarget=/gi) ?? []).length, 1)
  assert.match(html, /aria-label="Job activity: 6 active, 12 issues"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(
    html,
    /popover="auto" role="region" tabindex="-1" aria-labelledby=/,
  )
  assert.match(html, /aria-label="Close job activity"/)
  assert.doesNotMatch(html.slice(0, html.indexOf('popover="auto"')), /href=/)
  assert.match(html, /aria-label="Albums: 4 needs attention"/)
  assert.match(html, /aria-label="Films: 8 needs attention"/)
  assert.match(html, /href="\/jobs\?status=attention&amp;mediaType=album"/)
  assert.match(html, /href="\/jobs\?status=attention&amp;mediaType=film"/)
  assert.match(html, /Shared \/ unclassified imports <strong>1<\/strong>/)
})

test('global legacy counts are not assigned to either library', () => {
  const html = renderActivity({ ...activity, libraries: undefined })
  assert.match(html, /6 active, 12 needing attention across all libraries/)
  assert.match(html, /Per-library counts unavailable/)
  assert.match(html, /href="\/jobs\?mediaType=album"/)
  assert.match(html, /href="\/jobs\?mediaType=film"/)
  assert.doesNotMatch(html, /Albums: 12|Films: 12|No active jobs or issues/)
})

test('loading and unavailable status never claim that jobs are idle', () => {
  const loading = renderActivity(undefined)
  assert.match(loading, /Checking jobs/)
  assert.match(loading, /Loading activity/)
  assert.doesNotMatch(loading, /Jobs idle|No active jobs or issues/)
  const offline = renderActivity(undefined, true)
  assert.match(offline, /Status offline/)
  assert.match(offline, /Status unavailable/)
  assert.match(offline, />Retry<\/button>/)
  assert.doesNotMatch(offline, /Jobs idle|No active jobs or issues/)
  const stale = renderActivity(activity, true)
  assert.match(stale, /Showing last known counts/)
  assert.match(stale, /Albums: 4 needs attention/)
})

test('idle activity remains accessible and does not invent shared imports', () => {
  const html = renderActivity({
    ...activity,
    ...empty,
    libraries: [
      { ...empty, mediaType: 'album' },
      { ...empty, mediaType: 'film' },
    ],
  })
  assert.match(html, /aria-label="Job activity: Jobs idle"/)
  assert.equal((html.match(/No active jobs or issues/g) ?? []).length, 2)
  assert.doesNotMatch(
    html,
    /Shared \/ unclassified imports|motion-safe:animate-spin/,
  )
})
