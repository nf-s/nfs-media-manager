import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AlbumListeningSchema,
  ListeningSeriesSchema,
} from '@repo/schemas/lastfm'
import AlbumListening from './album-listening'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in album listening tests')
})

const seriesKey = ['album', 'one', 'listening-series']
const listeningKey = ['album-listening', 'one', '']

const series = ListeningSeriesSchema.parse({
  total: 12,
  firstDate: '2019-11-02',
  lastDate: '2022-01-05',
  historyFrom: '2012-06-20',
  daysFrom: '2021-11-16',
  daysTo: '2026-11-16',
  days: [{ date: '2022-01-05', count: 8 }],
  months: [
    { month: '2019-11', count: 4 },
    { month: '2022-01', count: 8 },
  ],
})
const listening = AlbumListeningSchema.parse({
  total: 12,
  firstListenedAt: '2019-11-02T10:00:00Z',
  lastListenedAt: '2022-01-05T10:00:00Z',
  months: series.months,
  tracks: [
    {
      key: 'opening',
      trackId: 'opening-track',
      title: 'Opening',
      position: 1,
      count: 9,
      lastListenedAt: '2022-01-05T10:00:00Z',
    },
    {
      key: 'closing',
      title: 'Closing',
      position: 2,
      count: 3,
      lastListenedAt: '2020-01-05T10:00:00Z',
    },
  ],
  sources: [
    { artistName: 'Artist fixture', albumName: 'Album fixture', count: 9 },
    {
      artistName: 'Second artist',
      albumName: 'Other title',
      count: 3,
      manual: true,
    },
  ],
  similarUnlinked: [
    {
      artistName: 'Artist fixture',
      albumName: 'Album fixture (Deluxe)',
      count: 2,
    },
  ],
})

function render(
  seed: Array<[unknown[], unknown]>,
  children: ReactNode,
  failedKeys: unknown[][] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  for (const [key, value] of seed) client.setQueryData(key, value)
  for (const queryKey of failedKeys)
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
          {children}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('album Listening shows the totals, the shared chart with a track picker and the tracks by scrobbles', () => {
  const html = render(
    [
      [seriesKey, series],
      [listeningKey, listening],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /class="ds-stat-value">12</)
  assert.match(html, /2019-11-02/)
  assert.match(html, /2022-01-05/)
  assert.match(html, /busiest month/)
  assert.match(html, /Jan 2022/)
  assert.match(
    html,
    /<svg[^>]*role="img"[^>]*aria-label="[\d,]+ scrobbles, by /,
  )
  assert.match(html, /aria-label="Range"/)
  assert.match(html, /<select class="ds-select" aria-label="Track">/)
  assert.match(html, /<option value="" selected="">All tracks<\/option>/)
  assert.match(html, /<option value="opening">1\. Opening \(9\)<\/option>/)
  assert.match(html, /aria-label="Scrobbles by track"/)
  assert.match(html, /<h3>By track<\/h3>/)
  assert.doesNotMatch(html, /Loading|Year|Bar|<polyline/)
})

test('album Listening lists scrobble names with Link and Unlink when Sources cannot be opened', () => {
  const html = render(
    [
      [seriesKey, series],
      [listeningKey, listening],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /aria-label="Scrobble names"/)
  assert.match(html, />Scrobbled as</)
  assert.match(
    html,
    /aria-label="Unlink Artist fixture — Album fixture"[^>]*>Unlink</,
  )
  assert.match(
    html,
    /aria-label="Link Artist fixture — Album fixture \(Deluxe\)"[^>]*>Link</,
  )
  assert.match(html, /Linked manually/)
  assert.match(html, />Add scrobbled name</)
  assert.match(
    html,
    /href="\/imports\/lastfm\?mediaType=album&amp;reason=unlinked">Review scrobble links/,
  )
})

test('album Listening points to Sources for scrobble names when it can open them', () => {
  const html = render(
    [
      [seriesKey, series],
      [listeningKey, listening],
    ],
    <AlbumListening albumId="one" onOpenSources={() => {}} />,
  )
  assert.match(html, /Scrobble names are matched in Sources, under Last\.fm\./)
  assert.match(html, />Open Sources</)
  assert.match(html, /href="\/tracks\/opening-track\?tab=sources">Opening<\/a>/)
  assert.match(
    html,
    /<span class="ds-cell-title" title="Closing">Closing<\/span>/,
  )
  assert.doesNotMatch(html, /aria-label="Scrobble names"/)
})

test('albums without scrobbles show the empty state and still list similar names', () => {
  const html = render(
    [
      [
        seriesKey,
        {
          ...series,
          total: 0,
          firstDate: null,
          lastDate: null,
          days: [],
          months: [],
        },
      ],
      [
        listeningKey,
        {
          ...listening,
          total: 0,
          months: [],
          tracks: [],
          sources: [],
        },
      ],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /No scrobbles yet/)
  assert.doesNotMatch(html, /<select|<svg|By track/)
  assert.match(html, /Link Artist fixture — Album fixture \(Deluxe\)/)
})

test('album Listening keeps cached data after a failed refresh and offers Retry when nothing is cached', () => {
  const cached = render(
    [
      [seriesKey, series],
      [listeningKey, listening],
    ],
    <AlbumListening albumId="one" />,
    [seriesKey, listeningKey],
  )
  assert.match(cached, /class="ds-stat-value">12</)
  const failed = render([], <AlbumListening albumId="one" />, [
    seriesKey,
    listeningKey,
  ])
  assert.match(failed, /role="alert"/)
  assert.match(failed, /Could not load listening history/)
  assert.match(failed, />Retry</)
  const loading = render([], <AlbumListening albumId="one" />)
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /class="ds-skel"/)
})
