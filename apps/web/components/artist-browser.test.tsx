import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ArtistQuerySchema, ArtistSummarySchema } from '@repo/schemas/creators'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}
const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})
const artist = ArtistSummarySchema.parse({
  id: 'artist-example',
  name: 'Example Artist',
  sortName: null,
  createdAt: '2026-03-01T00:00:00.000Z',
  artworkUrl: null,
  albumCount: 4,
  trackCount: 12,
  playlistCount: 2,
  browse: { genre: ['Jazz'], country: ['GB'], playlist: ['Morning'] },
})

async function render(search = '', total = 250) {
  const { default: ArtistBrowser } = await import('./artist-browser')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const params = new URLSearchParams(search)
  const parsed = ArtistQuerySchema.parse(Object.fromEntries(params))
  const identity = JSON.stringify({
    q: parsed.q ?? '',
    filters: parsed.filters,
    ranges: parsed.ranges,
    sortBy: parsed.sortBy,
    direction: parsed.direction,
    playlistIds: parsed.playlistIds,
    limitResults: parsed.limitResults,
  })
  client.setQueryData(['ai-status'], { available: true, reason: null })
  client.setQueryData(['artists', 'fields'], artistBrowseFields)
  client.setQueryData(['artists', 'browse', identity, 1], {
    items: total ? [artist] : [],
    page: 1,
    size: 100,
    hasMore: total > 100,
    totalCount: total,
  })
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
            <SearchParamsContext.Provider value={params}>
              <ArtistBrowser />
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

test('Artists Browse has the shared full search, voice, filters, sorts and view controls', async () => {
  const html = await render()
  assert.match(
    html,
    /placeholder="Search artists, playlists, tags, countries..."/,
  )
  assert.match(html, /aria-label="Record search"/)
  assert.match(html, /aria-label="Sort by"/)
  assert.match(html, /aria-label="Sort descending"/)
  assert.match(html, / Filters<\/button>/)
  for (const view of ['Grid', 'List', 'Table'])
    assert.match(html, new RegExp(`aria-label="${view} view"`))
  for (const field of artistBrowseFields)
    assert.ok(html.includes(`<option value="${field.key}"`))
  assert.match(html, /250 artists/)
  assert.match(html, /data-view="list"/)
  assert.match(html, />Example Artist<\/button>/)
  assert.match(html, /4 albums · 12 tracks · 2 playlists/)
  assert.match(html, /title="Tag: Jazz">Jazz<\/button>/)
  assert.ok((html.match(/virtual-browse-placeholder/g) ?? []).length > 0)
})

test('Artists grid uses artwork cards and Table has sortable required name and selected columns', async () => {
  const grid = await render('view=grid')
  assert.match(grid, /data-view="grid"/)
  assert.match(grid, /class="media-tile"/)
  assert.match(grid, /aria-label="Open details for Example Artist"/)
  const table = await render(
    'view=table&columns=country,albumCount&sortBy=albumCount&direction=desc',
  )
  assert.match(table, /<table class="browse-table"/)
  assert.match(table, /aria-sort="descending"><button>Albums ↓<\/button>/)
  assert.match(table, />Artist<\/button>/)
  assert.match(table, /title="Filter Country: GB">GB<\/button>/)
  assert.doesNotMatch(table, /Resize Tracks/)
})

test('mixed filters, ranges, limits and legacy playlist scopes stay visible with no results', async () => {
  const search = new URLSearchParams({
    q: 'rare artist',
    filters: JSON.stringify([
      { field: 'genre', value: 'Jazz', mode: 'exclude' },
      { field: 'playlist', value: 'Morning', mode: 'required' },
    ]),
    ranges: JSON.stringify([
      { field: 'albumCount', min: 2, includeMissing: false },
    ]),
    playlistIds: JSON.stringify(['playlist-example']),
    limitResults: '30',
  }).toString()
  const html = await render(search, 0)
  assert.match(html, /Search: rare artist/)
  assert.match(html, /filter-exclude/)
  assert.match(html, /filter-required/)
  assert.match(html, /Albums: 2 to \*/)
  assert.match(html, /Playlists: 1 selected/)
  assert.match(html, /Limit: 30/)
  assert.match(html, /No matches/)
})
