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
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import JobsPageClient, { JobsTable } from './pages/jobs-page-client'
import { DetailInspectorProvider } from './detail-inspector-context'
import { detailEntries } from '@/utils/detail-inspector'

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

function render(search = 'mediaType=film', provider?: string, row = job) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  const params = new URLSearchParams(search)
  const items = !provider || provider === row.provider ? [row] : []
  client.setQueryData(
    [
      'jobs',
      'table',
      provider ? null : (params.get('mediaType') ?? 'film'),
      '[]',
      '',
      params.get('q') ?? '',
      JSON.stringify(
        provider
          ? [provider]
          : params.get('provider')
            ? [params.get('provider')]
            : [],
      ),
      params.get('sortBy') ?? 'createdAt',
      params.get('direction') === 'asc' ? 'asc' : 'desc',
      1,
    ],
    JobPageSchema.parse({
      page: 1,
      size: 25,
      totalCount: items.length,
      pageCount: 1,
      items,
    }),
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value="/jobs">
          <SearchParamsContext.Provider value={params}>
            <DetailInspectorProvider>
              {provider ? (
                <JobsTable provider={provider} />
              ) : (
                <JobsPageClient />
              )}
            </DetailInspectorProvider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

function firstJobHref(html: string) {
  const href = html.match(
    /aria-label="View example-provider job from [^"]*" href="([^"]+)"/,
  )?.[1]
  assert.ok(href)
  return new URL(
    href.replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
    'https://example.test',
  )
}

test('job monitor has shared sortable columns, selection and links to details', () => {
  const html = render()
  assert.match(html, /table-scroll jobs-scroll secondary-table-scroll/)
  assert.match(html, /<table class="ds-table" aria-label="Jobs"/)
  for (const label of ['Provider', 'Job', 'Status', 'Created'])
    assert.match(html, new RegExp(`title="Sort by ${label}"`))
  assert.match(html, /aria-label="Select example-provider job/)
  assert.match(html, /aria-label="View example-provider job from/)
  assert.match(html, /aria-sort="descending"/)
  assert.doesNotMatch(
    html,
    /title="Sort by Finished"|job-content|Stored JSON|Expand example-provider/,
  )
  const href = firstJobHref(html)
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'job', id: job.id },
  ])
})

test('Artist jobs use their scoped cache and open details without changing library', () => {
  const artistJob = JobSchema.parse({
    ...job,
    scope: { mediaType: 'album' },
    options: {
      task: ARTIST_ENRICHMENT_TASK,
      artistId: 'fixture-artist',
      artistName: 'Fixture artist',
    },
  })
  const html = render('mediaType=artist', undefined, artistJob)
  assert.match(html, /<h1>Artist jobs<\/h1>/)
  assert.match(html, /Artist enrichment · Fixture artist/)
  assert.match(html, /aria-label="Filter Job status"/)
  assert.match(html, /aria-label="Filter Job provider"/)
  const href = firstJobHref(html)
  assert.equal(href.searchParams.get('mediaType'), 'artist')
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'job', id: artistJob.id },
  ])
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

test('job sort state follows the URL and legacy selected jobs do not expand the table', () => {
  const html = render(
    'mediaType=film&sortBy=status&direction=asc&jobId=example-job',
  )
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]+title="Sort by Status"/,
  )
  assert.doesNotMatch(
    html,
    /Collapse example-provider|job-details-example-job|Stored JSON|Example failure/,
  )
  const href = firstJobHref(html)
  assert.equal(href.searchParams.get('sortBy'), 'status')
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'job', id: job.id },
  ])
})

test('provider jobs reuse the full table across libraries and pin the provider', () => {
  const html = render(
    'mediaType=album&provider=example-provider&providers=["other-provider"]&jobId=example-job&batchId=unrelated-batch',
    'example-provider',
  )
  assert.match(html, />1 jobs</)
  assert.match(html, /aria-label="Filter Job status"/)
  assert.match(html, /aria-label="View example-provider job from/)
  assert.match(html, /secondary-table-footer/)
  assert.doesNotMatch(
    html,
    /Album jobs|Film jobs|Filter Job provider|Review batch retry|another library|Stored JSON/,
  )
})

test('provider tables never pin a job from another provider', () => {
  const html = render(
    'mediaType=film&provider=another-provider&jobId=example-job',
    'another-provider',
  )
  assert.match(html, /No matching jobs/)
  assert.doesNotMatch(
    html,
    /View example-provider job|Selected job|another provider/,
  )
})

test('job links retain workspace filters and append to the inspector history', () => {
  const params = new URLSearchParams({
    mediaType: 'film',
    provider: 'example-provider',
    q: 'example',
    sortBy: 'status',
    direction: 'asc',
    inspect: JSON.stringify([
      { kind: 'film', id: 'example-film', view: 'tab=sources' },
    ]),
  })
  const html = render(params.toString())
  const href = firstJobHref(html)
  assert.equal(href.searchParams.get('q'), 'example')
  assert.equal(href.searchParams.get('provider'), 'example-provider')
  assert.equal(href.searchParams.get('sortBy'), 'status')
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'film', id: 'example-film', view: 'tab=sources' },
    { kind: 'job', id: job.id },
  ])
})
