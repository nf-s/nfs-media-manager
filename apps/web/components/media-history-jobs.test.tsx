import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { JobPageSchema, type JobPage } from '@repo/schemas/job'
import MediaHistoryJobs from './media-history-jobs'
import {
  DetailInspectorProvider,
  InspectorEntryContext,
  useDetailInspector,
} from './detail-inspector-context'
import { detailEntries } from '@/utils/detail-inspector'

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

function InspectorHistory({ artist }: { artist: boolean }) {
  const inspector = useDetailInspector()
  return (
    <InspectorEntryContext.Provider value={inspector}>
      {artist ? (
        <MediaHistoryJobs artistId="artist-1" provider="Example" />
      ) : (
        <MediaHistoryJobs mediaItemId="film-1" />
      )}
    </InspectorEntryContext.Provider>
  )
}

function renderHistory(
  pages?: JobPage[],
  view = 'tab=sources',
  artist = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const params = new URLSearchParams(view)
  const statuses = JSON.parse(params.get('jobsStatuses') ?? '[]')
  for (const page of pages ?? [])
    client.setQueryData(
      [
        'jobs',
        'media-history',
        'table',
        artist ? undefined : 'film-1',
        artist ? 'artist-1' : undefined,
        artist ? '["Example"]' : '[]',
        params.get('jobsSortBy') ?? 'createdAt',
        params.get('jobsDirection') ?? 'desc',
        params.get('jobsQ') ?? '',
        JSON.stringify(statuses),
        page.page,
      ],
      page,
    )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value={artist ? '/artists' : '/films'}>
          <SearchParamsContext.Provider
            value={
              new URLSearchParams({
                inspect: JSON.stringify([
                  {
                    kind: artist ? 'artist' : 'film',
                    id: artist ? 'artist-1' : 'film-1',
                    view,
                  },
                ]),
              })
            }
          >
            <DetailInspectorProvider>
              <InspectorHistory artist={artist} />
            </DetailInspectorProvider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

function jobHref(html: string) {
  const href = html.match(
    /aria-label="View [^"]* job from [^"]*" href="([^"]+)"/,
  )?.[1]
  assert.ok(href)
  return new URL(
    href.replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
    'https://example.test',
  )
}

test('job history uses the shared table loading row inside a bounded scroll region', () => {
  const html = renderHistory()
  assert.match(
    html,
    /class="ds-table-wrap table-scroll table-scroll-bounded secondary-table-scroll"/,
  )
  assert.match(
    html,
    /data-inspector-scroll="true" role="region" aria-label="Job history" aria-busy="true"/,
  )
  assert.match(
    html,
    /colSpan="6" class="table-state"><div role="status">Loading jobs/,
  )
  assert.doesNotMatch(html, /Previous|>Next</)
})

test('job history reserves room for unloaded pages and opens jobs above its parent details', () => {
  const html = renderHistory([
    page(1, 75, 'First provider'),
    page(2, 75, 'Second provider'),
  ])
  assert.match(html, /75 jobs/)
  assert.match(html, /virtual-browse-placeholder/)
  assert.match(html, /style="height:\d+px;padding:0;border:0"/)
  assert.doesNotMatch(html, /Second provider|Load more jobs|Previous|>Next</)
  const href = jobHref(html)
  assert.equal(href.pathname, '/films')
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'film', id: 'film-1', view: 'tab=sources' },
    { kind: 'job', id: 'job-1' },
  ])
})

test('completed history renders rows without paging controls', () => {
  const html = renderHistory([page(1, 1, 'Example')])
  assert.match(html, /1 jobs/)
  assert.match(html, />Example<\/div>/)
  assert.doesNotMatch(
    html,
    /virtual-browse-placeholder|Load more jobs|Previous|>Next</,
  )
})

test('retired Google jobs retain a readable label without changing the provider ID', () => {
  const googlePage = page(1, 1, 'google-custom-search')
  const original = structuredClone(googlePage)
  const html = renderHistory([googlePage])
  assert.match(html, />Google Custom Search \(legacy\)<\/div>/)
  assert.match(
    html,
    /aria-label="View Google Custom Search \(legacy\) job from /,
  )
  assert.deepEqual(googlePage, original)
})

test('offscreen cached history pages do not append duplicate rows', () => {
  const first = page(1, 50, 'First result')
  const second = page(2, 50, 'Second result')
  const repeated = first.items[0]
  assert.ok(repeated)
  second.items.unshift({ ...repeated, provider: 'Stale repeated result' })
  const html = renderHistory([first, second])
  assert.equal(
    (html.match(/aria-label="View First result job from/g) ?? []).length,
    1,
  )
  assert.doesNotMatch(html, /Stale repeated result/)
})

test('empty history retains shared headers and common empty row', () => {
  const html = renderHistory([
    JobPageSchema.parse({
      page: 1,
      size: 25,
      totalCount: 0,
      pageCount: 0,
      items: [],
    }),
  ])
  assert.match(
    html,
    /<th scope="col" aria-sort="none"><div[^>]*><button[^>]*title="Sort by Provider">Provider/,
  )
  assert.match(
    html,
    /colSpan="6" class="table-state"><div role="status">No jobs yet/,
  )
})

test('history shares the monitor columns, filters and selection footer', () => {
  const html = renderHistory([page(1, 1, 'Example')])
  assert.match(html, /aria-label="Visible columns"/)
  for (const name of ['Provider', 'Job', 'Status', 'Created'])
    assert.ok(html.includes(`title="Sort by ${name}"`))
  for (const name of ['Started', 'Finished', 'Result'])
    assert.ok(html.includes(`type="checkbox"/>${name}`))
  const search = html.indexOf('aria-label="Search job history"')
  const status = html.indexOf('aria-label="Filter Job status"')
  const count = html.indexOf('1 jobs')
  const columns = html.indexOf('class="table-column-controls"')
  assert.ok(
    search > -1 && search < count && count < columns && columns < status,
  )
  assert.match(html, /Select all loaded eligible jobs/)
  assert.ok(html.indexOf('secondary-table-footer') > html.indexOf('</table>'))
})

test('artist history keeps its provider scope and table view in inspector history', () => {
  const view =
    'tab=sources&jobsQ=example&jobsSortBy=status&jobsDirection=asc&jobsStatuses=%5B%22succeeded%22%5D'
  const html = renderHistory([page(1, 1, 'Example')], view, true)
  assert.match(html, /1 jobs/)
  assert.match(html, /aria-label="Search job history"[^>]*value="example"/)
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]+title="Sort by Status"/,
  )
  assert.doesNotMatch(html, /Filter Job provider/)
  const href = jobHref(html)
  assert.deepEqual(detailEntries(href.pathname, href.searchParams), [
    { kind: 'artist', id: 'artist-1', view },
    { kind: 'job', id: 'job-1' },
  ])
})
