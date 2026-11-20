import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  ProviderOverviewItemSchema,
  ProviderOverviewSchema,
  type ProviderOverviewItem,
} from '@repo/schemas/provider'
import { formatUntil } from '@repo/ui/lib/format'
import ProvidersPageClient from './pages/providers-page-client'

const quiet = Array.from({ length: 24 }, () => 0)
const idleQueue = { state: 'idle', reason: null, until: null, detail: null }
const until = new Date(Date.now() + 40 * 60_000).toISOString()

function provider(overrides: Partial<ProviderOverviewItem>) {
  return ProviderOverviewItemSchema.parse({
    id: 'fixture-ratings',
    name: 'Fixture Ratings',
    description: 'Album ratings',
    group: 'metadata',
    roles: ['album'],
    connection: { state: 'connected', method: 'key', detail: 'Key set' },
    queue: idleQueue,
    jobs: { queued: 0, running: 0, failed: 0, attention: 0 },
    lastSuccessAt: null,
    requests24h: quiet,
    budget: null,
    runsOn: 'server',
    worker: null,
    concurrency: 1,
    ...overrides,
  })
}

const ratings = provider({
  queue: {
    state: 'waiting',
    reason: 'cooldown',
    until,
    detail: 'Cooling down: Provider rate limit reached (HTTP 429)',
  },
  jobs: { queued: 38, running: 0, failed: 2, attention: 2 },
  lastSuccessAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  requests24h: [...quiet.slice(0, 20), 12, 40, 31, 0],
  budget: {
    used: 312,
    limit: 1000,
    period: 'day',
    resetsAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  },
})
const account = provider({
  id: 'fixture-account',
  name: 'Fixture Account',
  description: 'Account sync',
  group: 'account',
  roles: ['account'],
  connection: {
    state: 'needs-sign-in',
    method: 'account',
    detail: 'Sign in to the account',
  },
})
const films = provider({
  id: 'fixture-films',
  name: 'Fixture Films',
  description: '',
  roles: ['film'],
  connection: { state: 'not-required', method: 'none', detail: null },
  queue: { state: 'running', reason: null, until: null, detail: null },
  jobs: { queued: 0, running: 3, failed: 0, attention: 0 },
  runsOn: 'local-worker',
  worker: { paired: true, online: true, blocked: false },
})

function overview(providers: ProviderOverviewItem[]) {
  return ProviderOverviewSchema.parse({
    generatedAt: new Date().toISOString(),
    requestsFrom: new Date(Date.now() - 86_400_000).toISOString(),
    providers,
  })
}

function render(
  search = '',
  setup: (client: QueryClient) => void = (client) =>
    client.setQueryData(
      ['providers', 'overview', 'all'],
      overview([account, films, ratings]),
    ),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  setup(client)
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value="/providers">
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            <ProvidersPageClient />
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

function row(html: string, name: string) {
  const value = [...html.matchAll(/<tr>.*?<\/tr>/g)].find(([markup]) =>
    markup.includes(`>${name}</a>`),
  )?.[0]
  assert.ok(value, `Missing ${name} row`)
  return value
}

test('the overview lists every provider once, grouped into accounts and metadata', () => {
  const html = render()
  assert.match(html, /<h1>Providers<\/h1><p>2 need attention<\/p>/)
  assert.match(html, /3 providers/)
  const accounts = html.indexOf('<td colSpan="11">Accounts</td>')
  const metadata = html.indexOf('<td colSpan="11">Metadata</td>')
  assert.ok(accounts > -1 && metadata > accounts)
  assert.ok(html.indexOf('>Fixture Account</a>') > accounts)
  assert.ok(html.indexOf('>Fixture Account</a>') < metadata)
  assert.ok(html.indexOf('>Fixture Films</a>') > metadata)
  assert.match(html, /href="\/providers\/fixture-ratings"/)
  assert.match(
    html,
    /<span class="ds-logo" data-none="" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><span class="ds-cell-two"><a class="ds-cell-title" href="\/providers\/fixture-ratings"/,
  )
  const onlyMetadata = render('', (client) =>
    client.setQueryData(['providers', 'overview', 'all'], overview([ratings])),
  )
  assert.doesNotMatch(onlyMetadata, />Accounts</)
})

test('rows show connection, queue with its reason, counts, last success and requests', () => {
  const html = render()
  const waiting = row(html, 'Fixture Ratings')
  assert.match(waiting, /data-status="done"[^>]*>Key set</)
  assert.match(
    waiting,
    new RegExp(
      `data-status="waiting"[^>]*>Waiting until ${formatUntil(until)}</span>`,
    ),
  )
  assert.match(waiting, /Cooling down: Provider rate limit reached/)
  assert.match(
    waiting,
    /href="\/jobs\?provider=fixture-ratings&amp;status=queued"[^>]*>38</,
  )
  assert.match(
    waiting,
    /href="\/jobs\?provider=fixture-ratings&amp;status=attention"[^>]*><span class="ds-count" data-tone="danger">2</,
  )
  assert.match(waiting, />3 h ago</)
  assert.match(waiting, /aria-label="83 requests in the last 24 hours"/)
  assert.match(waiting, />Album ratings</)
  assert.match(waiting, />Server</)
  assert.match(waiting, />Clear cooldown</)

  const running = row(html, 'Fixture Films')
  assert.match(running, /data-status="never"[^>]*>Not required</)
  assert.match(running, /data-status="running"[^>]*>Running</)
  assert.match(running, /status=running"[^>]*>3</)
  assert.match(running, />Films</)
  assert.match(running, />Local worker · online</)
  assert.match(running, /data-status="never">Never</)
  assert.match(running, /class="ds-empty-value">–</)
  assert.doesNotMatch(running, /Clear cooldown/)

  const signIn = row(html, 'Fixture Account')
  assert.match(signIn, /data-status="attention"[^>]*>Needs sign-in</)
  assert.match(signIn, /data-status="done"[^>]*>Idle</)
})

test('each queue state is shown with the status vocabulary', () => {
  const states: Array<[ProviderOverviewItem['queue'], RegExp]> = [
    [
      { state: 'paused', reason: 'paused', until: null, detail: 'Paused' },
      /data-status="paused"[^>]*>Paused</,
    ],
    [
      {
        state: 'stopped',
        reason: 'access-denied',
        until: null,
        detail: 'Access denied',
      },
      /data-status="attention"[^>]*>Stopped · access denied</,
    ],
    [
      {
        state: 'waiting',
        reason: 'worker-offline',
        until: null,
        detail: 'Worker offline',
      },
      /data-status="waiting"[^>]*>Waiting · worker offline</,
    ],
  ]
  for (const [queue, expected] of states) {
    const html = render('', (client) =>
      client.setQueryData(
        ['providers', 'overview', 'all'],
        overview([provider({ queue })]),
      ),
    )
    assert.match(row(html, 'Fixture Ratings'), expected)
  }
})

test('connection states use the connection wording', () => {
  const cases: Array<[ProviderOverviewItem['connection'], string]> = [
    [{ state: 'connected', method: 'account', detail: null }, 'Connected'],
    [{ state: 'needs-key', method: 'key', detail: null }, 'Needs key'],
    [{ state: 'unavailable', method: 'none', detail: null }, 'Unavailable'],
  ]
  for (const [connection, label] of cases) {
    const html = render('', (client) =>
      client.setQueryData(
        ['providers', 'overview', 'all'],
        overview([provider({ connection })]),
      ),
    )
    assert.match(row(html, 'Fixture Ratings'), new RegExp(`>${label}</span>`))
  }
})

test('budget shows used of limit with its reset, or no limit', () => {
  const html = render()
  const waiting = row(html, 'Fixture Ratings')
  assert.match(
    waiting,
    /class="ds-progress" title="312 of 1,000 requests today · resets [^"]+"><div class="ds-meter"><i style="width:31%"><\/i><\/div><span>31%<\/span>/,
  )
  assert.match(row(html, 'Fixture Films'), />No limit</)
})

test('problems rise to the top with the action that fixes them', () => {
  const html = render()
  const notices = html.slice(
    html.indexOf('providers-notices'),
    html.indexOf('<table'),
  )
  assert.match(
    notices,
    /data-tone="attention"[^>]*>.*Fixture Ratings: Cooling down: Provider rate limit reached \(HTTP 429\) 38 jobs are queued\./,
  )
  assert.match(notices, /href="\/providers\/fixture-ratings">Open</)
  assert.match(
    notices,
    /data-tone="danger"[^>]*>.*Fixture Account: Sign in to the account/,
  )
  const keyNeeded = render('', (client) =>
    client.setQueryData(
      ['providers', 'overview', 'all'],
      overview([
        provider({
          connection: { state: 'needs-key', method: 'key', detail: null },
        }),
      ]),
    ),
  )
  assert.match(
    keyNeeded,
    /href="\/providers\/fixture-ratings\?tab=settings">Add key</,
  )
  assert.doesNotMatch(
    render('', (client) =>
      client.setQueryData(['providers', 'overview', 'all'], overview([films])),
    ),
    /providers-notices/,
  )
})

test('the library filter reads the mediaType of old links', () => {
  const html = render('mediaType=album', (client) =>
    client.setQueryData(
      ['providers', 'overview', 'album'],
      overview([ratings]),
    ),
  )
  assert.match(html, /<select class="ds-select" aria-label="Library">/)
  assert.match(html, /<option value="album" selected="">Albums<\/option>/)
  assert.match(html, />Fixture Ratings</)
  assert.match(
    render('mediaType=track'),
    /<option value="" selected="">All libraries<\/option>/,
  )
})

test('loading, empty and error states', () => {
  const loading = render('', () => {})
  assert.match(
    loading,
    /aria-hidden="true"><td colSpan="11"><div class="ds-skel/,
  )
  assert.doesNotMatch(loading, /providers<\/span>/)

  assert.match(
    render('', (client) =>
      client.setQueryData(['providers', 'overview', 'all'], overview([])),
    ),
    /<strong>No providers configured<\/strong>/,
  )
  const filtered = render('mediaType=subscription', (client) =>
    client.setQueryData(
      ['providers', 'overview', 'subscription'],
      overview([]),
    ),
  )
  assert.match(filtered, /No providers for this library/)
  assert.match(filtered, />Show all libraries</)

  const failed = render('', (client) => {
    const query = client
      .getQueryCache()
      .build(client, { queryKey: ['providers', 'overview', 'all'] })
    query.setState({
      ...query.state,
      status: 'error',
      error: new Error('Request failed'),
    })
  })
  assert.match(
    failed,
    /role="alert"><strong>Could not load providers<\/strong>/,
  )
  assert.match(failed, />Retry</)
})

test('the Mixes filter lists the station providers under their library', () => {
  const names: Record<string, string> = {
    rinse: 'Rinse FM',
    nts: 'NTS',
    lotradio: 'The Lot Radio',
  }
  const stations = Object.entries(names).map(([id, name]) =>
    provider({
      id,
      name,
      description: '',
      roles: ['mix'],
      connection: { state: 'not-required', method: 'none', detail: null },
    }),
  )
  const html = render('mediaType=mix', (client) =>
    client.setQueryData(['providers', 'overview', 'mix'], overview(stations)),
  )
  assert.match(html, /<option value="mix" selected="">Mixes<\/option>/)
  // Without a description a provider is described by its libraries.
  for (const name of Object.values(names))
    assert.match(row(html, name), />Mixes</)
  assert.doesNotMatch(html, /Fixture Ratings|Fixture Films/)
})
