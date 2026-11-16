import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { JobSchema, type Job } from '@repo/schemas/job'
import { detailEntries, type DetailEntry } from '@/utils/detail-inspector'
import { JobDetail } from './job-detail'
import {
  DetailInspectorProvider,
  InspectorEntryContext,
} from './detail-inspector-context'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in job detail rendering tests')
})
const timestamp = '2026-01-02T00:00:00Z'
const fixture = JobSchema.parse({
  id: 'job-1',
  provider: 'example-provider',
  status: 'failed',
  createdAt: timestamp,
  startedAt: timestamp,
  finishedAt: timestamp,
  errorMessage: 'Synthetic failure',
  scope: { mediaType: 'film' },
  options: {},
  confirmBroadRun: false,
  items: [
    {
      id: 'item-1',
      mediaItemId: 'film-1',
      mediaTitle: 'Synthetic film',
      mediaType: 'film',
      provider: 'example-provider',
      status: 'failed',
      attemptCount: 2,
      message: 'Synthetic failure',
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
    },
  ],
  logs: [
    {
      id: 'log-1',
      createdAt: timestamp,
      level: 'error',
      message: 'Synthetic log message',
      metadata: null,
      canMarkBenign: true,
    },
  ],
})

function render({
  job = fixture,
  tab = '',
  error = false,
  nested = false,
}: {
  job?: Job | null
  tab?: string
  error?: boolean
  nested?: boolean
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  })
  const key = ['jobs', 'detail', fixture.id]
  if (job) client.setQueryData(key, job)
  if (error)
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({
        status: 'error',
        error: new Error('Synthetic read failure'),
      })
  const parent: DetailEntry = {
    kind: 'film',
    id: 'film-1',
    view: 'tab=sources',
  }
  const active: DetailEntry = {
    kind: 'job',
    id: fixture.id,
    ...(tab ? { view: `tab=${tab}` } : {}),
  }
  const params = nested
    ? new URLSearchParams({
        q: 'Fixture',
        inspect: JSON.stringify([parent, active]),
      })
    : new URLSearchParams(tab ? { tab } : {})
  const content = nested ? (
    <DetailInspectorProvider>
      <InspectorEntryContext.Provider value={{ active, replaceView: () => {} }}>
        <JobDetail id={fixture.id} />
      </InspectorEntryContext.Provider>
    </DetailInspectorProvider>
  ) : (
    <JobDetail id={fixture.id} />
  )
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider
          value={nested ? '/films' : `/jobs/${fixture.id}`}
        >
          <SearchParamsContext.Provider value={params}>
            {content}
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
    return {
      html,
      dataQueries: client
        .getQueryCache()
        .findAll({ queryKey: ['jobs', 'data'] }).length,
    }
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('job overview exposes status, timings, item and actions without mounting stored data or logs', () => {
  const { html, dataQueries } = render()
  for (const text of [
    'Synthetic film',
    'Synthetic failure',
    'Created',
    'Started',
    'Finished',
    '2 attempts',
    'Retry',
    'Dismiss',
  ])
    assert.ok(html.includes(text), `Expected ${text}`)
  assert.match(html, /href="\/films\/film-1"/)
  assert.match(html, /aria-label="Job details"/)
  assert.doesNotMatch(
    html,
    /Synthetic log message|Loading stored JSON|<summary>Stored JSON/,
  )
  assert.equal(dataQueries, 0)
})

test('Stored JSON tab mounts only the saved-data reader and Logs exposes existing error review', () => {
  const data = render({ tab: 'data' })
  assert.match(data.html, /Loading stored JSON/)
  assert.equal(data.dataQueries, 1)
  assert.doesNotMatch(data.html, /Synthetic log message/)
  const logs = render({ tab: 'logs' })
  assert.match(logs.html, /Synthetic log message/)
  assert.match(logs.html, /Mark benign/)
  assert.doesNotMatch(logs.html, /Loading stored JSON/)
  assert.equal(logs.dataQueries, 0)
})

test('retry and item links extend a copied inspector stack while retaining parent tabs', () => {
  const { html } = render({
    job: { ...fixture, options: { retryJobId: 'retry-1' } },
    nested: true,
  })
  const links = [
    ...html.matchAll(/href="([^"]+)"[^>]*>(View retry|Synthetic film)<\/a>/g),
  ]
  assert.equal(links.length, 2)
  for (const [, href, label] of links) {
    assert.ok(href)
    const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
    assert.equal(url.pathname, '/films')
    assert.equal(url.searchParams.get('q'), 'Fixture')
    assert.deepEqual(detailEntries(url.pathname, url.searchParams), [
      { kind: 'film', id: 'film-1', view: 'tab=sources' },
      { kind: 'job', id: fixture.id },
      label === 'View retry'
        ? { kind: 'job', id: 'retry-1' }
        : { kind: 'film', id: 'film-1' },
    ])
  }
})

test('task jobs, empty logs, dismissed jobs and unknown tabs have explicit states', () => {
  const task = {
    ...fixture,
    items: [],
    logs: [],
    options: { task: 'lastfm-scrobble-sync' },
  }
  assert.match(render({ job: task }).html, /Scrobble sync/)
  assert.match(
    render({ job: task, tab: 'logs' }).html,
    /No log entries recorded/,
  )
  assert.match(render({ tab: 'invalid' }).html, /Synthetic failure/)
  assert.match(
    render({
      job: {
        ...fixture,
        options: { dismissal: { dismissedAt: timestamp, userId: null } },
      },
    }).html,
    /Errors retained/,
  )
})

test('loading and read errors are distinct, and a refresh error preserves cached details', () => {
  assert.match(render({ job: null }).html, /Loading job/)
  const failed = render({ job: null, error: true }).html
  assert.match(failed, /Could not load this job/)
  assert.match(failed, /Retry/)
  assert.doesNotMatch(failed, /Synthetic film/)
  const stale = render({ error: true }).html
  assert.match(stale, /Could not refresh this job/)
  assert.match(stale, /Synthetic film/)
})

test('overview leads with the summary headline, code, retry time and its actions in order', () => {
  const { html } = render({
    job: {
      ...fixture,
      summary: {
        headline: 'No matching item at the provider',
        code: 'request-failed',
        retryAt: '2099-01-02T14:20:00.000Z',
        actions: ['find-match', 'retry', 'open-provider'],
      },
    },
  })
  assert.match(html, /<h2 class="ds-detail-title">Synthetic film<\/h2>/)
  assert.match(html, /class="ops-headline">No matching item at the provider</)
  assert.match(html, /Code request-failed/)
  assert.match(html, /Can retry after 2099-01-0[23] /)
  const find = html.indexOf('>Find match<')
  const retry = html.indexOf('>Retry</button>')
  const provider = html.indexOf('>Open provider<')
  assert.ok(find > -1 && find < retry && retry < provider)
  assert.match(html, /data-variant="primary"[^>]*href="[^"]*"[^>]*>Find match</)
  const findHref = /href="([^"]*)"[^>]*>Find match</.exec(html)?.[1] ?? ''
  const findUrl = new URL(findHref.replaceAll('&amp;', '&'), 'http://localhost')
  assert.equal(findUrl.pathname, '/films/film-1')
  assert.deepEqual(Object.fromEntries(findUrl.searchParams), {
    tab: 'sources',
    sourceProvider: 'example-provider',
    sourceMode: 'match',
  })
  assert.match(html, /href="\/providers\/example-provider">Open provider</)
  assert.match(html, /Request and response/)
  assert.match(html, /aria-label="Job items"/)
})

test('a waiting job says why and when it resumes', () => {
  const { html } = render({
    job: {
      ...fixture,
      status: 'queued',
      errorMessage: null,
      waiting: {
        reason: 'cooldown',
        until: '2099-01-02T14:20:00.000Z',
        detail: 'Cooling down: provider rate limit',
      },
    },
  })
  assert.match(html, /data-status="waiting"[^>]*>Waiting until 2099-01-0[23] /)
  assert.match(
    html,
    /data-tone="attention"[\s\S]*Cooling down: provider rate limit/,
  )
})
