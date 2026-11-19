import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobDataSchema, type Job } from '@repo/schemas/job'
import { jobDataOptions } from '@/utils/job-data'
import { StoredJobData } from './job-data-viewer'
import { JobProviderResponseBody } from './job-provider-responses'

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
  error = false,
  responses,
}: {
  status?: Job['status']
  data?: unknown
  error?: boolean
  responses?: unknown[]
} = {}) {
  const client = new QueryClient()
  const job = { id: 'job-1', status }
  if (responses !== undefined)
    client.setQueryData(['jobs', 'provider-responses', job.id, job.status, 1], {
      page: 1,
      size: 24,
      totalCount: responses.length,
      pageCount: responses.length ? 1 : 0,
      items: responses,
    })
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
        <StoredJobData job={job} />
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('loading is distinct from missing retained data and does not offer scraping', () => {
  const html = render()
  assert.match(html, /role="status">Loading stored JSON/)
  assert.doesNotMatch(html, /No response JSON|Retry job|Queue|href=/)
})

test('historical failure without saved responses is not presented as empty search results', () => {
  const html = render({ data: empty, responses: [] })
  assert.match(html, /No original provider response was archived for this job/)
  assert.match(html, /No snapshots or diagnostics saved/)
  assert.doesNotMatch(html, /empty search results|No results/)
  assert.doesNotMatch(html, /Raw JSON|<pre|href=|<button/)
})

test('active jobs show a pending-response message without historical failure claims', () => {
  const statuses: Job['status'][] = ['queued', 'running']
  for (const status of statuses) {
    const html = render({ data: empty, status, responses: [] })
    assert.match(html, /No provider response captured yet/)
    assert.doesNotMatch(html, /Older failed|cannot be recovered/)
  }
  assert.doesNotMatch(
    render({ data: empty, status: 'failed' }),
    /No provider response captured yet/,
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
    // Each saved payload is collapsed, with Copy, until it is opened.
    assert.match(html, /serply · 2026-10-28[^<]*<\/span><button[^>]*>Copy</)
    assert.equal(
      (html.match(/class="ops-disclosure ops-payload"/g) ?? []).length,
      2,
    )
    assert.doesNotMatch(html, /No response JSON|<pre|href=|results/)
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
  assert.match(html, />Copy</)
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
  assert.match(html, />Copy</)
  assert.doesNotMatch(html, /No response JSON|cannot be recovered|<pre/)
})

test('read errors offer an explicit stored-data reload, not a scrape retry', () => {
  const html = render({ error: true })
  assert.match(html, /role="alert">[\s\S]*Could not load stored JSON/)
  assert.match(html, /Reload stored data/)
  assert.doesNotMatch(html, /No response JSON|Retry job|href=/)
})

test('lists a native response independently of snapshots and loads its body only after selection', () => {
  const html = render({
    data: empty,
    responses: [
      {
        id: 'response-1',
        jobId: 'job-1',
        jobItemId: 'item-1',
        artistId: null,
        provider: 'fixture',
        attempt: 1,
        ordinal: 2,
        phase: 'media',
        method: 'GET',
        requestUrl: null,
        status: 200,
        retry: null,
        receivedAt: null,
        notFound: false,
        contentType: 'application/json',
        bodyState: 'captured',
        retainedBytes: 11,
      },
    ],
  })
  assert.match(html, /Attempt 1 · Request 2 · Media/)
  assert.match(html, /HTTP 200/)
  assert.doesNotMatch(html, /No original provider response|Copy response|<pre/)
})

test('renders saved text literally, diagnoses unavailable bodies, and identifies worker archives', () => {
  const renderBody = (
    body: Parameters<typeof JobProviderResponseBody>[0]['body'],
  ) => renderToStaticMarkup(<JobProviderResponseBody body={body} />)
  const html = renderBody({
    state: 'captured',
    text: '{"extra":"<script>"}',
    redacted: true,
  })
  assert.match(html, /extra.*&lt;script&gt;/)
  assert.match(html, /Private fields removed/)
  assert.match(
    renderBody({
      state: 'captured',
      text: 'fixture',
      redacted: true,
      retainedRepresentation: 'station-discovery',
    }),
    /Saved public discovery references/,
  )
  assert.match(
    renderBody({
      state: 'captured',
      text: 'fixture',
      redacted: true,
      retainedRepresentation: 'station-episode-data',
    }),
    /Saved episode data rows/,
  )
  assert.doesNotMatch(html, /<script>/)
  assert.match(
    renderBody({ state: 'unavailable', reason: 'byte-limit' }),
    /exceeded the capture limit/,
  )
  assert.match(
    renderBody({
      state: 'local',
      reference: 'archive-fixture',
      retainedBytes: 42,
    }),
    /Paired local worker.*archive-fixture/,
  )
})
