import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { PlaylistSummarySchema } from '@repo/schemas/tracks'
import PlaylistsWorkspace, { filterPlaylists } from './playlists-workspace'
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

const filterParam = (name: string) =>
  new URLSearchParams({
    filters: JSON.stringify([
      { field: 'playlist', value: name, mode: 'required' },
    ]),
  })
    .toString()
    .replaceAll('&', '&amp;')

test('playlists table links tracks and albums filtered by playlist and labels sources', () => {
  const html = render(<PlaylistsWorkspace />, [
    [
      ['playlists'],
      [playlist, { ...playlist, id: 'legacy', name: 'Old list', source: null }],
    ],
  ])
  assert.ok(html.includes(`href="/tracks?${filterParam('Synthetic mix')}"`))
  assert.ok(html.includes(`href="/albums?${filterParam('Synthetic mix')}"`))
  assert.match(html, /7 of 12/)
  assert.match(html, /1 h 5 min/)
  assert.match(html, />Spotify</)
  assert.match(html, />Library</)
  assert.equal((html.match(/aria-label="Remove /g) ?? []).length, 1)
  assert.match(html, /title="Remove Synthetic mix"/)
  assert.doesNotMatch(html, />Remove<\/button>/)
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]*title="Sort by Playlist"[^>]*>Playlist<span aria-hidden="true"> ↑<\/span>/,
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
    [['playlists'], [synced, { ...playlist, id: 'legacy', name: 'Old list' }]],
  ])
  assert.match(html, /<button[^>]*title="Sort by Schedule"[^>]*>Schedule<span/)
  assert.match(
    html,
    /<button[^>]*title="Sort by Last checked"[^>]*>Last checked<span/,
  )
  assert.match(html, />Every 6 hours</)
  assert.match(html, /<time dateTime="2026-01-03T00:00:00.000Z">/)
  assert.match(
    html,
    /<button type="button" class="table-title[^"]*">Synthetic mix<\/button>/,
  )
  assert.doesNotMatch(html, /Playlist details/)
})

test('an empty playlist table links to the import page', () => {
  const html = render(<PlaylistsWorkspace />, [[['playlists'], []]])
  assert.match(html, /No playlists\./)
  assert.match(html, /Import playlists/)
})

test('compact playlist names and owners retain their complete text', () => {
  const name =
    'A long playlist title with several words that must remain available'
  const owner = 'A long example owner name that must remain available'
  const html = render(<PlaylistsWorkspace />, [
    [['playlists'], [{ ...playlist, name, ownerName: owner }]],
  ])
  assert.ok(html.includes(`title="${name}"`))
  assert.ok(html.includes(`title="${owner}"`))
  assert.ok(html.includes(`aria-label="Remove ${name}"`))
  assert.ok(html.includes(`>${name}</button>`))
})

test('playlist filters combine name, owner and description search with source', () => {
  const rows = [
    playlist,
    {
      ...playlist,
      id: 'library',
      name: 'Library collection',
      source: null,
      ownerName: null,
      description: 'Evening albums',
    },
    PlaylistSummarySchema.parse({
      ...playlist,
      id: 'liked',
      source: 'spotify-liked',
    }),
  ]
  assert.deepEqual(
    filterPlaylists(rows, '  EXAMPLE OWNER  ', ['spotify']).map(
      (row) => row.id,
    ),
    ['playlist-1'],
  )
  assert.deepEqual(
    filterPlaylists(rows, 'evening', ['library']).map((row) => row.id),
    ['library'],
  )
  assert.deepEqual(
    filterPlaylists(rows, 'Synthetic', ['spotify-liked']).map((row) => row.id),
    ['liked'],
  )
  assert.deepEqual(filterPlaylists(rows, 'missing', []), [])
  assert.equal(filterPlaylists(rows, '', []).length, 3)
})

test('playlist toolbar follows actions and source filtering stays in the header', () => {
  const html = render(<PlaylistsWorkspace />, [[['playlists'], [playlist]]])
  const search = html.indexOf('aria-label="Search playlists"')
  const source = html.indexOf('aria-label="Filter Source"')
  const count = html.indexOf('1 playlists')
  const columns = html.indexOf('aria-label="Visible columns"')
  const actions = html.indexOf(
    'href="/imports/spotify-playlists?mediaType=track"',
  )
  assert.ok(
    search > 0 &&
      actions < search &&
      count > search &&
      columns > count &&
      source > html.indexOf('<thead>'),
  )
})

test('playlist sources can include several values and imports preserve Albums', () => {
  const rows = [
    playlist,
    PlaylistSummarySchema.parse({
      ...playlist,
      id: 'liked',
      source: 'spotify-liked',
    }),
    { ...playlist, id: 'library', source: null },
  ]
  assert.deepEqual(
    filterPlaylists(rows, '', ['spotify', 'spotify-liked']).map(
      (row) => row.id,
    ),
    ['playlist-1', 'liked'],
  )
  const html = render(
    <PlaylistsWorkspace />,
    [[['playlists'], rows]],
    'mediaType=album',
  )
  assert.match(html, /href="\/imports\/spotify-playlists\?mediaType=album"/)
})
