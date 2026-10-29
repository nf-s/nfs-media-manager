import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JobPageSchema, type JobPage } from '@repo/schemas/job'
import MediaHistoryJobs from './media-history-jobs'

function page(number: number, count: number, provider: string): JobPage {
  return JobPageSchema.parse({
    page: number,
    size: 25,
    totalCount: count,
    pageCount: Math.ceil(count / 25),
    items: [
      {
        id: `job-${number}`,
        provider,
        status: 'succeeded',
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        scope: {},
        options: {},
        confirmBroadRun: false,
        items: [],
        logs: [],
      },
    ],
  })
}

function renderHistory(pages?: JobPage[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (pages)
    client.setQueryData(['jobs', 'media-history', 'infinite', 'film-1'], {
      pages,
      pageParams: pages.map((entry) => entry.page),
    })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MediaHistoryJobs mediaItemId="film-1" />
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('job history starts with an accessible loading row inside a bounded scroll region', () => {
  const html = renderHistory()
  assert.match(html, /class="table-scroll table-scroll-bounded"/)
  assert.match(html, /role="region" aria-label="Job history" aria-busy="true"/)
  assert.match(
    html,
    /colSpan="4" class="table-state"><div role="status">Loading jobs/,
  )
  assert.doesNotMatch(html, /Previous|>Next</)
})

test('job history appends loaded pages instead of replacing the current page', () => {
  const html = renderHistory([
    page(1, 75, 'First provider'),
    page(2, 75, 'Second provider'),
  ])
  assert.match(html, /Jobs \(75\)/)
  assert.match(html, /href="\/jobs\?jobId=job-1"/)
  assert.match(html, /href="\/jobs\?jobId=job-2"/)
  assert.match(html, /First provider/)
  assert.match(html, /Second provider/)
  assert.match(html, /Load more jobs/)
  assert.doesNotMatch(html, /Previous|>Next<|All .* jobs loaded/)
})

test('completed history has an explicit end state and no paging controls', () => {
  const html = renderHistory([page(1, 1, 'Example')])
  assert.match(html, /All 1 jobs loaded/)
  assert.doesNotMatch(html, /Load more jobs|Previous|>Next</)
})

test('retired Google jobs show a readable legacy label without changing their provider ID', () => {
  const googlePage = page(1, 1, 'google-custom-search')
  const original = structuredClone(googlePage)
  const html = renderHistory([googlePage])
  assert.match(html, />Google Custom Search \(legacy\)<\/a>/)
  assert.match(
    html,
    /aria-label="View Google Custom Search \(legacy\) job from /,
  )
  assert.deepEqual(googlePage, original)
})

test('overlapping live-history pages keep each job once and preserve the first result', () => {
  const first = page(1, 50, 'First result')
  const second = page(2, 50, 'Second result')
  const repeated = first.items[0]
  assert.ok(repeated)
  second.items.unshift({ ...repeated, provider: 'Stale repeated result' })
  const html = renderHistory([first, second])
  assert.equal((html.match(/href="\/jobs\?jobId=job-1"/g) ?? []).length, 1)
  assert.match(html, /First result/)
  assert.doesNotMatch(html, /Stale repeated result/)
})

test('empty history retains its header and uses the common empty row', () => {
  const html = renderHistory([
    JobPageSchema.parse({
      page: 1,
      size: 25,
      totalCount: 0,
      pageCount: 0,
      items: [],
    }),
  ])
  assert.match(html, /<th scope="col">Provider/)
  assert.match(
    html,
    /colSpan="4" class="table-state"><div role="status">No jobs yet/,
  )
  assert.doesNotMatch(html, /Load more jobs|Previous|>Next</)
})
