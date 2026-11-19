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
import {
  AlbumCollectionDetailSchema,
  type AlbumCollectionBrowsePage,
  type AlbumCollectionDetail,
} from '@repo/schemas/album-collections'
import { ConfigContext } from './providers'
import CollectionsWorkspace from './collections-workspace'
import AppNavigation from './app-navigation'
import { DetailInspectorProvider } from './detail-inspector-context'
import { detailEntries } from '@/utils/detail-inspector'
import CollectionPageClient from './pages/collection-page-client'

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
const albumCollection = AlbumCollectionDetailSchema.parse({
  id: collection.id,
  name: 'Synthetic album collection',
  createdAt: collection.createdAt,
  albumCount: 2,
  sourceLinks: [
    {
      provider: 'fixture',
      providerLabel: 'Fixture',
      name: 'First destination',
      url: 'https://example.test/album-collections/17',
    },
    {
      provider: 'fixture',
      providerLabel: 'Fixture',
      name: 'Second destination',
      url: 'https://example.test/album-collections/18',
    },
  ],
  items: {
    ...collection.items,
    items: collection.items.items.map((item) => ({
      ...item,
      id: `${item.id}-album`,
      title: item.title.replace('film', 'album'),
      artists: ['Fixture artist'],
      durationSec: 1500,
    })),
  },
})

async function render(
  search: string,
  path = '/collections',
  directory: {
    page?: FilmCollectionBrowsePage | AlbumCollectionBrowsePage | null
    totalCount?: number
  } = {},
  members?: FilmCollectionDetail | AlbumCollectionDetail,
) {
  require.extensions['.css'] = (module) => {
    module.exports = {}
  }
  const { AppDetailInspector } = await import('./detail-inspector')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const params = new URLSearchParams(search)
  const mediaType = params.get('mediaType') === 'album' ? 'album' : 'film'
  const fixture = mediaType === 'album' ? albumCollection : collection
  const details = members ?? fixture
  const page =
    directory.page === undefined
      ? { items: [fixture], page: 1, size: 100, hasMore: false }
      : directory.page
  if (page)
    client.setQueryData(
      [`${mediaType}-collections`, 'browse', '', 'name', 'asc', false, 1],
      {
        ...page,
        totalCount: page.hasMore ? undefined : page.items.length,
      },
    )
  if (directory.totalCount !== undefined)
    client.setQueryData([`${mediaType}-collections`, 'browse-count', ''], {
      totalCount: directory.totalCount,
    })
  client.setQueryData(
    [`${mediaType}-collection`, fixture.id, 'position', 'asc', '', [], 1],
    { ...details.items, summary: { ...details, sourceLinks: [] } },
  )
  client.setQueryData(
    [`${mediaType}-collection`, fixture.id, 'sources'],
    details,
  )
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
            <SearchParamsContext.Provider value={params}>
              <DetailInspectorProvider>
                <AppNavigation />
                {path === `/collections/${fixture.id}` ? (
                  <CollectionPageClient collectionId={fixture.id} />
                ) : (
                  <CollectionsWorkspace />
                )}
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
    /aria-current="page" href="\/collections\?mediaType=film"><svg.*?<\/svg><span>Collections</,
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

test('a collection deep link opens its films in the Grid view with the density control', async () => {
  const html = await render('collection=collection')
  const drawer = html.slice(
    html.indexOf('aria-label="Film collection details"'),
  )
  assert.match(drawer, /aria-pressed="true" aria-label="Grid view"/)
  assert.match(
    drawer,
    /role="group" aria-label="Grid density"><button type="button" aria-pressed="false">Compact<\/button><button type="button" aria-pressed="true">Standard<\/button>/,
  )
  assert.match(
    drawer,
    /<article class="ds-card"><span class="ds-art" data-ratio="poster">/,
  )
  assert.doesNotMatch(drawer, /<thead>/)
})

test('collection deep links open members in source order without renumbering gaps', async () => {
  const entry = { kind: 'collection', id: 'collection', view: 'view=table' }
  const html = await render(
    new URLSearchParams({ inspect: JSON.stringify([entry]) }).toString(),
  )
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
  assert.match(
    drawer,
    /href="https:\/\/example.test\/collections\/17" target="_blank" rel="noopener noreferrer"[^>]*>Open on Fixture/,
  )
  assert.match(drawer, /aria-pressed="true" aria-label="Table view"/)
  assert.match(
    drawer,
    /href="\/films\?filters=[^"]*Synthetic\+collection[^"]*">Filter films</,
  )

  assert.match(
    drawer,
    /aria-sort="ascending"><div[^>]*><button[^>]*title="Sort by Stored position"/,
  )
  assert.match(drawer, /<td[^>]*data-align="end"[^>]*>2<\/td>/)
  assert.match(drawer, /<td[^>]*data-align="end"[^>]*>8<\/td>/)
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
    const cardCount = (drawer.match(/class="browse-nested-item"/g) ?? []).length
    assert.ok(cardCount > 0 && cardCount < 40, `Rendered ${cardCount} cards`)
    assert.match(drawer, /305 films/)
    assert.match(drawer, /aria-posinset="1" aria-setsize="305"/)
    const label = view === 'grid' ? 'Grid' : 'List'
    assert.match(
      drawer,
      new RegExp(`aria-pressed="true" aria-label="${label} view"`),
    )
    assert.match(drawer, /aria-label="Sort by"/)
    assert.match(drawer, />Filters(?: · \d+)?<\/button>/)
    assert.match(drawer, /Position 2/)
    assert.match(drawer, /1h 30m · Unwatched/)
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
    // The same films in Browse, in the view the list has now.
    const browse = /href="([^"]+)"[^>]*>Show in Films<\/a>/.exec(drawer)?.[1]
    assert.ok(browse)
    const films = new URL(browse.replaceAll('&amp;', '&'), 'http://localhost')
    assert.equal(films.pathname, '/films')
    assert.deepEqual(JSON.parse(films.searchParams.get('filters') ?? ''), [
      { field: 'collection', value: collection.name, mode: 'required' },
    ])
    assert.equal(films.searchParams.get('view'), view)
  }
})

test('collection Sources displays only saved collection destinations', async () => {
  const html = await render('collection=collection&tab=sources')
  const drawer = html.slice(
    html.indexOf('aria-label="Film collection details"'),
  )
  const table = drawer.slice(drawer.indexOf('aria-label="Sources"'))
  assert.match(drawer, /role="tab" aria-selected="true"[^>]*>Sources/)
  assert.match(table, />Fixture</)
  assert.match(table, /href="https:\/\/example.test\/collections\/17"/)
  assert.doesNotMatch(drawer, /aria-label="Collection films"|Refresh selected/)
})

test('album and track navigation retain Playlists and only Albums gains Collections', async () => {
  for (const path of ['/albums', '/tracks']) {
    const html = await render('', path)
    assert.match(
      html,
      path === '/tracks'
        ? /href="\/playlists\?mediaType=track"><svg.*?<\/svg><span>Playlists</
        : /href="\/playlists\?mediaType=album"><svg.*?<\/svg><span>Playlists</,
    )
    const nav = html.slice(0, html.indexOf('</nav>'))
    if (path === '/albums')
      assert.match(
        nav,
        /href="\/collections\?mediaType=album"><svg.*?<\/svg><span>Collections/,
      )
    else assert.doesNotMatch(nav, /href="\/collections/)
  }
})

test('the album collection directory opens a scoped collection with album actions', async () => {
  const html = await render('mediaType=album')
  assert.match(html, /aria-label="Album collections"/)
  assert.match(html, /title="Sort by Albums"/)
  assert.match(html, /title="Filter albums by Synthetic album collection"/)
  const href = /href="([^"]+)"[^>]*>Synthetic album collection<\/a>/.exec(
    html,
  )?.[1]
  assert.ok(href)
  const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
  assert.equal(url.searchParams.get('mediaType'), 'album')
  assert.deepEqual(detailEntries(url.pathname, url.searchParams), [
    { kind: 'collection', id: albumCollection.id, mediaType: 'album' },
  ])
})

test('album collection details open albums and expose each saved destination', async () => {
  const entry = {
    kind: 'collection',
    id: albumCollection.id,
    mediaType: 'album',
    view: 'view=table',
  }
  const search = new URLSearchParams({
    mediaType: 'album',
    inspect: JSON.stringify([entry]),
  })
  const html = await render(search.toString())
  const inspector = html.slice(
    html.indexOf('aria-label="Album collection details"'),
  )
  assert.match(inspector, /aria-label="Search collection albums"/)
  assert.match(inspector, /title="Sort by Artists"/)
  assert.match(inspector, /25:00/)
  assert.match(inspector, /Fixture artist/)
  assert.doesNotMatch(inspector, /Filter Watched|Sort by Runtime/)
  assert.match(inspector, /href="\/albums\?filters=[^"]*">Filter albums/)
  for (const [index, link] of albumCollection.sourceLinks.entries())
    assert.ok(
      inspector.includes(
        `href="${link.url}" target="_blank" rel="noopener noreferrer" aria-label="Open on Fixture (${index + 1}) (opens in a new tab)"`,
      ),
    )
  const href = /href="([^"]+)">Z first album<\/a>/.exec(inspector)?.[1]
  assert.ok(href)
  const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
  assert.deepEqual(detailEntries(url.pathname, url.searchParams), [
    entry,
    { kind: 'album', id: 'later-title-album' },
  ])
  assert.match(
    inspector,
    /href="\/collections\/collection\?mediaType=album&amp;view=table"[^>]*>Open page/,
  )
})

test('standalone collections expose the saved destination and the scoped return link', async () => {
  for (const mediaType of ['film', 'album']) {
    const sources =
      mediaType === 'album'
        ? albumCollection.sourceLinks
        : collection.sourceLinks
    const html = await render(
      `mediaType=${mediaType}`,
      '/collections/collection',
    )
    assert.ok(html.includes(`href="/collections?mediaType=${mediaType}"`))
    assert.ok(sources.every(({ url }) => html.includes(`href="${url}"`)))
  }
})
