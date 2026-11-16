import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  FilmCollectionDetailSchema,
  type FilmCollectionBrowsePage,
  type FilmCollectionDetail,
} from '@repo/schemas/film-collections'
import { ConfigContext } from './providers'
import FilmCollectionsWorkspace from './film-collections-workspace'
import AppNavigation from './app-navigation'
import { DetailInspectorProvider } from './detail-inspector-context'
import { detailEntries } from '@/utils/detail-inspector'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in collection UI tests')
})
const collection = FilmCollectionDetailSchema.parse({
  id: 'collection',
  name: 'Synthetic collection',
  createdAt: '2026-01-01T00:00:00.000Z',
  filmCount: 2,
  sourceLinks: [
    {
      provider: 'fixture',
      providerLabel: 'Fixture',
      name: 'Synthetic collection',
      url: 'https://example.test/collections/17',
    },
  ],
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

async function render(
  search: string,
  path = '/collections',
  directory: {
    page?: FilmCollectionBrowsePage | null
    totalCount?: number
  } = {},
  members: FilmCollectionDetail = collection,
) {
  require.extensions['.css'] = (module) => {
    module.exports = {}
  }
  const { AppDetailInspector } = await import('./detail-inspector')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const page =
    directory.page === undefined
      ? { items: [collection], page: 1, size: 100, hasMore: false }
      : directory.page
  if (page)
    client.setQueryData(
      ['film-collections', 'browse', '', 'name', 'asc', false, 1],
      {
        ...page,
        totalCount: page.hasMore ? undefined : page.items.length,
      },
    )
  if (directory.totalCount !== undefined)
    client.setQueryData(['film-collections', 'browse-count', ''], {
      totalCount: directory.totalCount,
    })
  client.setQueryData(
    ['film-collection', collection.id, 'position', 'asc', '', [], 1],
    { ...members.items, summary: { ...members, sourceLinks: [] } },
  )
  client.setQueryData(['film-collection', collection.id, 'sources'], collection)
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
              <DetailInspectorProvider>
                <AppNavigation />
                <FilmCollectionsWorkspace />
                <AppDetailInspector />
              </DetailInspectorProvider>
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

test('the collection directory renders a bounded window before and after counting', async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    ...collection,
    id: `collection-${index + 1}`,
    name: `Fixture collection ${index + 1}`,
  }))
  const page = { items, page: 1, size: 100, hasMore: true }
  for (const totalCount of [undefined, 305]) {
    const html = await render('', '/collections', { page, totalCount })
    const rowCount = (
      html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr\b/g) ?? []
    ).length
    assert.ok(
      rowCount <= 30,
      `Expected the visible window, rendered ${rowCount} rows`,
    )
    assert.match(html, /aria-rowindex="2"[^>]*>.*?>Fixture collection 1<\/a>/)
    assert.ok(!html.includes('Fixture collection 100'))
    if (totalCount === undefined) {
      assert.match(html, /Counting collections/)
      assert.doesNotMatch(html, /aria-rowcount=/)
    } else {
      assert.match(html, /305 collections/)
      assert.match(html, /aria-rowcount="306"/)
      assert.match(html, /style="height:9152px;padding:0;border:0"/)
    }
  }
})

test('the collection directory reserves initial row placeholders', async () => {
  const html = await render('', '/collections', { page: null })
  assert.match(html, /Loading collections/)
  assert.equal(
    (html.match(/class="virtual-browse-placeholder"/g) ?? []).length,
    14,
  )
  assert.doesNotMatch(html, /aria-rowcount=/)
})

test('Films navigation exposes Collections and its shared sortable table controls', async () => {
  const html = await render('')
  assert.match(
    html,
    /aria-current="page" href="\/collections\?mediaType=film">Collections/,
  )
  assert.match(html, /aria-label="Search collections"/)
  assert.match(html, /secondary-table-scroll/)
  assert.match(html, /title="Sort by Collection"/)
  assert.match(html, /title="Sort by Films"/)
  assert.match(html, /aria-label="Visible columns"/)
  assert.match(html, />Source<\/label>/)
  assert.match(html, />Added<\/label>/)
  assert.doesNotMatch(html, /aria-label="Film collection details"/)
  assert.doesNotMatch(html, /href="https:\/\/example.test\/collections\/17"/)
  assert.match(html, /title="Filter films by Synthetic collection"/)
})

test('collection deep links open members in source order without renumbering gaps', async () => {
  const html = await render('collection=collection')
  const drawer = html.slice(
    html.indexOf('aria-label="Film collection details"'),
  )
  assert.match(drawer, /Synthetic collection/)
  assert.match(drawer, /aria-label="Collection films"/)
  assert.ok(
    drawer.indexOf('aria-label="Search collection films"') <
      drawer.indexOf('<thead>'),
  )
  assert.ok(
    drawer.indexOf('aria-label="Filter Watched"') > drawer.indexOf('<thead>'),
  )
  assert.match(drawer, /aria-label="Resize details panel"/)
  assert.doesNotMatch(drawer, /href="https:\/\/example.test\/collections\/17"/)
  assert.match(drawer, /aria-label="Table view" aria-pressed="true"/)
  assert.match(
    drawer,
    /href="\/films\?filters=[^"]*Synthetic\+collection[^"]*">Filter films</,
  )

  assert.match(
    drawer,
    /aria-sort="ascending"><div[^>]*><button[^>]*title="Sort by Stored position"/,
  )
  assert.match(drawer, /<td class="numeric">2<\/td>/)
  assert.match(drawer, /<td class="numeric">8<\/td>/)
  assert.ok(drawer.indexOf('Z first film') < drawer.indexOf('A later film'))
  const memberHref = /href="([^"]+)">Z first film<\/a>/.exec(drawer)?.[1]
  assert.ok(memberHref)
  const url = new URL(memberHref.replaceAll('&amp;', '&'), 'http://localhost')
  assert.equal(url.pathname, '/collections')
  assert.deepEqual(
    detailEntries(url.pathname, url.searchParams).map(({ kind, id }) => ({
      kind,
      id,
    })),
    [
      { kind: 'collection', id: 'collection' },
      { kind: 'film', id: 'later-title' },
    ],
  )
  for (const label of ['Film', 'Released', 'Runtime', 'Watched'])
    assert.ok(drawer.includes(`title="Sort by ${label}"`))
  assert.match(
    drawer,
    /Older imports may not contain the source&#x27;s film order/,
  )
  assert.match(drawer, /aria-label="Close details"/)
})

test('collection card views retain filtering, nested links, and bounded rendering', async () => {
  const seed = collection.items.items[0]
  assert.ok(seed)
  const members = FilmCollectionDetailSchema.parse({
    ...collection,
    filmCount: 305,
    items: {
      ...collection.items,
      totalCount: 305,
      pageCount: 4,
      items: Array.from({ length: 100 }, (_, index) => ({
        ...seed,
        title: `Fixture film ${index + 1}`,
        id: `film-${index + 1}`,
      })),
    },
  })
  for (const view of ['grid', 'list']) {
    const entry = {
      kind: 'collection',
      id: collection.id,
      view: `view=${view}`,
    }
    const search = new URLSearchParams({ inspect: JSON.stringify([entry]) })
    const html = await render(search.toString(), '/collections', {}, members)
    const drawer = html.slice(
      html.indexOf('aria-label="Film collection details"'),
    )
    const cardCount = (drawer.match(/class="nested-media-card"/g) ?? []).length
    assert.ok(cardCount > 0 && cardCount < 40, `Rendered ${cardCount} cards`)
    assert.match(drawer, /305 films/)
    assert.match(drawer, /aria-posinset="1" aria-setsize="305"/)
    const label = view === 'grid' ? 'Grid' : 'List'
    assert.match(
      drawer,
      new RegExp(`aria-label="${label} view" aria-pressed="true"`),
    )
    assert.match(drawer, /aria-label="Sort by"/)
    assert.match(drawer, / Filters(?:<span|<\/button)/)
    assert.match(drawer, /Position 2/)
    assert.match(drawer, /90 min · Unwatched/)
    assert.doesNotMatch(drawer, /Fixture film 100|Visible columns/)
    const href = /<a[^>]* href="([^"]+)"[^>]*>Fixture film 1<\/a>/.exec(
      drawer,
    )?.[1]
    assert.ok(href)
    const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
    assert.deepEqual(detailEntries(url.pathname, url.searchParams), [
      entry,
      { kind: 'film', id: 'film-1' },
    ])
  }
})

test('collection Sources displays only saved collection destinations', async () => {
  const html = await render('collection=collection&tab=sources')
  const drawer = html.slice(
    html.indexOf('aria-label="Film collection details"'),
  )
  const table = drawer.slice(drawer.indexOf('<table'))
  assert.match(table, /aria-label="Sources"/)
  assert.match(table, />Fixture</)
  assert.match(table, /href="https:\/\/example.test\/collections\/17"/)
  assert.doesNotMatch(drawer, /aria-label="Collection films"|Refresh selected/)
})

test('album and track navigation retain Playlists', async () => {
  for (const path of ['/albums', '/tracks']) {
    const html = await render('', path)
    assert.match(
      html,
      path === '/tracks'
        ? /href="\/playlists\?mediaType=track">Playlists/
        : /href="\/playlists\?mediaType=album">Playlists/,
    )
    assert.doesNotMatch(
      html.slice(0, html.indexOf('</nav>')),
      /href="\/collections/,
    )
  }
})
