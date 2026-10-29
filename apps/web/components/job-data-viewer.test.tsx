import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobDataSchema, type Job } from '@repo/schemas/job'
import { jobDataOptions } from '@/utils/job-data'
import JobDataViewer, { StoredJobData } from './job-data-viewer'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in rendering tests')
})
const empty = {
  jobId: 'job-1',
  snapshots: [],
  diagnostics: [],
  itemPayloads: [],
}

function render({
  status = 'failed',
  data,
  collapsed = false,
  visible = true,
  error = false,
}: {
  status?: Job['status']
  data?: unknown
  collapsed?: boolean
  visible?: boolean
  error?: boolean
} = {}) {
  const client = new QueryClient()
  const job = { id: 'job-1', status }
  const options = jobDataOptions('', job)
  if (data !== undefined)
    client.setQueryData(options.queryKey, JobDataSchema.parse(data))
  if (error)
    client
      .getQueryCache()
      .build(client, { queryKey: options.queryKey })
      .setState({
        status: 'error',
        error: new Error('Fixture failure'),
      })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        {collapsed ? (
          <JobDataViewer job={job} visible={visible} />
        ) : (
          <StoredJobData job={job} />
        )}
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('successful and failed jobs have a compact collapsed viewer without a data query', () => {
  const statuses: Job['status'][] = [
    'succeeded',
    'failed',
    'running',
    'queued',
    'cancelled',
  ]
  for (const status of statuses) {
    for (const visible of [false, true]) {
      const html = render({
        status,
        collapsed: true,
        visible,
      })
      assert.match(html, /<summary>Stored JSON<\/summary>/)
      assert.doesNotMatch(html, /Loading|Raw JSON|<pre|open=""/)
    }
  }
})

test('loading is distinct from missing retained data and does not offer scraping', () => {
  const html = render()
  assert.match(html, /role="status">Loading stored JSON/)
  assert.doesNotMatch(html, /No response JSON|Retry job|Queue|href=/)
})

test('historical failure without saved responses is not presented as empty search results', () => {
  const html = render({ data: empty })
  assert.match(html, /No response JSON was saved for this job/)
  assert.match(html, /Older failed responses cannot be recovered/)
  assert.doesNotMatch(html, /empty search results|No results/)
  assert.doesNotMatch(html, /Raw JSON|<pre|href=|<button/)
})

test('active jobs show a pending-response message without historical failure claims', () => {
  const statuses: Job['status'][] = ['queued', 'running']
  for (const status of statuses) {
    const html = render({ data: empty, status })
    assert.match(html, /No response saved yet/)
    assert.doesNotMatch(html, /Older failed|cannot be recovered/)
  }
  assert.doesNotMatch(
    render({ data: empty, status: 'failed' }),
    /No response saved yet/,
  )
})

test('retained snapshots and diagnostics reuse the bounded JSON tree for any outcome', () => {
  const statuses: Job['status'][] = ['succeeded', 'failed']
  for (const status of statuses) {
    const html = render({
      status,
      data: {
        ...empty,
        snapshots: [
          {
            id: 'snapshot',
            mediaItemId: null,
            provider: 'serply',
            createdAt: '2026-10-28',
            payload: { results: [] },
          },
        ],
        diagnostics: [{ id: 'log', createdAt: '2026-10-28', data: false }],
      },
    })
    assert.match(html, /Snapshots \(1\)/)
    assert.match(html, /Diagnostics \(1\)/)
    assert.match(html, /Raw JSON/)
    assert.match(html, /max-h-\[60vh\]/)
    assert.doesNotMatch(html, /No response JSON|<pre|href=/)
  }
})

test('a retained empty response is still data and legacy success fallback is labelled', () => {
  const html = render({
    data: {
      ...empty,
      itemPayloads: [
        { id: 'item', mediaItemId: null, provider: 'serply', payload: [] },
      ],
    },
  })
  assert.match(html, /Legacy item payloads \(1\)/)
  assert.match(html, /no linked snapshot/)
  assert.match(html, /Raw JSON/)
  assert.doesNotMatch(html, /No response JSON/)
})

test('diagnostics alone remain viewable without claiming a response snapshot exists', () => {
  const html = render({
    data: {
      ...empty,
      diagnostics: [
        {
          id: 'log',
          createdAt: '2026-10-28',
          data: { response: { results: [] } },
        },
      ],
    },
  })
  assert.match(html, /Snapshots \(0\)/)
  assert.match(html, /Diagnostics \(1\)/)
  assert.match(html, /Raw JSON/)
  assert.doesNotMatch(html, /No response JSON|cannot be recovered|<pre/)
})

test('read errors offer an explicit stored-data reload, not a scrape retry', () => {
  const html = render({ error: true })
  assert.match(html, /role="alert">Could not load stored JSON/)
  assert.match(html, /Reload stored data/)
  assert.doesNotMatch(html, /No response JSON|Retry job|href=/)
})
