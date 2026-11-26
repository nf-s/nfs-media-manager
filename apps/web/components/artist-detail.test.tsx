import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ArtistDetailSchema } from '@repo/schemas/creators'
import { SpotifyArtistAlbumListingSchema } from '@repo/schemas/spotify-artist-albums'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import { libraryChangesKey } from '@/utils/library-changes'
import type {
  ArtistDetail as ArtistDetailComponent,
  keptArtistHref as keptArtistHrefFunction,
} from './artist-detail'
import { ConfigContext } from './providers'

// Node cannot load the Browse CSS modules. The rendered class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in artist detail UI tests')
})

let ArtistDetail: typeof ArtistDetailComponent
let keptArtistHref: typeof keptArtistHrefFunction
before(async () => {
  const detail = await import('./artist-detail')
  ArtistDetail = detail.ArtistDetail
  keptArtistHref = detail.keptArtistHref
})

const timestamp = '2026-01-01T00:00:00.000Z'
const kept = ArtistDetailSchema.parse({
  id: 'artist-lowlands',
  name: 'The Lowlands',
  sortName: null,
  artworkUrl: null,
  profile: { tags: [] },
  providers: [],
  identifiers: [],
  history: [],
  createdAt: timestamp,
  albumCount: 2,
  trackCount: 9,
  playlistCount: 0,
  keptNames: [
    { id: 'artist-lowlands-2', name: 'Lowlands' },
    { id: 'artist-lowlands-3', name: 'The Low Lands' },
  ],
})

const merge = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'artist',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: {
    id: kept.id,
    title: kept.name,
    by: '',
    exists: true,
  },
  sources: [
    { id: 'artist-lowlands-2', title: 'Lowlands', by: '', exists: false },
  ],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  details: { counts: { credit: 4, 'artist-name': 1 }, labels: ['Lowlands'] },
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
})

function render(
  requestedId: string,
  search = '',
  cache: [readonly unknown[], unknown][] = [],
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
          <PathnameContext.Provider value={`/artists/${requestedId}`}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              <ArtistDetail id={requestedId} />
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

test('an artist page lists the names merged into the artist among its facts', () => {
  const html = render(kept.id, '', [[['artist', kept.id], kept]])
  assert.match(
    html,
    /<div class="ds-detail-facts"><span>2 albums<\/span><span>9 tracks<\/span><span>Also known as “Lowlands”, “The Low Lands”<\/span><\/div>/,
  )
  const plain = render(kept.id, '', [
    [['artist', kept.id], ArtistDetailSchema.parse({ ...kept, keptNames: [] })],
  ])
  assert.doesNotMatch(plain, /Also known as/)
})

test('a merged name’s page shows the artist it was merged into', () => {
  // The server answers a merged ID with the kept artist.
  const html = render('artist-lowlands-2', '', [
    [['artist', 'artist-lowlands-2'], kept],
  ])
  assert.match(html, /<h2 class="ds-detail-title">The Lowlands<\/h2>/)
})

test('the artist album control shows the page while the notice gives counts and evidence', () => {
  const listing = SpotifyArtistAlbumListingSchema.parse({
    market: 'AU',
    artistUrl: 'https://open.spotify.com/artist/1234567890ABCDEFGHIJKL',
    unavailableReason: null,
    retryAt: null,
    pagesSaved: 1,
    releasesSeen: 5,
    expectedTotal: null,
    completedAt: null,
    job: {
      jobId: 'synthetic-listing',
      status: 'running',
      errorMessage: null,
      finishedAt: null,
    },
  })
  const html = render(kept.id, 'tab=albums', [
    [['artist', kept.id], kept],
    [['artist', kept.id, 'spotify-albums'], listing],
  ])
  assert.match(
    html,
    /data-feedback="running"[^>]*aria-label="Fetching page 2 · Fetch albums"/,
  )
  assert.equal(
    (html.replace(/<[^>]*>/g, '').match(/Fetching page 2/g) ?? []).length,
    1,
  )
  assert.match(html, /1 page saved · 5 release entries/)
  assert.match(html, /View listing job/)
})

test('the kept artist’s URL replaces the merged name’s and keeps the view', () => {
  assert.equal(
    keptArtistHref(kept.id, { search: '?tab=sources', hash: '#changes' }),
    '/artists/artist-lowlands?tab=sources#changes',
  )
  assert.equal(
    keptArtistHref('artist/with space', { search: '', hash: '' }),
    '/artists/artist%2Fwith%20space',
  )
})

test('an artist’s Sources tab ends with its Changes list', () => {
  const html = render(kept.id, 'tab=sources', [
    [['artist', kept.id], kept],
    [
      libraryChangesKey({ kind: 'artist', recordId: kept.id, size: 10 }),
      { page: 1, size: 10, totalCount: 1, pageCount: 1, items: [merge] },
    ],
  ])
  assert.match(html, />Changes</)
  assert.match(
    html,
    /<span title="Merged “Lowlands” into “The Lowlands”">Merged “Lowlands” into “The Lowlands”<\/span>/,
  )
  assert.match(html, />Undo<\/button>/)
  const overview = render(kept.id, '', [
    [['artist', kept.id], kept],
    [
      libraryChangesKey({ kind: 'artist', recordId: kept.id, size: 10 }),
      { page: 1, size: 10, totalCount: 1, pageCount: 1, items: [merge] },
    ],
  ])
  assert.doesNotMatch(overview, />Changes</)
})
