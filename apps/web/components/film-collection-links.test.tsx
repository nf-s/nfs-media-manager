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
import { AlbumDetailSchema, FilmDetailSchema } from '@repo/schemas/media'
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
const album = AlbumDetailSchema.parse({
  ...film,
  id: 'album-fixture',
  mediaType: 'album',
  slug: 'synthetic-album',
  title: 'Synthetic album',
  dateAdded: null,
  durationSec: null,
  spotifyUrl: null,
  trackCount: 0,
  tracks: [],
})

function render({
  search,
  cache,
  children,
  path = '/films',
}: {
  search: URLSearchParams
  cache: [unknown[], unknown][]
  children: ReactNode
  path?: string
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
          <PathnameContext.Provider value={path}>
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
  const href =
    /<a[^>]* href="([^"]+)"[^>]*><span class="ds-pill-label">Synthetic collection</.exec(
      html,
    )?.[1] ??
    /<a[^>]* href="([^"]+)"[^>]*>Synthetic collection<\/a>/.exec(html)?.[1]
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
  assert.match(
    html,
    /<a[^>]* data-workspace-href="\/collections\/stored-collection-17"[^>]*><span class="ds-pill-label">Synthetic collection/,
  )
  // Where a collection comes from is answered in Sources, not beside the pill.
  assert.ok(!html.includes(`href="${sourceUrl}"`))
  assert.match(
    html,
    /<span class="ds-pill" data-size="md"><span class="ds-pill-label">Name-only collection<\/span><\/span>/,
  )
  assert.match(html, /<h3>Collections<\/h3>/)
})

for (const item of [film, album]) {
  const { mediaType } = item
  const path = `/${mediaType}s`
  for (const view of ['table', 'list', 'grid']) {
    test(`${mediaType} Browse ${view} links to the stored collection`, async () => {
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
        path,
        search: new URLSearchParams({
          view,
          sortBy: 'collection',
          columns: 'title,collection',
        }),
        cache: [
          [
            [`${mediaType}s`, 'browse', identity, 1],
            { items: [item], totalCount: 1 },
          ],
        ],
        children: <MediaBrowser mediaType={mediaType} />,
      })
      // Grid size is in the Filters drawer, not on the toolbar.
      assert.doesNotMatch(html, /aria-label="Grid size"/)
      const target = collectionDestination(html)
      assert.equal(target.pathname, path)
      assert.equal(target.searchParams.get('view'), view)
      assert.equal(target.searchParams.has('filters'), false)
      assert.deepEqual(detailEntries(target.pathname, target.searchParams), [
        mediaType === 'album'
          ? { kind: 'collection', id: collection.id, mediaType }
          : { kind: 'collection', id: collection.id },
      ])
    })
  }
}
