import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ListeningSeriesSchema } from '@repo/schemas/lastfm'
import { ListeningTrend, type ListeningTrendKind } from './listening-trend'
import { ConfigContext } from './providers'
import {
  albumListeningPath,
  busiestMonth,
  formatListeningMonth,
  listeningSeriesPath,
} from '@/utils/listening-series'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in listening trend tests')
})

const series = ListeningSeriesSchema.parse({
  total: 14,
  firstDate: '2019-03-08',
  lastDate: '2026-11-12',
  daysFrom: '2021-11-16',
  daysTo: '2026-11-16',
  days: [
    { date: '2026-10-30', count: 3 },
    { date: '2026-11-12', count: 2 },
  ],
  months: [
    { month: '2019-03', count: 9 },
    { month: '2026-10', count: 3 },
    { month: '2026-11', count: 2 },
  ],
})

function render(kind: ListeningTrendKind, data?: unknown, failed = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  const queryKey = [kind, 'item-1', 'listening-series']
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
          <ListeningTrend kind={kind} id="item-1" />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('each kind reads its own series endpoint', () => {
  assert.equal(
    listeningSeriesPath('album', 'a/1'),
    '/api/v1/albums/a%2F1/listening/series',
  )
  assert.equal(
    listeningSeriesPath('track', 't'),
    '/api/v1/tracks/t/listening/series',
  )
  assert.equal(
    listeningSeriesPath('artist', 'r'),
    '/api/v1/artists/r/listening/series',
  )
  assert.equal(
    listeningSeriesPath('playlist', 'p'),
    '/api/v1/playlists/p/listening/series',
  )
})

test('the trend shows totals, first and last played and the shared chart', () => {
  const kinds: ListeningTrendKind[] = ['album', 'track', 'artist', 'playlist']
  for (const kind of kinds) {
    const html = render(kind, series)
    assert.match(html, /<h3>Listening<\/h3>/)
    assert.match(html, /class="ds-stat-value">14</)
    assert.match(html, /2019-03-08/)
    assert.match(html, /2026-11-12/)
    assert.match(
      html,
      /<svg[^>]*role="img"[^>]*aria-label="[\d,]+ scrobbles, by /,
    )
    assert.match(html, /aria-label="Range"/)
  }
})

test('the trend shows a skeleton while loading, the empty state and a retryable error', () => {
  const loading = render('artist')
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /class="ds-skel"/)
  assert.doesNotMatch(loading, /<svg/)
  const empty = render('playlist', {
    ...series,
    total: 0,
    firstDate: null,
    lastDate: null,
    days: [],
    months: [],
  })
  assert.match(empty, /No scrobbles yet/)
  assert.doesNotMatch(empty, /<svg|ds-stat-value/)
  const failed = render('track', undefined, true)
  assert.match(failed, /role="alert"/)
  assert.match(failed, /Could not load listening history/)
  assert.match(failed, />Retry</)
  const cached = render('album', series, true)
  assert.match(cached, /class="ds-stat-value">14</)
})

test('the busiest month is the earliest of the largest', () => {
  assert.deepEqual(
    busiestMonth([
      { month: '2020-03', count: 5 },
      { month: '2021-01', count: 5 },
      { month: '2019-01', count: 2 },
    ]),
    { month: '2020-03', count: 5 },
  )
  assert.equal(busiestMonth([]), undefined)
  assert.equal(formatListeningMonth('2020-03'), 'Mar 2020')
})

test('album listening path encodes the optional track key', () => {
  assert.equal(albumListeningPath('one', ''), '/api/v1/albums/one/listening')
  const url = new URL(
    albumListeningPath('one', 'artist & title?'),
    'http://localhost',
  )
  assert.equal(url.pathname, '/api/v1/albums/one/listening')
  assert.equal(url.searchParams.get('track'), 'artist & title?')
})
