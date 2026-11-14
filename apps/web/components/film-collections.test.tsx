import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { FilmCollectionDetailSchema } from '@repo/schemas/film-collections'
import { ConfigContext } from './providers'
import FilmCollectionsWorkspace from './film-collections-workspace'
import AppNavigation from './app-navigation'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in collection UI tests')
})
const collection = FilmCollectionDetailSchema.parse({
  id: 'collection',
  name: 'Synthetic collection',
  createdAt: '2026-01-01T00:00:00.000Z',
  filmCount: 2,
  items: {
    page: 1,
    size: 100,
    totalCount: 2,
    pageCount: 1,
    items: [
      {
        id: 'later-title',
        position: 2,
        title: 'Z first film',
        artworkUrl: null,
        releaseDate: null,
        runtimeMinutes: 90,
        watched: false,
        source: null,
        dateAdded: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'earlier-title',
        position: 8,
        title: 'A later film',
        artworkUrl: null,
        releaseDate: null,
        runtimeMinutes: 120,
        watched: true,
        source: null,
        dateAdded: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
})

function render(search: string, path = '/collections') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['film-collections'], [collection])
  client.setQueryData(['film-collection', collection.id, 'position', 'asc'], {
    pages: [collection],
    pageParams: [1],
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
          <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              <AppNavigation />
              <FilmCollectionsWorkspace />
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

test('Films navigation exposes Collections and its shared sortable table controls', () => {
  const html = render('')
  assert.match(
    html,
    /aria-current="page" href="\/collections\?mediaType=film">Collections/,
  )
  assert.match(html, /aria-label="Search collections"/)
  assert.match(html, /secondary-table-scroll/)
  assert.match(html, /title="Sort by Collection"/)
  assert.match(html, /title="Sort by Films"/)
  assert.match(html, /aria-label="Visible columns"/)
  assert.doesNotMatch(html, /aria-label="Collection details"/)
})

test('collection deep links open members in source order without renumbering gaps', () => {
  const html = render('collection=collection')
  const drawer = html.slice(html.indexOf('aria-label="Collection details"'))
  assert.match(drawer, /Synthetic collection/)
  assert.match(drawer, /aria-label="Collection films"/)
  assert.match(
    drawer,
    /aria-sort="ascending"><button[^>]*title="Sort by Stored position"/,
  )
  assert.match(drawer, /<td class="numeric">2<\/td>/)
  assert.match(drawer, /<td class="numeric">8<\/td>/)
  assert.ok(drawer.indexOf('Z first film') < drawer.indexOf('A later film'))
  assert.match(drawer, /href="\/films\?item=later-title"/)
  for (const label of ['Film', 'Released', 'Runtime', 'Watched'])
    assert.ok(drawer.includes(`title="Sort by ${label}"`))
  assert.match(
    drawer,
    /Older imports may not contain the source&#x27;s film order/,
  )
  assert.match(drawer, /aria-label="Close details"/)
})

test('album and track navigation retain Playlists', () => {
  for (const path of ['/albums', '/tracks']) {
    const html = render('', path)
    assert.match(html, /href="\/playlists\?mediaType=album">Playlists/)
    assert.doesNotMatch(html, /href="\/collections/)
  }
})
