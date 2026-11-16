import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  JobEntryPageSchema,
  JobPageSchema,
  JobSchema,
  type JobEntry,
} from '@repo/schemas/job'
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

const batch: JobEntry = {
  kind: 'batch',
  batchId: 'batch-1',
  provider: 'example-provider',
  providers: ['example-provider'],
  mediaType: 'album',
  label: null,
  importId: null,
  total: 240,
  matching: 240,
  queued: 142,
  running: 0,
  succeeded: 96,
  failed: 2,
  cancelled: 0,
  createdAt: '2026-01-02T00:00:00.000Z',
  startedAt: '2026-01-02T00:02:00.000Z',
  finishedAt: null,
  waiting: {
    reason: 'cooldown',
    until: '2099-01-02T14:20:00.000Z',
    detail: 'Cooling down: Provider rate limit reached (HTTP 429)',
  },
}

function key(params: URLSearchParams, provider?: string) {
  const providers = provider
    ? [provider]
    : params.get('provider')
      ? [params.get('provider')]
      : []
  const batchId = provider ? '' : (params.get('batchId') ?? '')
  return [
    'jobs',
    batchId ? 'table' : 'entries',
    provider
      ? null
      : (['album', 'film', 'artist', 'subscription'].find(
          (value) => value === params.get('mediaType'),
        ) ?? null),
    '[]',
    batchId,
    params.get('q') ?? '',
    JSON.stringify(providers),
    params.get('sortBy') ?? 'createdAt',
    params.get('direction') === 'asc' ? 'asc' : 'desc',
    1,
  ]
}

function render(
  search = 'mediaType=film',
  provider?: string,
  entries: JobEntry[] = [{ kind: 'job', job }],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  const params = new URLSearchParams(search)
  const items = entries.filter(
    (entry) =>
      !provider ||
      (entry.kind === 'job' ? entry.job.provider : entry.provider) === provider,
  )
  if (params.get('batchId') && !provider)
    client.setQueryData(
      key(params),
      JobPageSchema.parse({
        page: 1,
        size: 25,
        totalCount: 1,
        pageCount: 1,
        items: [job],
      }),
    )
  else
    client.setQueryData(
      key(params, provider),
      JobEntryPageSchema.parse({
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

test('job monitor is the one table: pinned job column, sortable headers, selection and links to details', () => {
  const html = render()
  assert.match(html, /<table class="ds-table ops-jobs-table" aria-label="Jobs"/)
  for (const label of ['Job', 'Status', 'Provider', 'Created', 'Result'])
    assert.match(html, new RegExp(`title="Sort by ${label}"`))
  assert.ok(html.indexOf('Sort by Job') < html.indexOf('Sort by Status'))
  assert.match(html, /data-sticky="edge"/)
  assert.match(html, /aria-label="Select example-provider job/)
  assert.match(
    html,
    /class="ds-cell-title"[^>]*aria-label="View example-provider job from 2026-01-0[12] /,
  )
  assert.match(html, /data-status="failed">Failed</)
  assert.match(html, /class="ops-danger"[^>]*>Example failure</)
  assert.match(html, /href="\/providers\/example-provider"/)
  assert.match(html, /aria-sort="descending"/)
  assert.doesNotMatch(html, />View<|job-status|underline/)
  const href = firstJobHref(html)
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'job', id: job.id },
  ])
})

test('the library is a filter on one Jobs page, opened by old scoped links', () => {
  const artistJob = JobSchema.parse({
    ...job,
    scope: { mediaType: 'album' },
    options: {
      task: ARTIST_ENRICHMENT_TASK,
      artistId: 'fixture-artist',
      artistName: 'Fixture artist',
    },
  })
  const html = render('mediaType=artist', undefined, [
    { kind: 'job', job: artistJob },
  ])
  assert.doesNotMatch(html, /Artist jobs/)
  assert.match(html, /<select class="ds-select" aria-label="Library">/)
  assert.match(html, /<option value="artist" selected="">Artists<\/option>/)
  assert.match(html, /Artist enrichment · Fixture artist/)
  assert.match(html, /aria-label="Filter Job status"/)
  assert.match(html, /aria-label="Filter Job provider"/)
  const all = render('')
  assert.match(all, /<option value="" selected="">All libraries<\/option>/)
})

test('the health strip counts queued, running, waiting and attention and links to filters', () => {
  const html = render('mediaType=film')
  assert.match(html, /class="ds-stats"/)
  for (const label of ['queued', 'running', 'waiting', 'need attention'])
    assert.match(html, new RegExp(`class="ds-stat-label">${label}<`))
})

test('batches are one row with progress and the provider wait, and expand to their jobs', () => {
  const html = render('', undefined, [batch, { kind: 'job', job }])
  assert.match(html, /<tr data-group="">/)
  assert.match(
    html,
    /aria-expanded="false" aria-label="Show jobs in Batch · 240 albums"/,
  )
  assert.match(html, /href="\/jobs\?batchId=batch-1"/)
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="98"/)
  assert.match(
    html,
    /data-status="waiting" title="Cooling down: Provider rate limit reached \(HTTP 429\)">Until 2099-01-0[23] [0-9:]+</,
  )
  assert.match(html, /Resumes 2099-01-0[23] [0-9:]+ · 2 failed/)
  assert.match(html, />2 jobs and batches</)
})

test('a batch with unfinished jobs has a checkbox and Cancel; a finished batch keeps Retry', () => {
  const html = render('', undefined, [batch])
  const row = html.match(/<tr data-group="">.*?<\/tr>/)?.[0] ?? ''
  assert.match(
    row,
    /type="checkbox" class="ds-check" aria-label="Select batch Batch · 240 albums"/,
  )
  assert.match(row, />Cancel<\/button>/)
  assert.doesNotMatch(row, />Retry<\/button>/)
  assert.match(html, /class="ds-selectbar"/)
  const finished = render('', undefined, [
    { ...batch, queued: 0, running: 0, succeeded: 238, waiting: null },
  ])
  const finishedRow = finished.match(/<tr data-group="">.*?<\/tr>/)?.[0] ?? ''
  assert.doesNotMatch(finishedRow, /type="checkbox"|>Cancel<\/button>/)
  assert.match(finishedRow, />Retry<\/button>/)
})

test('queued jobs show why they wait', () => {
  const queued = JobSchema.parse({
    ...job,
    status: 'queued',
    errorMessage: null,
    waiting: {
      reason: 'budget',
      until: null,
      detail: 'Daily request budget used',
    },
  })
  const html = render('', undefined, [{ kind: 'job', job: queued }])
  assert.match(
    html,
    /data-status="waiting" title="Daily request budget used">Waiting</,
  )
  assert.match(
    html,
    /title="Daily request budget used">Daily request budget used</,
  )
  assert.match(html, />Cancel<\/button>/)
})

test('job filters retain a deep-linked provider in the header and actions follow the table', () => {
  const html = render('mediaType=film&provider=unavailable-provider')
  assert.match(html, /unavailable-provider/)
  assert.match(html, /type="checkbox" checked=""/)
  const search = html.indexOf('aria-label="Search jobs"')
  const status = html.indexOf('aria-label="Filter Job status"')
  const provider = html.indexOf('aria-label="Filter Job provider"')
  const count = html.indexOf('>1 job or batch<')
  const columns = html.indexOf('table-columns-trigger')
  const actions = html.indexOf('ds-selectbar')
  assert.ok(search < count && count < columns)
  assert.ok(columns < status && status < provider && provider < actions)
  assert.ok(html.indexOf('</table>') < actions)
})

test('a batch link lists its jobs with the batch retry review', () => {
  const html = render('batchId=batch-1')
  assert.match(html, /Import \/ refresh jobs/)
  assert.match(html, />Review batch retry</)
  assert.match(html, />1 job</)
})

test('job sort state follows the URL and legacy selected jobs do not expand the table', () => {
  const html = render(
    'mediaType=film&sortBy=status&direction=asc&jobId=example-job',
  )
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]+title="Sort by Status"/,
  )
  assert.doesNotMatch(html, /Collapse example-provider|Request and response/)
  const href = firstJobHref(html)
  assert.equal(href.searchParams.get('sortBy'), 'status')
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'job', id: job.id },
  ])
})

test('provider jobs reuse the full table and pin the provider', () => {
  const html = render(
    'mediaType=album&provider=example-provider&providers=["other-provider"]&jobId=example-job&batchId=unrelated-batch',
    'example-provider',
  )
  assert.match(html, /<section class="ops-jobs">/)
  assert.match(html, />1 job or batch</)
  assert.match(html, /aria-label="Filter Job status"/)
  assert.match(html, /aria-label="View example-provider job from/)
  assert.match(html, /ds-selectbar/)
  assert.doesNotMatch(
    html,
    /aria-label="Library"|Filter Job provider|Review batch retry|ds-stats/,
  )
})

test('provider tables never pin a job from another provider', () => {
  const html = render(
    'mediaType=film&provider=another-provider&jobId=example-job',
    'another-provider',
  )
  assert.match(html, /No matching jobs/)
  assert.doesNotMatch(html, /View example-provider job|Selected job/)
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
