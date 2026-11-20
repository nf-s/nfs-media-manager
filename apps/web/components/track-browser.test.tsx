import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TrackListItemSchema } from '@repo/schemas/tracks'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}
const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const track = TrackListItemSchema.parse({
  id: 'track-example',
  mediaType: 'track',
  title: 'Example Song',
  artworkUrl: null,
  releaseDate: '2019-05-01',
  artists: ['Example Artist'],
  artistCredits: [{ id: 'artist-example', name: 'Example Artist' }],
  albumName: 'Example Album',
  album: { id: 'album-example', title: 'Example Album' },
  albumLinkStrategy: 'album-track-list',
  albumTags: ['dream pop', 'shoegaze', 'ambient'],
  artistTags: [],
  playlists: [
    { id: 'playlist-one', name: 'Morning' },
    { id: 'playlist-two', name: 'Evening' },
    { id: 'playlist-three', name: 'Late' },
  ],
  sources: ['album'],
  durationSec: 250,
  dateAdded: '2026-03-04T12:00:00.000Z',
  spotifyTrackId: null,
  spotifyMatch: 'unmatched',
  spotifyUrl: null,
  isrc: null,
  scrobbles: 1204,
  lastListenedAt: null,
})
const groupedTrack = TrackListItemSchema.parse({
  ...track,
  recordingGroup: { versionCount: 2 },
})

async function render(
  search = '',
  total = 250,
  counts?: { totalCount: number; unfilteredCount: number },
  grouped = false,
  otherCounts?: { totalCount: number; unfilteredCount: number },
) {
  const { default: TrackBrowser } = await import('./track-browser')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const params = new URLSearchParams(search)
  const identity = JSON.stringify({
    q: params.get('q') ?? '',
    filters: [],
    ranges: [],
    sortBy: params.get('sortBy') ?? 'dateAdded',
    direction: params.get('direction') === 'asc' ? 'asc' : 'desc',
    ...(grouped ? { groupRecordings: true } : {}),
  })
  const countParams = new URLSearchParams({
    q: params.get('q') ?? '',
    filters: '[]',
    ranges: '[]',
  })
  if (grouped) countParams.set('groupRecordings', 'true')
  countParams.sort()
  if (counts)
    client.setQueryData(
      ['tracks', 'browse-count', countParams.toString()],
      counts,
    )
  if (otherCounts) {
    if (grouped) countParams.delete('groupRecordings')
    else countParams.set('groupRecordings', 'true')
    countParams.sort()
    client.setQueryData(
      ['tracks', 'browse-count', countParams.toString()],
      otherCounts,
    )
  }
  client.setQueryData(['ai-status'], { available: true, reason: null })
  client.setQueryData(['tracks', 'browse', identity, 1], {
    items: total ? [grouped ? groupedTrack : track] : [],
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
          <PathnameContext.Provider value="/tracks">
            <SearchParamsContext.Provider value={params}>
              <TrackBrowser />
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    assert.equal(client.getQueryState(['tracks', 'fields']), undefined)
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Tracks start in the Table view; grid size is not on the toolbar', async () => {
  const html = await render()
  assert.match(html, /data-view="table"/)
  assert.match(html, /aria-pressed="true" aria-label="Table view"/)
  const grid = await render('view=grid')
  // The view switch is followed by the Filters button, then the count.
  assert.match(
    grid,
    /aria-label="Browse views">.*?<\/div><button class="ds-btn" type="button" data-filters="full"[^>]*>.*?<\/button><span class="ds-toolbar-count"/,
  )
  assert.doesNotMatch(grid, /aria-label="Grid size"/)
  // The 1000px first measure: five standard columns, eight compact, four roomy.
  assert.match(grid, /grid-template-columns:repeat\(5, minmax\(0, 1fr\)\)/)
  const compact = await render('view=grid&density=compact')
  assert.match(compact, /grid-template-columns:repeat\(8, minmax\(0, 1fr\)\)/)
  const roomy = await render('view=grid&density=roomy')
  assert.match(roomy, /grid-template-columns:repeat\(4, minmax\(0, 1fr\)\)/)
})

test('Group recordings follows the sort unless the URL sets an override', async () => {
  for (const search of [
    'sortBy=scrobbles',
    'view=list&sortBy=lastListenedAt',
    'view=grid&sortBy=artist&groupRecordings=true',
  ]) {
    const html = await render(search, 1, undefined, true)
    assert.doesNotMatch(html, />Group recordings<\/button>/)
    assert.match(
      html,
      /aria-expanded="false" aria-label="Show 2 release versions for Example Song"/,
    )
  }
  for (const search of [
    'sortBy=artist',
    'sortBy=album',
    'sortBy=dateAdded',
    'sortBy=scrobbles&groupRecordings=false',
  ]) {
    const html = await render(search)
    assert.doesNotMatch(
      html,
      /aria-label="Show 2 release versions|data-sticky="end"/,
    )
  }
})

test('Grouped Tracks place the release versions button immediately after the title link in every view', async () => {
  for (const view of ['table', 'list', 'grid']) {
    const html = await render(
      `view=${view}&sortBy=scrobbles`,
      1,
      undefined,
      true,
    )
    assert.match(
      html,
      /<a [^>]*>Example Song<\/a><button[^>]*aria-label="Show 2 release versions for Example Song"/,
      view,
    )
    assert.doesNotMatch(
      html,
      /justify-between[^>]*><a [^>]*>Example Song|<th [^>]*aria-label="Release versions"/,
    )
  }
})

test('Tracks list rows: thumbnail, title, artists and album, play pair, tags and values', async () => {
  const html = await render('view=list')
  assert.match(html, /data-view="list"/)
  assert.match(html, /1 track|250 tracks/)
  assert.match(html, /class="ds-listhead"/)
  assert.match(
    html,
    /<a class="ds-row-title" title="Example Song" href="\/tracks\/track-example">Example Song<\/a>/,
  )
  assert.match(html, /href="\/artists\/artist-example"/)
  assert.match(html, /href="\/albums\/album-example"[^>]*>Example Album<\/a>/)
  // Play is followed by Add to queue; playback is off in tests, so both say why.
  assert.match(
    html,
    /<span class="ds-play" data-place="row"><button[^>]*aria-label="Play Example Song[^"]*"[^>]*>.*?<\/button><button[^>]*aria-label="Add Example Song to queue/,
  )
  assert.match(
    html,
    /<span class="ds-pills" role="group" aria-label="Tags">.*?Dream Pop.*?Shoegaze.*?<span class="ds-more" title="1 more">\+1<\/span>/,
  )
  assert.match(
    html,
    /<span class="ds-w-num">4:10<\/span><span class="ds-w-num">1,204<\/span><span class="ds-w-date">2026-03-0[45]<\/span>/,
  )
  assert.doesNotMatch(
    html,
    /Double-click|media-browser\.module|list-row|track-play/,
  )
})

test('Tracks grid cards keep the artwork clean apart from the play pair', async () => {
  const html = await render('view=grid')
  assert.match(html, /<article class="ds-card" data-item-index="0">/)
  assert.match(html, /<span class="ds-art">/)
  assert.match(html, /aria-label="Open details for Example Song"/)
  assert.match(html, /<span class="ds-play" data-place="tile"/)
  assert.doesNotMatch(html, /bi-tile-play/)
  assert.match(
    html,
    /<span class="ds-card-meta"><span>2019<\/span><span>Added 2026-03-0[45]<\/span><\/span>/,
  )
  assert.match(html, /aria-label="Tags"/)
  assert.doesNotMatch(html, /service-links|tile-sort|ratings-poster/)
  const byTitle = await render('view=grid&sortBy=title&direction=asc')
  assert.match(byTitle, /<span>2019<\/span><span>4:10<\/span>/)
})

test('Tracks Table: drawn default columns, pinned title with thumbnail and play pair', async () => {
  const html = await render('view=table')
  assert.match(html, /<table class="ds-table" data-layout="fixed"/)
  const heads = [...html.matchAll(/aria-label="Resize ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, [
    'Title',
    'Artists',
    'Album',
    'Duration',
    'Added',
    'Scrobbles',
    'Playlists',
    'Tags',
  ])
  assert.doesNotMatch(html, /Artwork and playback/)
  assert.match(
    html,
    /<td data-sticky="edge" style="--ds-sticky-left:0px" title="Example Song"><span class="ds-cell-id"><a class="bi-thumb-link"[^>]*><span class="ds-thumb">.*?<a class="ds-cell-title"[^>]*>Example Song<\/a><span class="ds-play" data-place="row">/,
  )
  assert.match(
    html,
    /aria-sort="descending"><button type="button" class="ds-th-sort" title="Sort by Added">Added<svg/,
  )
  assert.match(html, /<td data-align="end" title="4:10">4:10<\/td>/)
  assert.match(html, /<td data-align="end" title="1,204">1,204<\/td>/)
  assert.match(
    html,
    /aria-label="Playlists">.*?href="\/playlists\/playlist-one".*?Morning.*?Evening.*?\+1/,
  )
  assert.doesNotMatch(html, /[↑↓]/)
})

test('Tracks Table follows the chosen column order with the title first', async () => {
  const html = await render(
    'view=table&columnOrder=scrobbles,title,album,durationSec&columns=album,durationSec,scrobbles',
  )
  assert.deepEqual(
    [...html.matchAll(/aria-label="Resize ([^"]+)"/g)].map(
      ([, label]) => label,
    ),
    ['Title', 'Scrobbles', 'Album', 'Duration'],
  )
})

test('a filtered Tracks count reads N of M', async () => {
  const html = await render('q=Example', 1, {
    totalCount: 1,
    unfilteredCount: 1024,
  })
  assert.match(html, /role="status">1 of 1,024 tracks<\/span>/)
})

test('grouped and individual Tracks keep separate cached counts', async () => {
  const grouped = { totalCount: 2, unfilteredCount: 4 }
  const individual = { totalCount: 3, unfilteredCount: 5 }
  for (const sortBy of ['scrobbles', 'lastListenedAt']) {
    const html = await render(
      `q=Example&sortBy=${sortBy}`,
      2,
      grouped,
      true,
      individual,
    )
    assert.match(html, /role="status">2 of 4 tracks<\/span>/)
  }
  for (const sort of [
    'sortBy=artist',
    'sortBy=scrobbles&groupRecordings=false',
  ]) {
    const html = await render(
      `q=Example&${sort}`,
      3,
      individual,
      false,
      grouped,
    )
    assert.match(html, /role="status">3 of 5 tracks<\/span>/)
  }
})

test('an empty Tracks library and an empty search say different things', async () => {
  const empty = await render('', 0)
  assert.match(empty, /<strong>No tracks yet<\/strong>/)
  const search = await render('q=nothing', 0)
  assert.match(search, /<strong>No tracks match<\/strong>/)
  assert.match(search, />Clear filters</)
  assert.match(search, /Search: nothing/)
})

const creator = { creatorId: 'artist-example' }

/** The Tracks browser inside an artist's detail page, at `search`. */
async function renderEmbedded(search = 'tab=tracks') {
  const { EmbeddedTrackBrowser } = await import('./track-browser')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const params = new URLSearchParams(search)
  const q = params.get('q') ?? ''
  const identity = JSON.stringify({
    q,
    filters: [],
    ranges: [],
    sortBy: params.get('sortBy') ?? 'title',
    direction: params.get('direction') ?? 'asc',
    ...creator,
  })
  const countParams = new URLSearchParams({
    q,
    filters: '[]',
    ranges: '[]',
    ...creator,
  })
  countParams.sort()
  client.setQueryData(['tracks', 'browse-count', countParams.toString()], {
    totalCount: 1,
    unfilteredCount: 1024,
  })
  client.setQueryData(['ai-status'], { available: true, reason: null })
  client.setQueryData(['tracks', 'browse', identity, 1], {
    items: [track],
    page: 1,
    size: 100,
    hasMore: false,
    totalCount: 1,
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
            <SearchParamsContext.Provider value={params}>
              <EmbeddedTrackBrowser creator={creator} storage="artist-tracks" />
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    assert.equal(client.getQueryState(['tracks', 'fields']), undefined)
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Tracks inside a detail keep every Browse control and none of the page', async () => {
  const html = await renderEmbedded()
  // The same search, sort, direction, Filters and view switch as the page.
  assert.match(
    html,
    /placeholder="Search titles, artists, albums, playlists..."/,
  )
  assert.match(html, /aria-label="Sort by"/)
  assert.match(html, /aria-label="Sort descending"/)
  assert.match(html, /aria-haspopup="dialog"/)
  assert.match(html, /aria-label="Browse views"/)
  assert.match(html, />Example Song</)
  // No page frame for the app shell to size, and the list scrolls in a box.
  assert.doesNotMatch(html, /class="media-browser"|class="browse-main"/)
  assert.match(
    html,
    /class="[^"]*browse-scroll bi-scroll dtl-browse-entries[^"]*"[^>]*data-inspector-scroll=""/,
  )
  // The page list scrolls with the page frame instead.
  const page = await render()
  assert.match(page, /class="media-browser"/)
  assert.doesNotMatch(
    page,
    /dtl-browse-entries|data-inspector-scroll|Show in Tracks/,
  )
})

test('Tracks inside a detail are held to their creator, which is not a filter', async () => {
  const html = await renderEmbedded()
  // The count is the creator's own, not a share of the library.
  assert.match(html, /role="status">1 track<\/span>/)
  assert.doesNotMatch(html, /Remove artist filter|Clear all/)

  const searched = await renderEmbedded('tab=tracks&q=Example')
  // The search is a pill on the line under the toolbar, before the count and the link.
  assert.match(
    searched,
    /<div class="ds-filterline">.*?Search: Example.*?>Clear all<\/button><span class="ds-toolbar-count" role="status">[^<]*<\/span><a [^>]*>Show in Tracks<\/a><\/div>/,
  )
  assert.doesNotMatch(searched, /Remove artist filter/)

  // On the Tracks page the same creator is a filter that can be removed.
  const page = await render(`creatorId=${creator.creatorId}`)
  assert.match(page, /Remove artist filter/)
})

test('Show in Tracks carries the creator and the list settings', async () => {
  const fresh = await renderEmbedded()
  assert.match(
    fresh,
    /<a class="ds-btn" data-variant="link" href="\/tracks\?creatorId=artist-example&amp;sortBy=title&amp;direction=asc&amp;view=table&amp;density=standard">Show in Tracks<\/a>/,
  )
  const changed = await renderEmbedded(
    'tab=tracks&q=Example&sortBy=scrobbles&direction=desc&view=grid&density=compact&groupRecordings=false',
  )
  assert.match(
    changed,
    /href="\/tracks\?creatorId=artist-example&amp;q=Example&amp;groupRecordings=false&amp;sortBy=scrobbles&amp;direction=desc&amp;view=grid&amp;density=compact">Show in Tracks</,
  )
  assert.match(changed, /data-view="grid"/)
  // A standard card shows the value the list is sorted by beside the year.
  const sorted = await renderEmbedded(
    'tab=tracks&sortBy=scrobbles&direction=desc&view=grid&groupRecordings=false',
  )
  assert.match(
    sorted,
    /class="ds-card-meta"><span>2019<\/span><span>[^<]*1,204/,
  )
})
