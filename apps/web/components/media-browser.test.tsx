import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AlbumListItemSchema, FilmListItemSchema } from '@repo/schemas/media'
import { DetailInspectorProvider } from './detail-inspector-context'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}
const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in media browser tests')
})

const timestamp = '2026-01-01T00:00:00.000Z'
const base = {
  slug: 'synthetic',
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
}
const album = AlbumListItemSchema.parse({
  ...base,
  id: 'album-harbour',
  mediaType: 'album',
  title: 'Harbour Lights',
  dateAdded: null,
  durationSec: null,
  spotifyUrl: null,
  trackCount: 10,
  editionOfId: null,
  editionCount: 2,
})
const edition = AlbumListItemSchema.parse({
  ...album,
  id: 'album-harbour-deluxe',
  title: 'Harbour Lights (Deluxe)',
  editionOfId: 'album-harbour',
  editionCount: 0,
})
const film = FilmListItemSchema.parse({
  ...base,
  id: 'film-harbour',
  mediaType: 'film',
  title: 'Harbour Film',
  runtimeMinutes: 90,
  watched: false,
  sourceKind: null,
  budget: null,
  boxOffice: null,
})
// An identified film has no Needs ID badge on its card.
const identified = FilmListItemSchema.parse({
  ...film,
  providerReferences: [
    {
      provider: 'tmdb',
      referenceType: 'tmdb',
      externalId: '101',
      isPrimary: true,
      metadata: null,
    },
  ],
})

async function render(
  mediaType: 'album' | 'film',
  search: string,
  items: unknown[],
) {
  const { default: MediaBrowser } = await import('./media-browser')
  const params = new URLSearchParams(search)
  const identity = JSON.stringify({
    q: '',
    filters: [],
    ranges: [],
    sortBy: mediaType === 'album' ? 'dateAdded' : 'releaseDate',
    direction: 'desc',
    includeArchived: false,
    limitResults: null,
    ...(params.get('editions') === 'true' && mediaType === 'album'
      ? { editions: true }
      : {}),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['ai-status'], { available: true, reason: null })
  client.setQueryData([`${mediaType}s`, 'browse', identity, 1], {
    items,
    page: 1,
    size: 100,
    hasMore: false,
    totalCount: items.length,
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
          <PathnameContext.Provider value={`/${mediaType}s`}>
            <SearchParamsContext.Provider value={params}>
              <DetailInspectorProvider>
                <MediaBrowser mediaType={mediaType} />
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

test('Albums Table rows can be ticked for a merge, with the title pinned after the selection', async () => {
  const html = await render('album', 'view=table', [album])
  assert.match(
    html,
    /<colgroup><col style="width:min\(36px, var\(--ds-col-max, 36px\)\)"\/>/,
  )
  assert.match(
    html,
    /<thead><tr><th scope="col" data-sticky="" style="--ds-sticky-left:0px"><input type="checkbox" class="ds-check" aria-label="Select loaded albums"\/><\/th><th /,
  )
  assert.match(
    html,
    /<th [^>]*data-sticky="edge"[^>]*style="--ds-sticky-left:36px"[^>]*>(?:(?!<\/th>).)*Title/,
  )
  assert.match(
    html,
    /<tr data-item-index="0" data-selected="false" aria-rowindex="2"><td data-sticky="" style="--ds-sticky-left:0px"><input type="checkbox" class="ds-check" aria-label="Select Harbour Lights"\/><\/td><td data-sticky="edge" style="--ds-sticky-left:36px">/,
  )
  // The Merge bar sits under the scroll area and is hidden until a row is ticked.
  assert.match(
    html,
    /<\/table><\/div><div class="ds-selectbar sec-selectbar"><\/div>/,
  )
})

test('an Albums row says how many editions it stands for, and an edition row says it is one', async () => {
  const html = await render('album', 'view=table', [album])
  assert.match(
    html,
    /Harbour Lights<\/a><span class="ds-muted ds-num">\+2 editions<\/span>/,
  )
  const rows = await render('album', 'view=table&editions=true', [
    album,
    edition,
  ])
  assert.match(
    rows,
    /Harbour Lights \(Deluxe\)<\/a><span class="ds-muted">Edition<\/span>/,
  )
  // The flag is part of the query: these rows were cached under it.
  assert.match(rows, /aria-label="Select Harbour Lights \(Deluxe\)"/)
})

test('Albums and Films Grid and List have no selection', async () => {
  for (const view of ['grid', 'list']) {
    const other = await render('album', `view=${view}`, [album])
    assert.doesNotMatch(other, /Select loaded albums|Select Harbour Lights/)
    assert.doesNotMatch(other, /ds-selectbar/)
    const films = await render('film', `view=${view}`, [film])
    assert.match(films, /Harbour Film/)
    assert.doesNotMatch(films, /Select loaded films|Select Harbour Film/)
    assert.doesNotMatch(films, /ds-selectbar/)
  }
})

test('the Films table has the checkbox column and no bar until a row is ticked', async () => {
  const films = await render('film', 'view=table', [film])
  assert.match(
    films,
    /<thead><tr><th scope="col" data-sticky="" style="--ds-sticky-left:0px"><input type="checkbox" class="ds-check" aria-label="Select loaded films"/,
  )
  assert.match(films, /aria-label="Select Harbour Film"/)
  assert.match(films, /data-sticky="edge" style="--ds-sticky-left:36px"/)
  // Films has no Merge; the bar, with Add to playlist, shows for a selection.
  assert.doesNotMatch(films, /ds-selectbar|>Merge</)
})

async function renderEmbedded(mediaType: 'album' | 'film') {
  const { EmbeddedMediaBrowser } = await import('./media-browser')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
          <PathnameContext.Provider value="/artists/artist-example">
            <SearchParamsContext.Provider
              value={new URLSearchParams('view=table')}
            >
              <EmbeddedMediaBrowser
                mediaType={mediaType}
                creator={{ creatorId: 'artist-example' }}
                storage={`artist-${mediaType}s`}
                sort={{ key: 'releaseDate', direction: 'desc' }}
              />
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

test('inside a detail the Albums list and its Merge bar share one frame', async () => {
  const albums = await renderEmbedded('album')
  assert.match(
    albums,
    /<div class="dtl-browse-frame"><div class="browse-scroller dtl-browse-entries".*<\/table><\/div><div class="ds-selectbar sec-selectbar"><\/div><\/div>/,
  )
  // Films share the frame; their bar shows only for a selection.
  const films = await renderEmbedded('film')
  assert.match(
    films,
    /<div class="dtl-browse-frame"><div class="browse-scroller dtl-browse-entries"/,
  )
  assert.doesNotMatch(films, /ds-selectbar/)
})

test('Albums tiles, list rows and table rows end the play group with More; Films have More alone', async () => {
  for (const view of ['grid', 'list', 'table']) {
    const html = await render('album', `view=${view}`, [album])
    assert.match(
      html,
      /aria-label="Add Harbour Lights to queue[^"]*"[^>]*>.*?<\/button><button[^>]*aria-label="More actions for Harbour Lights"/,
    )
    assert.match(html, />Add to playlist…<\/button>.*?Open details</)
    const films = await render('film', `view=${view}`, [identified])
    assert.match(
      films,
      new RegExp(
        `<span class="ds-play" data-place="${view === 'grid' ? 'tile' : 'row'}"><button[^>]*aria-label="More actions for Harbour Film"`,
      ),
    )
    assert.match(films, />Add to playlist…<\/button>.*?Open details</)
    assert.doesNotMatch(films, /aria-label="Play |to queue/)
  }
})

test('a film card whose artwork carries Needs ID has no More; its list and table rows keep it', async () => {
  const grid = await render('film', 'view=grid', [film])
  assert.match(grid, /<span class="ds-art-badge">Needs ID<\/span>/)
  assert.doesNotMatch(grid, /More actions for Harbour Film/)
  for (const view of ['list', 'table'])
    assert.match(
      await render('film', `view=${view}`, [film]),
      /More actions for Harbour Film/,
    )
})
