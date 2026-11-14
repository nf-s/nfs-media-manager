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
import JobsPageClient, { JobsTable } from './pages/jobs-page-client'

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

function render(search = 'mediaType=film', provider?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  const params = new URLSearchParams(search)
  const items = !provider || provider === job.provider ? [job] : []
  client.setQueryData(
    [
      'jobs',
      'infinite',
      provider ? null : 'film',
      '[]',
      '',
      '',
      JSON.stringify(
        provider
          ? [provider]
          : params.get('provider')
            ? [params.get('provider')]
            : [],
      ),
      params.get('sortBy') ?? 'createdAt',
      params.get('direction') === 'asc' ? 'asc' : 'desc',
    ],
    {
      pages: [
        JobPageSchema.parse({
          page: 1,
          size: 25,
          totalCount: items.length,
          pageCount: 1,
          items,
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
            {provider ? <JobsTable provider={provider} /> : <JobsPageClient />}
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

test('job filters retain a deep-linked provider in the header and actions follow the table', () => {
  const html = render('mediaType=film&provider=unavailable-provider')
  assert.match(html, /unavailable-provider/)
  assert.match(html, /type="checkbox" checked=""/)
  const search = html.indexOf('aria-label="Search jobs"')
  const status = html.indexOf('aria-label="Filter Job status"')
  const provider = html.indexOf('aria-label="Filter Job provider"')
  const count = html.indexOf('>1 jobs<')
  const columns = html.indexOf('table-columns-trigger')
  const actions = html.indexOf('secondary-table-footer')
  assert.ok(search < count && count < columns)
  assert.ok(columns < provider && provider < status && status < actions)
  assert.ok(html.indexOf('</table>') < actions)
  assert.doesNotMatch(html, /Select loaded|>Clear</)
})

test('job sort state follows the URL and deep-linked details span the visible columns', () => {
  const html = render(
    'mediaType=film&sortBy=status&direction=asc&jobId=example-job',
  )
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]+title="Sort by Status"/,
  )
  assert.match(
    html,
    /aria-label="Collapse example-provider job" aria-expanded="true"/,
  )
  assert.match(
    html,
    /id="job-details-example-job" class="secondary-table-detail-row"><td colSpan="6"/,
  )
  assert.match(html, /Example failure/)
  assert.match(html, /Stored JSON/)
})

test('provider jobs reuse the full table across libraries and pin the provider', () => {
  const html = render(
    'mediaType=album&provider=example-provider&providers=["other-provider"]&jobId=example-job&batchId=unrelated-batch',
    'example-provider',
  )
  assert.match(html, />1 jobs</)
  assert.match(html, /aria-label="Filter Job status"/)
  assert.match(html, /aria-label="Collapse example-provider job"/)
  assert.match(html, /Example failure/)
  assert.match(html, /Stored JSON/)
  assert.match(html, /secondary-table-footer/)
  assert.doesNotMatch(
    html,
    /Album jobs|Film jobs|Filter Job provider|Review batch retry|another library/,
  )
})

test('provider jobs do not include a deep-linked job from another provider', () => {
  const html = render(
    'mediaType=film&provider=another-provider&jobId=example-job',
    'another-provider',
  )
  assert.match(html, /This job belongs to another provider/)
  assert.doesNotMatch(html, /id="job-details-example-job"/)
})
