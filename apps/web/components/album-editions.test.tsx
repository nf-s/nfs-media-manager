import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { albumBrowseFields } from '@repo/schemas/browse'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import { AlbumDetailSchema } from '@repo/schemas/media'
import { libraryChangesKey } from '@/utils/library-changes'
import AlbumEditions from './album-editions'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}
const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in album edition tests')
})

const timestamp = '2026-01-01T00:00:00.000Z'
const edition = (id: string, title: string, scrobbles: number) => ({
  id,
  slug: id,
  title,
  artworkUrl: null,
  releaseDate: '2021-03-04',
  trackCount: 12,
  scrobbles,
})
const first = AlbumDetailSchema.parse({
  id: 'harbour',
  mediaType: 'album',
  slug: 'harbour',
  title: 'Harbour Lights',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: '2020-02-02',
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  dateAdded: null,
  durationSec: null,
  spotifyUrl: null,
  trackCount: 10,
  tracks: [],
  editionOfId: null,
  editionCount: 2,
  editions: [
    edition('harbour-deluxe', 'Harbour Lights (Deluxe)', 1204),
    edition('harbour-live', 'Harbour Lights (Live)', 3),
  ],
  editionOf: null,
})
const deluxe = AlbumDetailSchema.parse({
  ...first,
  id: 'harbour-deluxe',
  title: 'Harbour Lights (Deluxe)',
  editionOfId: 'harbour',
  editionCount: 0,
  editions: [],
  editionOf: edition('harbour', 'Harbour Lights', 40),
})
const single = AlbumDetailSchema.parse({
  ...first,
  editionCount: 0,
  editions: [],
})

function render(
  children: ReactNode,
  cache: [unknown[], unknown][] = [],
  search = '',
) {
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
          <PathnameContext.Provider value={`/albums/${first.id}`}>
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

test('a first album lists its editions, each a link with Separate', () => {
  const html = render(<AlbumEditions album={first} />)
  assert.match(html, /<h3>Editions<\/h3><span class="ds-muted">2<\/span>/)
  assert.match(html, /aria-label="Editions of Harbour Lights"/)
  assert.match(
    html,
    /<a class="ds-cell-title" title="Harbour Lights \(Deluxe\)" href="\/albums\/harbour-deluxe">Harbour Lights \(Deluxe\)<\/a>/,
  )
  assert.match(html, /<span class="ds-num">2021-03-04<\/span>/)
  assert.match(html, /<td data-align="end">1,204<\/td>/)
  assert.match(
    html,
    /<button[^>]*aria-label="Separate Harbour Lights \(Deluxe\)"[^>]*>Separate<\/button>/,
  )
  assert.match(html, /aria-label="Separate Harbour Lights \(Live\)"/)
})

test('an edition names its first album, linked, with Separate for itself', () => {
  const html = render(<AlbumEditions album={deluxe} />)
  assert.match(html, /<h3>Edition of<\/h3>/)
  assert.match(
    html,
    /<button[^>]*aria-label="Separate Harbour Lights \(Deluxe\) from Harbour Lights"[^>]*>Separate<\/button>/,
  )
  assert.match(html, /href="\/albums\/harbour">Harbour Lights<\/a>/)
  // The first album's row has no Separate of its own.
  assert.equal(html.match(/>Separate</g)?.length, 1)
})

test('an album of its own record shows no editions', () => {
  assert.equal(render(<AlbumEditions album={single} />), '')
})

test('the album page names the record in its header and lists editions and changes in Sources', async () => {
  const { default: MediaDetail } = await import('./media-detail')
  const change = LibraryChangeSchema.parse({
    id: 'change-1',
    kind: 'album',
    action: 'separate',
    actor: 'owner',
    rule: null,
    batchId: null,
    target: null,
    sources: [
      {
        id: 'harbour',
        title: 'Harbour Lights',
        by: 'Fixture Artist',
        exists: true,
      },
    ],
    names: [],
    nameCount: 0,
    scrobbles: 0,
    details: { counts: { edition: 1 }, labels: ['Harbour Lights (Demo)'] },
    createdAt: timestamp,
    undoneAt: null,
    reversible: true,
    canUndo: true,
    canRedo: false,
    blocked: null,
  })
  const page = (album: typeof first, search = '') =>
    render(
      <MediaDetail mediaType="album" id={album.id} />,
      [
        [['album', album.id], album],
        [['albums', 'fields'], albumBrowseFields],
        [
          libraryChangesKey({ kind: 'album', recordId: album.id, size: 10 }),
          { items: [change], page: 1, size: 10, totalCount: 1, hasMore: false },
        ],
      ],
      search,
    )
  const header = page(deluxe)
  assert.match(
    header,
    /Edition of <a[^>]*href="\/albums\/harbour"[^>]*>Harbour Lights<\/a>/,
  )
  assert.match(page(first), />2 editions</)
  const sources = page(first, 'tab=sources')
  assert.match(sources, /aria-label="Editions of Harbour Lights"/)
  // The Changes list follows the sources, as on a track's page.
  assert.match(
    sources,
    /<h3>Editions<\/h3>.*<h3>Changes<\/h3>.*Separated “Harbour Lights \(Demo\)” from “Harbour Lights”.*>Undo<\/button>/,
  )
})
