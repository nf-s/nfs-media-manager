import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { filmBrowseFields } from '@repo/schemas/browse'
import { FilmDetailSchema } from '@repo/schemas/media'
import { detailEntries, type DetailEntry } from '@/utils/detail-inspector'
import { DetailInspectorProvider } from './detail-inspector-context'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in film collection link tests')
})
const collection = {
  id: 'stored-collection-17',
  name: 'Synthetic collection',
  kind: 'collection',
  position: 4,
}
const legacy = { name: 'Name-only collection', kind: 'collection', position: 7 }
const sourceUrl = 'https://example.test/collections/upstream-3'
const timestamp = '2026-01-01T00:00:00.000Z'
const film = FilmDetailSchema.parse({
  id: 'film-fixture',
  mediaType: 'film',
  slug: 'synthetic-film',
  title: 'Synthetic film',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [],
  links: [],
  providerReferences: [],
  playlists: [collection, legacy],
  collectionSources: [
    {
      name: collection.name,
      provider: 'fixture',
      providerLabel: 'Fixture',
      url: sourceUrl,
    },
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
  runtimeMinutes: 90,
  watched: true,
  sourceKind: null,
  budget: null,
  boxOffice: null,
})

function render({
  search,
  cache,
  children,
}: {
  search: URLSearchParams
  cache: [unknown[], unknown][]
  children: ReactNode
}) {
  const client = new QueryClient()
  for (const [key, data] of cache) client.setQueryData(key, data)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/films">
            <SearchParamsContext.Provider value={search}>
              <DetailInspectorProvider>{children}</DetailInspectorProvider>
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

function collectionDestination(html: string) {
  const href = /href="([^"]+)"[^>]*>Synthetic collection<\/a>/.exec(html)?.[1]
  assert.ok(href, 'Expected the collection name to link to its inspector')
  return new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
}

test('film details open the stored collection on top of the current inspector entry', async () => {
  const { default: MediaDetail } = await import('./media-detail')
  const entry: DetailEntry = { kind: 'film', id: film.id }
  const html = render({
    search: new URLSearchParams({
      q: 'synthetic',
      inspect: JSON.stringify([entry]),
    }),
    cache: [
      [['film', film.id], film],
      [['films', 'fields'], filmBrowseFields],
    ],
    children: <MediaDetail mediaType="film" id={film.id} />,
  })
  const target = collectionDestination(html)
  assert.equal(target.pathname, '/films')
  assert.equal(target.searchParams.get('q'), 'synthetic')
  assert.equal(target.searchParams.has('filters'), false)
  assert.deepEqual(detailEntries(target.pathname, target.searchParams), [
    entry,
    { kind: 'collection', id: collection.id },
  ])
  assert.ok(html.includes(`href="${sourceUrl}"`))
  assert.match(html, /<span class="metadata-tag">Name-only collection<\/span>/)
})

for (const view of ['table', 'list', 'grid']) {
  test(`film Browse ${view} links to the stored collection`, async () => {
    const { default: MediaBrowser } = await import('./media-browser')
    const identity = JSON.stringify({
      q: '',
      filters: [],
      ranges: [],
      sortBy: 'collection',
      direction: 'desc',
      includeArchived: false,
      limitResults: null,
    })
    const html = render({
      search: new URLSearchParams({
        view,
        sortBy: 'collection',
        columns: 'title,collection',
      }),
      cache: [
        [['films', 'browse', identity, 1], { items: [film], totalCount: 1 }],
      ],
      children: <MediaBrowser mediaType="film" />,
    })
    const target = collectionDestination(html)
    assert.equal(target.pathname, '/films')
    assert.equal(target.searchParams.get('view'), view)
    assert.equal(target.searchParams.has('filters'), false)
    assert.deepEqual(detailEntries(target.pathname, target.searchParams), [
      { kind: 'collection', id: collection.id },
    ])
  })
}
