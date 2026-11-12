import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  AlbumListeningSchema,
  LastfmSyncStatusSchema,
} from '@repo/schemas/lastfm'
import ImportsWorkspace from './imports-workspace'
import LastfmSyncPageClient from './pages/lastfm-sync-page-client'
import AlbumListening, { ListeningChart } from './album-listening'
import { ConfigContext } from './providers'
import { yearBars } from '@/utils/listening-chart'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const idle = LastfmSyncStatusSchema.parse({
  configured: true,
  state: 'never',
  pagesFetched: 0,
  totalPages: null,
  newScrobbles: 0,
  storedScrobbles: 0,
  matchedScrobbles: 0,
  startedAt: null,
  lastCompletedAt: null,
  errorMessage: null,
})

function render(seed: Array<[unknown[], unknown]>, children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['imports'], { sources: [], runs: [] })
  client.setQueryData(['import-formats'], [])
  for (const [key, value] of seed) client.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/imports/lastfm">
            <SearchParamsContext.Provider
              value={new URLSearchParams('mediaType=album')}
            >
              {children}
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function syncPage(status: unknown) {
  return render(
    [[['lastfm-sync'], status]],
    <ImportsWorkspace>
      <LastfmSyncPageClient />
    </ImportsWorkspace>,
  )
}

test('Last.fm page is an album import destination and only shows stored status', () => {
  const html = syncPage(idle)
  assert.match(
    html,
    /aria-current="page"[^>]*href="\/imports\/lastfm\?mediaType=album"/,
  )
  assert.match(html, /Last\.fm scrobbles/)
  assert.match(html, /Not synced/)
  assert.match(html, />Sync scrobbles</)
  assert.doesNotMatch(html, /<progress|>Stop<|Resume sync/)
  assert.doesNotMatch(html, /provider settings/)
})

test('unconfigured Last.fm links to provider settings and disables sync', () => {
  const html = syncPage({ ...idle, configured: false })
  assert.match(
    html,
    /href="\/providers\?provider=lastfm&amp;mediaType=album">Last\.fm provider settings/,
  )
  assert.match(html, /disabled=""[^>]*>Sync scrobbles/)
})

test('running sync shows page progress, added scrobbles and Stop', () => {
  const html = syncPage({
    ...idle,
    state: 'running',
    pagesFetched: 12,
    totalPages: 340,
    newScrobbles: 2400,
    storedScrobbles: 2400,
    matchedScrobbles: 1800,
    startedAt: '2026-01-01T00:00:00Z',
  })
  assert.match(html, /<progress[^>]*value="12"[^>]*max="340"/)
  assert.match(html, /Page 12 of 340/)
  assert.match(html, /2,400 scrobbles added/)
  assert.match(html, /1,800 of 2,400/)
  assert.match(html, />Stop</)
  assert.match(html, /disabled=""[^>]*>Sync scrobbles/)
})

test('failed and stopped syncs offer Resume sync with the stored error', () => {
  const failed = syncPage({
    ...idle,
    state: 'failed',
    pagesFetched: 3,
    totalPages: 10,
    errorMessage: 'Last.fm returned an error',
  })
  assert.match(failed, />Resume sync</)
  assert.match(failed, /role="alert">Last\.fm returned an error/)
  assert.match(syncPage({ ...idle, state: 'stopped' }), />Resume sync</)
})

test('listening tab summarises scrobbles with a year chart and track selector', () => {
  const listening = AlbumListeningSchema.parse({
    total: 12,
    firstListenedAt: '2019-11-02T10:00:00Z',
    lastListenedAt: '2022-01-05T10:00:00Z',
    months: [
      { month: '2019-11', count: 4 },
      { month: '2022-01', count: 8 },
    ],
    tracks: [
      {
        key: 'opening',
        title: 'Opening',
        position: 1,
        count: 12,
        lastListenedAt: '2022-01-05T10:00:00Z',
      },
    ],
  })
  const html = render(
    [[['album-listening', 'one', ''], listening]],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /<dd>12<\/dd>/)
  assert.match(html, /<option value="" selected="">All tracks<\/option>/)
  assert.match(html, /<option value="opening">1\. Opening \(12\)<\/option>/)
  assert.match(html, /aria-label="Scrobbles by year"/)
  for (const label of [
    '2019: 4 scrobbles',
    '2020: 0 scrobbles',
    '2021: 0 scrobbles',
    '2022: 8 scrobbles',
  ])
    assert.ok(html.includes(label), label)
  assert.match(html, /aria-pressed="true"[^>]*>Year</)
  assert.doesNotMatch(html, /Loading/)
})

test('albums without linked scrobbles show a plain empty state', () => {
  const html = render(
    [
      [
        ['album-listening', 'one', ''],
        {
          total: 0,
          firstListenedAt: null,
          lastListenedAt: null,
          months: [],
          tracks: [],
        },
      ],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /No scrobbles linked to this album\./)
  assert.doesNotMatch(html, /<select|Scrobbles by/)
})

test('chart bars carry accessible period and count text', () => {
  const html = renderToStaticMarkup(
    <ListeningChart
      period="year"
      bars={yearBars([{ month: '2024-03', count: 1 }])}
    />,
  )
  assert.match(html, /title="2024: 1 scrobble"/)
  assert.match(html, /class="sr-only">2024: 1 scrobble</)
  assert.match(html, /height:100%/)
})
