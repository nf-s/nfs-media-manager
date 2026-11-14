import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { JobPageSchema, JobSchema } from '@repo/schemas/job'
import JobsPageClient from './pages/jobs-page-client'

const job = JobSchema.parse({
  id: 'example-job',
  provider: 'example-provider',
  status: 'failed',
  createdAt: '2026-01-02T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  errorMessage: 'Example failure',
  scope: { mediaType: 'film' },
  options: {},
  confirmBroadRun: false,
  items: [],
  logs: [],
})

function render(search = 'mediaType=film') {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  const params = new URLSearchParams(search)
  client.setQueryData(
    [
      'jobs',
      'infinite',
      'film',
      '',
      '',
      '',
      params.get('sortBy') ?? 'createdAt',
      params.get('direction') === 'asc' ? 'asc' : 'desc',
    ],
    {
      pages: [
        JobPageSchema.parse({
          page: 1,
          size: 25,
          totalCount: 1,
          pageCount: 1,
          items: [job],
        }),
      ],
      pageParams: [1],
    },
  )
  client.setQueryData(['jobs', 'detail', job.id], job)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value="/jobs">
          <SearchParamsContext.Provider value={params}>
            <JobsPageClient />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('job monitor has shared sortable columns, selection and explicit detail controls', () => {
  const html = render()
  assert.match(html, /table-scroll jobs-scroll secondary-table-scroll/)
  assert.match(html, /<table class="compact-table" aria-label="Jobs"/)
  for (const label of ['Provider', 'Job', 'Status', 'Created'])
    assert.match(html, new RegExp(`title="Sort by ${label}"`))
  assert.match(html, /aria-label="Select example-provider job/)
  assert.match(
    html,
    /aria-label="Expand example-provider job" aria-expanded="false"/,
  )
  assert.match(html, /aria-sort="descending"/)
  assert.doesNotMatch(html, /title="Sort by Finished"|job-content/)
})

test('job sort state follows the URL and deep-linked details span the visible columns', () => {
  const html = render(
    'mediaType=film&sortBy=status&direction=asc&jobId=example-job',
  )
  assert.match(html, /aria-sort="ascending"><button[^>]+title="Sort by Status"/)
  assert.match(
    html,
    /aria-label="Collapse example-provider job" aria-expanded="true"/,
  )
  assert.match(html, /id="job-details-example-job"><td colSpan="6"/)
  assert.match(html, /Example failure/)
  assert.match(html, /Stored JSON/)
})
