import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { trackBrowseFields } from '@repo/schemas/browse'
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
  client.setQueryData(['tracks', 'fields'], trackBrowseFields)
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
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Tracks start in the Table view; Grid shows the density control', async () => {
  const html = await render()
  assert.match(html, /data-view="table"/)
  assert.match(html, /aria-pressed="true" aria-label="Table view"/)
  assert.doesNotMatch(html, /aria-label="Grid density"/)
  const grid = await render('view=grid')
  assert.match(
    grid,
    /aria-label="Browse views">.*?<\/div><div class="ds-seg" role="group" aria-label="Grid density"><button type="button" aria-pressed="false">Compact<\/button><button type="button" aria-pressed="true">Standard<\/button><button type="button" aria-pressed="false">Roomy<\/button><\/div><span class="ds-toolbar-count"/,
  )
  // The 1000px first measure: five standard columns, eight compact, four roomy.
  assert.match(grid, /grid-template-columns:repeat\(5, minmax\(0, 1fr\)\)/)
  const compact = await render('view=grid&density=compact')
  assert.match(
    compact,
    /<button type="button" aria-pressed="true">Compact<\/button>/,
  )
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
    /<span class="ds-pills" role="group" aria-label="Tags">.*?dream pop.*?shoegaze.*?<span class="ds-more" title="1 more">\+1<\/span>/,
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
