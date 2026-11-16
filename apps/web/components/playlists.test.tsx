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
  PlaylistSummarySchema,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import PlaylistsWorkspace from './playlists-workspace'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const playlist = PlaylistSummarySchema.parse({
  id: 'playlist-1',
  name: 'Synthetic mix',
  source: 'spotify',
  ownerName: 'Example owner',
  description: null,
  artworkUrl: null,
  spotifyUrl: null,
  importedAt: '2026-01-02T00:00:00.000Z',
  trackCount: 12,
  linkedTrackCount: 7,
  albumCount: 3,
  durationSec: 3900,
})

function render(
  children: ReactNode,
  data: Array<[unknown[], unknown]>,
  search = '',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  for (const [key, value] of data) client.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/playlists">
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
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

function playlistPage(
  items: PlaylistSummary[],
  hasMore = false,
): [unknown[], unknown] {
  return [
    ['playlists', 'browse', '', [], 'name', 'asc', 1],
    {
      items,
      page: 1,
      size: 100,
      hasMore,
      totalCount: hasMore ? undefined : items.length,
    },
  ]
}

const filterParam = (name: string) =>
  new URLSearchParams({
    filters: JSON.stringify([
      { field: 'playlist', value: name, mode: 'required' },
    ]),
  })
    .toString()
    .replaceAll('&', '&amp;')

test('playlists table links tracks and albums filtered by playlist', () => {
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([
      playlist,
      { ...playlist, id: 'legacy', name: 'Old list', source: null },
    ]),
  ])
  assert.ok(html.includes(`href="/tracks?${filterParam('Synthetic mix')}"`))
  assert.ok(html.includes(`href="/albums?${filterParam('Synthetic mix')}"`))
  assert.match(html, /7 of 12/)
  assert.match(html, /1h 5m/)
  assert.equal((html.match(/aria-label="Remove /g) ?? []).length, 1)
  assert.match(html, /title="Remove Synthetic mix"/)
  assert.doesNotMatch(html, />Remove<\/button>/)
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]*title="Sort by Playlist"[^>]*>Playlist<svg/,
  )
  assert.match(html, /href="\/imports\/spotify-playlists\?mediaType=track"/)
})

test('playlist rows open the drawer and show the sync schedule and last check', () => {
  const synced = PlaylistSummarySchema.parse({
    ...playlist,
    sync: {
      syncable: true,
      schedule: '6h',
      lastCheckedAt: '2026-01-03T00:00:00.000Z',
      nextScheduledAt: null,
      job: null,
    },
  })
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([synced, { ...playlist, id: 'legacy', name: 'Old list' }]),
  ])
  assert.match(
    html,
    /<button[^>]*title="Sort by Schedule"[^>]*>Schedule<\/button>/,
  )
  assert.match(
    html,
    /<button[^>]*title="Sort by Last checked"[^>]*>Last checked<\/button>/,
  )
  assert.match(html, />Every 6 hours</)
  assert.match(html, /<time dateTime="2026-01-03T00:00:00.000Z" title="[^"]+">/)
  assert.match(
    html,
    /<a class="ds-cell-title" href="\/playlists\/playlist-1"[^>]*>Synthetic mix<\/a>/,
  )
  assert.doesNotMatch(html, /Playlist details/)
})

test('an empty playlist table links to the import page', () => {
  const html = render(<PlaylistsWorkspace />, [playlistPage([])])
  assert.match(html, /No playlists\./)
  assert.match(html, /Import playlists/)
})

test('the playlists directory renders only its visible rows while counting and afterward', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...playlist,
    id: `playlist-${index + 1}`,
    name: `Fixture playlist ${index + 1}`,
  }))
  for (const totalCount of [undefined, 305]) {
    const data = [playlistPage(rows, true)]
    if (totalCount)
      data.push([['playlists', 'browse-count', '', []], { totalCount }])
    const html = render(<PlaylistsWorkspace />, data)
    const rowCount = (
      html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr\b/g) ?? []
    ).length
    assert.ok(
      rowCount <= 30,
      `Expected the visible window, rendered ${rowCount} rows`,
    )
    assert.match(html, /aria-rowindex="2"/)
    assert.match(html, />Fixture playlist 1<\/a>/)
    assert.doesNotMatch(html, /Fixture playlist 100/)
    if (totalCount) {
      assert.match(html, /305 playlists/)
      assert.match(html, /aria-rowcount="306"/)
      assert.match(html, /style="height:9152px;padding:0;border:0"/)
    } else {
      assert.match(html, /Counting playlists/)
      assert.doesNotMatch(html, /aria-rowcount=/)
    }
  }
})

test('compact playlist names and owners retain their complete text', () => {
  const name =
    'A long playlist title with several words that must remain available'
  const owner = 'A long example owner name that must remain available'
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([{ ...playlist, name, ownerName: owner }]),
  ])
  assert.ok(html.includes(`title="${name}"`))
  assert.ok(html.includes(`title="${owner}"`))
  assert.ok(html.includes(`aria-label="Remove ${name}"`))
  assert.ok(html.includes(`>${name}</a>`))
})

test('playlist toolbar follows actions and Source starts hidden', () => {
  const html = render(<PlaylistsWorkspace />, [playlistPage([playlist])])
  const search = html.indexOf('aria-label="Search playlists"')
  const count = html.indexOf('1 playlist')
  const columns = html.indexOf('aria-label="Visible columns"')
  const actions = html.indexOf(
    'href="/imports/spotify-playlists?mediaType=track"',
  )
  assert.ok(search > 0 && actions < search && count > search && columns > count)
  assert.match(html, />Source<\/label>/)
  assert.doesNotMatch(html, /aria-label="Filter Source"|title="Sort by Source"/)
})

test('playlist imports preserve Albums', () => {
  const html = render(
    <PlaylistsWorkspace />,
    [playlistPage([playlist])],
    'mediaType=album',
  )
  assert.match(html, /href="\/imports\/spotify-playlists\?mediaType=album"/)
})
