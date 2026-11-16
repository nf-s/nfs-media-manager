import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  ProviderLibraryCoverageSchema,
  ProviderLocalWorkerStatusSchema,
  ProviderOverviewSchema,
  ProviderRequestSeriesSchema,
  ProviderSummarySchema,
  type ProviderOverviewItem,
  type ProviderSummary,
} from '@repo/schemas/provider'
import ProviderPageClient from './pages/provider-page-client'
import { requestRanges } from './provider-activity'

const until = new Date(Date.now() + 40 * 60_000).toISOString()

const summary = ProviderSummarySchema.parse({
  id: 'fixture-ratings',
  displayName: 'Fixture Ratings',
  description: 'Album ratings',
  siteUrl: 'https://example.com/ratings',
  surface: 'provider',
  mediaTypes: ['album'],
  rateLimit: { maxConcurrent: 1, minTimeMs: 1500 },
  supportsScrape: true,
  supportsLocalWorker: true,
  supportsLegacyImport: false,
  secrets: [
    {
      key: 'apiKey',
      label: 'API key',
      required: true,
      configured: true,
      helpText: null,
      placeholder: null,
    },
  ],
  pluginPath: null,
  safety: {
    halted: false,
    cooldownUntil: until,
    consecutiveFailures: 0,
    requestsLastHour: 4,
    lastError: null,
  },
})

const waiting: ProviderOverviewItem['queue'] = {
  state: 'waiting',
  reason: 'cooldown',
  until,
  detail: 'Cooling down: Provider rate limit reached (HTTP 429)',
}

function overview(queue: ProviderOverviewItem['queue']) {
  return ProviderOverviewSchema.parse({
    generatedAt: new Date().toISOString(),
    requestsFrom: new Date(Date.now() - 86_400_000).toISOString(),
    providers: [
      {
        id: summary.id,
        name: summary.displayName,
        description: summary.description,
        group: 'metadata',
        roles: ['album', 'artist'],
        connection: { state: 'connected', method: 'key', detail: 'Key set' },
        queue,
        jobs: { queued: 38, running: 0, failed: 2, attention: 2 },
        lastSuccessAt: null,
        requests24h: Array.from({ length: 24 }, () => 0),
        budget: {
          used: 312,
          limit: 1000,
          period: 'day',
          resetsAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
        },
        runsOn: 'local-worker',
        worker: { paired: true, online: false, blocked: false },
        concurrency: 1,
      },
    ],
  })
}

const requests = ProviderRequestSeriesSchema.parse({
  provider: summary.id,
  recordedSince: '2026-07-01T00:00:00.000Z',
  daysFrom: '2026-08-19',
  daysTo: '2026-11-16',
  total: 41,
  days: [
    { date: '2026-10-20', count: 12 },
    { date: '2026-11-09', count: 20 },
    { date: '2026-11-16', count: 9 },
  ],
})

const coverage = ProviderLibraryCoverageSchema.parse({
  provider: summary.id,
  mediaTypes: [{ mediaType: 'album', covered: 96, total: 128 }],
})

function render(
  search = '',
  {
    id = summary.id,
    queue = waiting,
    provider = summary,
    libraryCoverage = coverage,
  }: {
    id?: string
    queue?: ProviderOverviewItem['queue']
    provider?: ProviderSummary
    libraryCoverage?: typeof coverage
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  client.setQueryData(['providers'], [provider])
  client.setQueryData(['provider-activity', summary.id, 'daily'], requests)
  client.setQueryData(
    ['provider-activity', summary.id, 'coverage'],
    libraryCoverage,
  )
  client.setQueryData(['providers', 'overview', 'all'], overview(queue))
  client.setQueryData(
    ['providers', 'local-worker', summary.id],
    ProviderLocalWorkerStatusSchema.parse({
      mode: 'local',
      supportsModeSwitch: false,
      configured: true,
      paired: true,
      online: false,
      lastSeenAt: null,
      blocked: false,
      active: false,
    }),
  )
  client.setQueryData(['provider-secrets', summary.id], {
    provider: summary.id,
    fields: summary.secrets,
    lastVerifiedAt: null,
    lastVerifiedStatus: null,
  })
  client.setQueryData(['jobs', 'provider-summary', summary.id], {
    provider: summary.id,
    total: 50,
    queued: 38,
    running: 0,
    succeeded: 10,
    failed: 2,
    cancelled: 0,
  })
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value={`/providers/${id}`}>
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            <ProviderPageClient providerId={id} />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
    network.mock.restore()
  }
}

function selectedTab(html: string) {
  return html.match(/aria-selected="true"[^>]*>([^<]+)/)?.[1]?.trim()
}

test('the header names the provider with its queue, connection and worker', () => {
  const html = render()
  assert.match(html, /<a href="\/providers">Providers<\/a>/)
  assert.match(html, /<h1 class="ds-detail-title">Fixture Ratings<\/h1>/)
  assert.match(html, /class="ds-kicker">Provider</)
  assert.match(html, /data-status="waiting"[^>]*>Waiting until/)
  assert.match(html, />Key set</)
  assert.match(html, />Local worker · offline</)
  assert.match(
    html,
    /href="\/jobs\?provider=fixture-ratings"[^>]*>Open in Jobs</,
  )
  const site = html.match(/<a[^>]*>Open site<svg/)?.[0] ?? ''
  assert.match(site, /href="https:\/\/example.com\/ratings"/)
  assert.match(site, /target="_blank"/)
  assert.match(site, /rel="noopener noreferrer"/)
  assert.match(
    site,
    /aria-label="Open Fixture Ratings site \(opens in a new tab\)"/,
  )
})

test('Open site is left out when the manifest names no site', () => {
  const html = render('', { provider: { ...summary, siteUrl: undefined } })
  assert.doesNotMatch(html, /Open site/)
  assert.match(html, />Open in Jobs</)
})

test('tabs are Overview, Jobs and Settings and follow the URL', () => {
  const html = render()
  assert.deepEqual(
    [...html.matchAll(/role="tab"[^>]*>([A-Za-z]+)/g)].map((match) => match[1]),
    ['Overview', 'Jobs', 'Settings'],
  )
  assert.equal(selectedTab(html), 'Overview')
  assert.match(html, /<span class="ds-count">38<\/span>/)
  assert.equal(selectedTab(render('tab=jobs')), 'Jobs')
  assert.equal(selectedTab(render('tab=settings')), 'Settings')
  assert.equal(selectedTab(render('tab=activity')), 'Overview')
})

test('overview shows job figures, queue settings, budget, credentials and supplies', () => {
  const html = render()
  assert.match(
    html,
    /<span class="ds-stat-value">38<\/span><span class="ds-stat-label">Queued<\/span>/,
  )
  assert.match(html, /<h3>Requests<\/h3>/)
  assert.match(html, /<h3>Recent activity<\/h3>/)
  assert.match(html, /<dt>Interval<\/dt><dd>1.5 s between requests<\/dd>/)
  assert.match(html, /<dt>Concurrency<\/dt><dd>1 at a time<\/dd>/)
  assert.match(html, /<dt>Daily budget<\/dt><dd><div class="ds-progress"/)
  assert.match(html, /aria-valuetext="312 of 1,000"/)
  assert.match(
    html,
    /<dt>API key<\/dt><dd><span class="ds-status" data-status="done">Set<\/span>/,
  )
  assert.match(html, />Albums<\/span>.*>Artists<\/span>/)
})

test('requests are the day-based trend chart with the ranges the history fills', () => {
  const html = render()
  const section = html.slice(
    html.indexOf('<h3>Requests</h3>'),
    html.indexOf('<h3>Recent activity</h3>'),
  )
  assert.match(section, />Requests per day</)
  assert.match(section, /role="img" aria-label="41 requests, by day"/)
  assert.deepEqual(
    [...section.matchAll(/aria-pressed="(?:true|false)"[^>]*>([^<]+)</g)].map(
      (match) => match[1],
    ),
    ['30d', '90d'],
  )
  assert.match(section, /aria-pressed="true"[^>]*>30d</)
  assert.match(section, /stroke-dasharray="1 5"/)
  assert.doesNotMatch(section, /ds-spark|<table/)
  assert.match(
    section,
    /Includes failed attempts; blocked calls are not counted/,
  )
})

test('request ranges offer 90 days only once recording began before the last 30', () => {
  const series = { daysTo: '2026-11-16' }
  assert.deepEqual(
    requestRanges({ ...series, recordedSince: '2026-10-17T23:59:00.000Z' }),
    ['30d', '90d'],
  )
  assert.deepEqual(
    requestRanges({ ...series, recordedSince: '2026-10-18T00:00:00.000Z' }),
    ['30d'],
  )
  assert.deepEqual(requestRanges({ ...series, recordedSince: null }), [
    '30d',
    '90d',
  ])
})

test('coverage shows each library the provider applies to', () => {
  const html = render()
  const section = html.slice(html.indexOf('<h3>Coverage</h3>'))
  assert.match(section, /items with data from this provider/)
  assert.match(
    section,
    /<div class="ds-coverage"><span>Albums<\/span>.*96 of 128<\/span><a[^>]*href="\/jobs\/metadata\?mediaType=album"[^>]*>Metadata<\/a>/,
  )
  const complete = render('', {
    libraryCoverage: {
      ...coverage,
      mediaTypes: [{ mediaType: 'album', covered: 128, total: 128 }],
    },
  })
  assert.match(complete, /128 of 128<\/span><span[^>]*>Complete</)
  const empty = render('', {
    libraryCoverage: {
      ...coverage,
      mediaTypes: [{ mediaType: 'album', covered: 0, total: 0 }],
    },
  })
  assert.match(empty, /No albums in the library/)
  const account = render('', { provider: { ...summary, mediaTypes: [] } })
  assert.doesNotMatch(account, /<h3>Coverage<\/h3>/)
})

test('the waiting reason shows on every tab with its action', () => {
  for (const tab of ['', 'tab=jobs', 'tab=settings']) {
    const html = render(tab)
    const notices = html.slice(html.indexOf('providers-notices'))
    assert.match(
      notices,
      /data-tone="attention"[^>]*>.*Cooling down: Provider rate limit reached \(HTTP 429\)\. The queue resumes at [0-9: -]+\. 38 jobs are waiting\./,
    )
    assert.match(notices, /<button[^>]*>Clear cooldown<\/button>/)
  }
  const paused = render('', {
    queue: { state: 'paused', reason: 'paused', until: null, detail: 'Paused' },
  })
  assert.match(paused, /data-status="paused"/)
  assert.doesNotMatch(paused, /The queue resumes/)
  const idle = render('', {
    queue: { state: 'idle', reason: null, until: null, detail: null },
  })
  assert.doesNotMatch(idle, /The queue resumes|jobs are waiting/)
  assert.match(idle, /<button[^>]*>Clear cooldown<\/button>/)
})

test('settings keep credentials masked, the limits and the local worker', () => {
  const html = render('tab=settings')
  assert.match(html, /<h3>Credentials<\/h3>/)
  assert.match(html, /type="password"[^>]*aria-label="API key"[^>]*value=""/)
  assert.match(html, /Required · Configured/)
  assert.match(html, /Five consecutive unexpected failures stop queued work/)
  assert.match(html, /<h3>Local worker<\/h3>/)
  assert.match(html, />Local<\/span>/)
  assert.match(html, /Local worker offline/)
  assert.match(html, /<h3>Error reviews<\/h3>/)
})

test('an unknown provider says so and links back to the overview', () => {
  const html = render('', { id: 'fixture-missing' })
  assert.match(html, /<strong>Provider not found<\/strong>/)
  assert.match(html, /href="\/providers">All providers</)
})
