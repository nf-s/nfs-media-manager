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
  assert.match(html, /Filters/)
  for (const view of ['Grid', 'List', 'Table'])
    assert.match(html, new RegExp(`aria-label="${view} view"`))
  for (const field of artistBrowseFields)
    assert.ok(html.includes(`<option value="${field.key}"`))
  assert.match(html, /250 artists/)
  assert.match(html, /data-view="list"/)
})

test('Artists list uses 48px rows: round thumbnail, title, country, tag pills and counts', async () => {
  const html = await render()
  assert.match(html, /class="ds-listhead"/)
  assert.match(
    html,
    /<div class="ds-row" data-item-index="0"><a class="bi-thumb-link" aria-label="Open details for Example Artist" tabindex="-1" href="\/artists\/artist-example"><span class="ds-thumb" data-ratio="round">/,
  )
  assert.match(
    html,
    /<a class="ds-row-title" title="Example Artist" href="\/artists\/artist-example">Example Artist<\/a><span class="ds-row-by">GB<\/span>/,
  )
  assert.match(html, /title="Tag: Jazz" class="ds-pill"/)
  assert.match(
    html,
    /<span class="ds-w-num">4<\/span><span class="ds-w-num">12<\/span><span class="ds-w-num">2<\/span>/,
  )
  assert.ok((html.match(/data-placeholder=""/g) ?? []).length > 0)
  assert.doesNotMatch(html, /onDoubleClick|media-tile|list-row|browse-table/)
})

test('Artists grid uses clean round artwork cards with a meta line and tags', async () => {
  const grid = await render('view=grid')
  assert.match(grid, /data-view="grid"/)
  assert.match(grid, /<article class="ds-card" data-item-index="0">/)
  assert.match(grid, /<span class="ds-art" data-ratio="round">/)
  assert.match(grid, /aria-label="Open details for Example Artist"/)
  assert.match(grid, /<span class="ds-card-by">GB<\/span>/)
  assert.match(
    grid,
    /<span class="ds-card-meta"><span>4 albums<\/span><span>12 tracks<\/span><\/span>/,
  )
  assert.match(grid, /title="Tag: Jazz"/)
  assert.doesNotMatch(grid, /ds-play/)
  const sorted = await render('view=grid&sortBy=createdAt&direction=desc')
  assert.match(sorted, /<span>Added 2026-03-0[12]<\/span>/)
})

test('Artists Table pins the name, right-aligns counts and sorts through the shared header', async () => {
  const table = await render(
    'view=table&columns=country,albumCount&sortBy=albumCount&direction=desc',
  )
  assert.match(table, /<table class="ds-table" data-layout="fixed"/)
  assert.match(
    table,
    /<th scope="col" data-sticky="edge" style="--ds-sticky-left:0px"><button type="button" class="ds-th-sort" title="Sort by Artist">Artist<\/button>/,
  )
  assert.match(
    table,
    /data-align="end" aria-sort="descending"><button type="button" class="ds-th-sort" title="Sort by Albums">Albums<svg/,
  )
  assert.doesNotMatch(table, /[↑↓]/)
  assert.match(table, /title="Filter Country: GB"/)
  assert.match(table, /<td data-align="end" title="4">4<\/td>/)
  assert.match(table, /aria-label="Resize Albums"/)
  assert.doesNotMatch(table, /Resize Tracks/)
  const defaults = await render('view=table')
  const heads = [...defaults.matchAll(/title="Sort by ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, [
    'Artist',
    'Country',
    'Added',
    'Albums',
    'Tracks',
    'Tags',
  ])
  assert.match(defaults, /<td title="2026-03-01">2026-03-01<\/td>/)
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
  assert.match(html, /data-mode="exclude"/)
  assert.match(html, /data-mode="required"/)
  assert.match(html, /Albums: 2 to \*/)
  assert.match(html, /Playlists: 1 selected/)
  assert.match(html, /Limit: 30/)
  assert.match(html, /No artists match/)
  assert.match(html, />Clear filters</)
  assert.match(html, />Clear all</)
})

test('an empty library says so without offering to clear filters', async () => {
  const html = await render('', 0)
  assert.match(html, /<strong>No artists yet<\/strong>/)
  assert.doesNotMatch(html, /Clear filters/)
})
