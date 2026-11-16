import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { PlaylistSummarySchema } from '@repo/schemas/tracks'
import { useArtistPlaylistFilter } from './artist-playlist-filter'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in artist playlist filter tests')
})
const playlist = PlaylistSummarySchema.parse({
  id: 'playlist-fixture',
  name: 'Synthetic mix',
  source: 'spotify',
  ownerName: null,
  description: null,
  artworkUrl: null,
  spotifyUrl: null,
  importedAt: '2026-01-01T00:00:00.000Z',
  trackCount: 5,
  linkedTrackCount: 2,
  albumCount: 1,
  durationSec: 900,
})

function Filter({ disabled = false }: { disabled?: boolean }) {
  const filter = useArtistPlaylistFilter(disabled)
  return (
    <>
      <output>{JSON.stringify(filter.filters)}</output>
      {filter.control}
    </>
  )
}

function render(
  children: ReactNode,
  search = '',
  cache: Array<[unknown[], unknown]> = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['playlists', 'artist-filter-count', ''], {
    totalCount: 1000,
  })
  client.setQueryData(['playlists', 'artist-filter', '', 1], {
    page: 1,
    size: 25,
    hasMore: true,
    items: [playlist],
  })
  for (const [key, value] of cache) client.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/artists">
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

test('playlist filter uses a searchable bounded viewport and marks the selected playlist', () => {
  const html = render(
    <Filter />,
    new URLSearchParams({
      playlistIds: JSON.stringify([playlist.id]),
    }).toString(),
  )
  assert.match(html, /aria-label="Search playlist filters"/)
  assert.match(html, /data-active="true"[^>]*aria-label="Filter Playlists"/)
  assert.match(html, /aria-label="Remove playlist filter: Synthetic mix"/)
  assert.match(html, /type="checkbox" checked=""/)
  assert.match(html, /1,000 playlists/)
  assert.match(html, /aria-setsize="1000"/)
  assert.ok((html.match(/<li/g) ?? []).length < 100)
  assert.doesNotMatch(html, /Select all|Import playlists|Add to playlist/)
})

test('selected names outside the loaded directory remain removable and duplicate ids collapse', () => {
  const selected = ['other-playlist']
  const html = render(
    <Filter />,
    new URLSearchParams({
      playlistIds: JSON.stringify([...selected, ...selected]),
    }).toString(),
    [
      [
        ['playlists', 'artist-filter-selected', selected],
        {
          page: 1,
          size: 1,
          hasMore: false,
          items: [
            { ...playlist, id: selected[0], name: 'Another synthetic mix' },
          ],
        },
      ],
    ],
  )
  assert.match(
    html,
    /aria-label="Remove playlist filter: Another synthetic mix"/,
  )
  assert.equal(
    (html.match(/aria-label="Remove playlist filter:/g) ?? []).length,
    1,
  )
  assert.doesNotMatch(html, /type="checkbox" checked=""/)
})

test('malformed or oversized saved playlist filters do not reach the artist query', () => {
  for (const playlistIds of [
    'invalid',
    JSON.stringify({ id: playlist.id }),
    JSON.stringify(
      Array.from({ length: 101 }, (_, index) => `playlist-${index}`),
    ),
  ]) {
    const html = render(
      <Filter />,
      new URLSearchParams({ playlistIds }).toString(),
    )
    assert.match(html, /<output><\/output>/)
    assert.doesNotMatch(html, /data-active="true"|Selected playlists/)
  }
})

test('disabled playlist filters cannot alter a pending selection', () => {
  const html = render(
    <Filter disabled />,
    new URLSearchParams({
      playlistIds: JSON.stringify([playlist.id]),
    }).toString(),
  )
  assert.match(html, /disabled="" aria-label="Filter Playlists"/)
  assert.match(html, /type="checkbox" disabled="" checked=""/)
  assert.match(
    html,
    /aria-label="Remove playlist filter: Synthetic mix"[^>]*disabled=""/,
  )
})

test('artist Browse preserves legacy playlist selection in shared browse state', async () => {
  const { ArtistsWorkspace } = await import('./creators-workspace')
  const playlistIds = JSON.stringify([playlist.id])
  const identity = JSON.stringify({
    q: '',
    filters: [],
    ranges: [],
    sortBy: 'name',
    direction: 'asc',
    playlistIds: [playlist.id],
  })
  const html = render(
    <ArtistsWorkspace />,
    new URLSearchParams({ playlistIds }).toString(),
    [
      [
        ['artists', 'browse', identity, 1],
        { items: [], totalCount: 0, page: 1, size: 100, hasMore: false },
      ],
    ],
  )
  assert.match(html, /Playlists: 1 selected/)
  assert.match(html, /0 artists/)
  assert.match(html, /No matches/)
})
