import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ListeningSeriesSchema } from '@repo/schemas/lastfm'
import { Stats } from '@repo/ui/components/ds/facts'
import { ListeningStats, ScrobbleStats } from './listening-stats'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in listening stats tests')
})

function monthKey(offset: number) {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
    .toISOString()
    .slice(0, 7)
}

const series = ListeningSeriesSchema.parse({
  total: 21,
  firstDate: '2019-03-08',
  lastDate: '2026-11-12',
  historyFrom: '2018-06-20',
  daysFrom: '2021-11-16',
  daysTo: '2026-11-16',
  days: [],
  months: [
    { month: '2019-03', count: 9 },
    { month: monthKey(3), count: 5 },
    { month: monthKey(0), count: 7 },
  ],
})

const items = [
  { label: 'scrobbles', value: '21' },
  { label: 'last played', value: '2026-11-12' },
]

const albumStats = (
  <ListeningStats kind="album" id="album-1" trendOn="scrobbles" items={items} />
)

function render(data?: unknown, failed = false, stats = albumStats) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  const queryKey = ['album', 'album-1', 'listening-series']
  if (data !== undefined) client.setQueryData(queryKey, data)
  if (failed)
    client
      .getQueryCache()
      .build(client, { queryKey })
      .setState({
        status: 'error',
        error: new Error('Offline'),
        fetchStatus: 'idle',
      })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          {stats}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('a stats row without a trend is unchanged', () => {
  assert.equal(
    renderToStaticMarkup(<Stats items={items} />),
    '<div class="ds-stats">' +
      '<div class="ds-stat"><span class="ds-stat-value">21</span><span class="ds-stat-label">scrobbles</span></div>' +
      '<div class="ds-stat"><span class="ds-stat-value">2026-11-12</span><span class="ds-stat-label">last played</span></div>' +
      '</div>',
  )
})

test('a stat with a trend draws a labelled sparkline beside its value', () => {
  const html = renderToStaticMarkup(
    <Stats
      items={[
        {
          label: 'scrobbles',
          value: '96',
          trend: {
            values: [0, 2, 5, 1, 0, 0, 3, 8, 4, 2, 6, 9],
            label: 'Scrobbles since 2014-03-10',
          },
        },
        { label: 'last played', value: '2026-11-12' },
      ]}
    />,
  )
  assert.match(
    html,
    /<span class="ds-stat-value">96<svg class="ds-spark" viewBox="0 0 72 20"[^>]*role="img" aria-label="Scrobbles since 2014-03-10">/,
  )
  assert.equal(html.match(/<svg/g)?.length, 1)
})

test('the scrobbles stat carries every month since the history began', () => {
  const html = render(series)
  assert.match(
    html,
    /<span class="ds-stat-value">21<svg class="ds-spark"[^>]*aria-label="Scrobbles since 2018-06-20">/,
  )
  assert.match(
    html,
    /<span class="ds-stat-value">2026-11-12<\/span><span class="ds-stat-label">last played/,
  )
})

test('no chart while loading, after a failure, or with no scrobbles', () => {
  const plain = renderToStaticMarkup(<Stats items={items} />)
  assert.equal(render(), plain)
  assert.equal(render(undefined, true), plain)
  assert.equal(render({ ...series, total: 0, months: [] }), plain)
  assert.equal(render({ ...series, historyFrom: null }), plain)
})

test('stats led by the series show its total, trend and last date, and are empty before it loads', () => {
  const stats = (
    <ScrobbleStats
      kind="album"
      id="album-1"
      items={[{ label: 'playlists', value: '3' }]}
    />
  )
  const loaded = render(series, false, stats)
  assert.match(
    loaded,
    /<span class="ds-stat-value">21<svg class="ds-spark"[^>]*aria-label="Scrobbles since 2018-06-20">/,
  )
  assert.match(
    loaded,
    /<span class="ds-stat-value">2026-11-12<\/span><span class="ds-stat-label">last played<\/span><\/div><div class="ds-stat"><span class="ds-stat-value">3<\/span><span class="ds-stat-label">playlists</,
  )
  const empty =
    '<div class="ds-stat"><span class="ds-stat-value"><span class="ds-empty-value">–</span></span><span class="ds-stat-label">scrobbles</span></div>' +
    '<div class="ds-stat"><span class="ds-stat-value"><span class="ds-empty-value">–</span></span><span class="ds-stat-label">last played</span></div>'
  assert.ok(render(undefined, false, stats).includes(empty))
  assert.ok(render(undefined, true, stats).includes(empty))
  assert.match(
    render({ ...series, total: 0, lastDate: null, months: [] }, false, stats),
    /<span class="ds-stat-value">0<\/span><span class="ds-stat-label">scrobbles/,
  )
})
