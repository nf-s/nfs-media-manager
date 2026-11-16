import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { CoverageEntriesSchema, CoverageSchema } from '@repo/schemas/coverage'
import { PlaylistDetailSchema } from '@repo/schemas/tracks'
import { ConfigContext } from './providers'
import { DetailInspectorProvider } from './detail-inspector-context'
import {
  GapFilterControls,
  GapSelection,
  gapSelectionKey,
} from './playlist-gaps'
import { trackEntryKey, type IndexedTrackEntry } from './track-entries-table'
import {
  GAP_FILTER_PARAM,
  coverageEntriesKey,
  coverageEntriesPath,
  gapFilter,
  gapFilterOptions,
  gapFilterParam,
  parseGapFilterValue,
  selectionGaps,
  selectionQueueIds,
} from '@/utils/coverage-entries'
import { detailEntryParams } from '@/utils/detail-inspector'
import { coverageKey } from '@/utils/metadata-coverage'

// The Tracks browser imports a CSS module, which Node cannot load; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in gap tests')
})

const ID = 'playlist-1'
const coverage = CoverageSchema.parse({
  total: 3,
  olderThanDays: 180,
  providers: [
    {
      provider: 'discogs',
      displayName: 'Discogs',
      eligible: 3,
      covered: 1,
      stale: 1,
      missing: 1,
      unavailableReason: null,
      missingItemIds: ['album-1'],
      staleItemIds: ['album-3'],
    },
    {
      provider: 'rym',
      displayName: 'Rate Your Music',
      eligible: 3,
      covered: 1,
      stale: 0,
      missing: 2,
      unavailableReason: 'credentials-missing',
      missingItemIds: ['album-1', 'album-2'],
      staleItemIds: [],
    },
  ],
})

function track(id: string, title: string, albumId: string) {
  return {
    id,
    mediaType: 'track',
    title,
    artworkUrl: null,
    releaseDate: null,
    artists: ['Example artist'],
    artistCredits: [{ id: 'example-artist', name: 'Example artist' }],
    albumName: 'Example album',
    album: { id: albumId, title: 'Example album' },
    albumLinkStrategy: null,
    albumTags: [],
    playlists: [],
    durationSec: 200,
    dateAdded: null,
    spotifyTrackId: null,
    spotifyMatch: 'unmatched',
    spotifyUrl: null,
    isrc: null,
    scrobbles: 0,
    lastListenedAt: null,
  }
}

const playlist = PlaylistDetailSchema.parse({
  id: ID,
  name: 'Synthetic mix',
  source: 'spotify',
  ownerName: null,
  description: null,
  artworkUrl: null,
  spotifyUrl: null,
  importedAt: null,
  trackCount: 2,
  linkedTrackCount: 2,
  albumCount: 3,
  durationSec: 400,
  sync: {
    syncable: false,
    schedule: 'off',
    lastCheckedAt: null,
    nextScheduledAt: null,
    job: null,
  },
  items: { page: 1, size: 1, totalCount: 2, pageCount: 2, items: [] },
})

const gapPage = CoverageEntriesSchema.parse({
  page: 1,
  size: 100,
  totalCount: 2,
  pageCount: 1,
  name: 'Synthetic mix',
  gap: 'missing',
  provider: null,
  olderThanDays: 180,
  albumCount: 2,
  items: [
    {
      entry: {
        kind: 'track',
        position: 1,
        addedAt: null,
        track: track('track-1', 'Opening track', 'album-1'),
      },
      gaps: [
        { provider: 'discogs', displayName: 'Discogs', albumIds: ['album-1'] },
        {
          provider: 'rym',
          displayName: 'Rate Your Music',
          albumIds: ['album-1'],
        },
      ],
    },
    {
      entry: {
        kind: 'track',
        position: 2,
        addedAt: null,
        track: track('track-2', 'Closing track', 'album-2'),
      },
      gaps: [
        {
          provider: 'rym',
          displayName: 'Rate Your Music',
          albumIds: ['album-2'],
        },
      ],
    },
  ],
})

function rows(): IndexedTrackEntry[] {
  return gapPage.items.map(({ entry, gaps }, index) => ({
    entry,
    gaps,
    key: trackEntryKey(entry),
    index,
  }))
}

function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  value.setQueryData(coverageKey('playlist', ID), coverage)
  return value
}

function wrap(children: ReactNode, queries: QueryClient, search = '') {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={queries}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/playlists">
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              <DetailInspectorProvider>{children}</DetailInspectorProvider>
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    queries.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('the gap filter travels in the URL and builds its request', () => {
  const param = gapFilterParam(ID, { gap: 'stale', provider: 'discogs' })
  assert.deepEqual(gapFilter(param, ID), { gap: 'stale', provider: 'discogs' })
  assert.equal(gapFilter(param, 'playlist-2'), null)
  assert.equal(gapFilter('{"id":"playlist-1","gap":"old"}', ID), null)
  assert.equal(gapFilter('not json', ID), null)
  assert.equal(gapFilter(null, ID), null)
  const query: Parameters<typeof coverageEntriesPath>[3] = {
    sortBy: 'title',
    direction: 'desc',
    q: 'song',
    kinds: ['track'],
  }
  const url = new URL(
    coverageEntriesPath('playlist 1', 2, 100, query, { gap: 'missing' }),
    'http://localhost',
  )
  assert.equal(url.pathname, '/api/v1/playlists/playlist%201/coverage/entries')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    page: '2',
    size: '100',
    sortBy: 'title',
    direction: 'desc',
    gap: 'missing',
    q: 'song',
    kinds: '["track"]',
  })
  assert.deepEqual(
    coverageEntriesKey(ID, query, { gap: 'missing' }).slice(0, 3),
    coverageKey('playlist', ID),
  )
})

test('the gap options follow the Coverage lines and keep the current one', () => {
  const options = gapFilterOptions(coverage.providers, { gap: 'missing' })
  assert.deepEqual(
    options.map((option) => option.label),
    [
      'Missing: any provider',
      'Stale: any provider',
      'Missing: Discogs',
      'Missing: Rate Your Music',
      'Stale: Discogs',
    ],
  )
  const kept = gapFilterOptions(coverage.providers, {
    gap: 'stale',
    provider: 'gone',
  })
  assert.equal(kept.at(-1)?.value, 'stale:gone')
  assert.deepEqual(parseGapFilterValue('stale:discogs'), {
    gap: 'stale',
    provider: 'discogs',
  })
  assert.deepEqual(parseGapFilterValue('missing'), { gap: 'missing' })
  assert.equal(parseGapFilterValue('old:discogs'), null)
})

test('a selection offers each provider by the albums it would fill', () => {
  const gaps = selectionGaps(rows())
  assert.deepEqual(gaps, [
    {
      provider: 'rym',
      displayName: 'Rate Your Music',
      albumIds: ['album-1', 'album-2'],
    },
    { provider: 'discogs', displayName: 'Discogs', albumIds: ['album-1'] },
  ])
  const many = selectionGaps(
    Array.from({ length: 120 }, (_, index) => ({
      gaps: [
        {
          provider: 'discogs',
          displayName: 'Discogs',
          albumIds: [`a-${index}`],
        },
      ],
    })),
  )
  assert.equal(many[0]?.albumIds.length, 120)
  assert.equal(many[0] && selectionQueueIds(many[0]).length, 100)
  assert.deepEqual(selectionGaps([{}]), [])
})

test('Show switches between all entries and Missing data with its gap', () => {
  const all = wrap(
    <GapFilterControls playlistId={ID} filter={null} onChange={() => {}} />,
    client(),
  )
  assert.match(all, /role="group" aria-label="Show"/)
  assert.match(all, /aria-pressed="true"[^>]*>All</)
  assert.match(all, /aria-pressed="false"[^>]*>Missing data</)
  assert.doesNotMatch(all, /aria-label="Gap"/)
  const gaps = wrap(
    <GapFilterControls
      playlistId={ID}
      filter={{ gap: 'missing', provider: 'discogs' }}
      onChange={() => {}}
    />,
    client(),
  )
  assert.match(gaps, /aria-pressed="true"[^>]*>Missing data</)
  assert.match(gaps, /<select class="ds-select" aria-label="Gap"/)
  assert.match(
    gaps,
    /<option value="missing:discogs" selected="">Missing: Discogs</,
  )
})

test('the selection bar names the gap and lists the providers that fill it', () => {
  const html = wrap(
    <GapSelection
      playlistId={ID}
      filter={{ gap: 'missing' }}
      rows={rows()}
      onClear={() => {}}
    />,
    client(),
  )
  assert.match(html, /class="ds-selectbar sec-selectbar"/)
  assert.match(html, /<b>2 selected<\/b>/)
  assert.doesNotMatch(html, /class="ds-muted">missing/)
  // Rate Your Music fills more albums but needs credentials, so the
  // provider list opens on Discogs.
  assert.match(html, /<select class="ds-select" aria-label="Provider"/)
  assert.match(
    html,
    /<option value="rym">Rate Your Music · 2 albums<\/option><option value="discogs" selected="">Discogs · 1 album</,
  )
  assert.match(html, /data-variant="primary">Fetch</)
  assert.doesNotMatch(html, /Fetch from/)
  assert.match(html, /aria-label="Clear selection"/)
  const one = wrap(
    <GapSelection
      playlistId={ID}
      filter={{ gap: 'stale', provider: 'discogs' }}
      rows={rows()
        .slice(0, 1)
        .map((row) => ({
          ...row,
          gaps: row.gaps?.slice(0, 1),
        }))}
      onClear={() => {}}
    />,
    client(),
  )
  assert.match(one, /<b>1 selected<\/b>/)
  assert.match(one, /class="ds-muted">stale Discogs</)
  assert.match(one, /data-variant="primary">Refresh from Discogs</)
  const none = wrap(
    <GapSelection
      playlistId={ID}
      filter={{ gap: 'missing' }}
      rows={[]}
      onClear={() => {}}
    />,
    client(),
  )
  assert.doesNotMatch(none, /ds-selectbar/)
})

test('the playlist drawer filters its tracks to the rows with gaps and names each gap', async () => {
  const { AppDetailInspector } = await import('./detail-inspector')
  const queries = client()
  queries.setQueryData(['playlist', ID], playlist)
  queries.setQueryData(
    [
      ...coverageEntriesKey(
        ID,
        { sortBy: 'position', direction: 'asc', q: '', kinds: [] },
        { gap: 'missing' },
      ),
      1,
    ],
    {
      ...gapPage,
      items: rows(),
    },
  )
  const search = detailEntryParams('/playlists', new URLSearchParams(), [
    {
      kind: 'playlist',
      id: ID,
      view: new URLSearchParams({
        view: 'table',
        [GAP_FILTER_PARAM]: gapFilterParam(ID, { gap: 'missing' }),
      }).toString(),
    },
  ])
  const html = wrap(<AppDetailInspector />, queries, search.toString())
  assert.match(html, /<h3>Tracks<\/h3>/)
  assert.match(html, /aria-pressed="true"[^>]*>Missing data</)
  assert.match(html, /2 entries · 2 albums missing/)
  const table = html.match(
    /<table class="ds-table" aria-label="Playlist tracks"[\s\S]*?<\/table>/,
  )?.[0]
  assert.ok(table, 'gap table')
  assert.match(
    table,
    /<th[^>]*class="sec-check-cell"[^>]*><span class="sr-only">Select<\/span>/,
  )
  assert.match(table, /<th[^>]*>Missing<\/th>/)
  assert.match(table, /aria-label="Select Opening track"/)
  assert.match(
    table,
    /<span class="ds-pill" data-tone="attention"><span class="ds-pill-label">Discogs<\/span><\/span><span class="ds-pill" data-tone="attention"><span class="ds-pill-label">Rate Your Music/,
  )
  // Coverage's counts link to the same filter on the playlist.
  assert.match(
    html,
    /data-variant="link"[^>]*aria-label="Show the entries missing Discogs"[^>]*>1 missing</,
  )
  assert.match(html, /aria-label="Queue 1 missing for Discogs"[^>]*>Queue</)
  assert.match(
    html,
    /aria-label="Show the entries with stale Discogs"[^>]*>1 stale</,
  )
})

test('a gap review is tied to the rows it was opened with', () => {
  const [first, second] = rows()
  assert.ok(first && second)
  // The same rows in any order are the same selection.
  assert.equal(
    gapSelectionKey([first, second]),
    gapSelectionKey([second, first]),
  )
  // Adding or removing a row is another selection, which drops the review.
  assert.notEqual(gapSelectionKey([first]), gapSelectionKey([first, second]))
  assert.notEqual(gapSelectionKey([first]), gapSelectionKey([]))
})

test('Missing data shows the table, where rows can be selected, whatever the chosen view', async () => {
  const { AppDetailInspector } = await import('./detail-inspector')
  const queries = client()
  queries.setQueryData(['playlist', ID], playlist)
  queries.setQueryData(
    [
      ...coverageEntriesKey(
        ID,
        { sortBy: 'position', direction: 'asc', q: '', kinds: [] },
        { gap: 'missing' },
      ),
      1,
    ],
    { ...gapPage, items: rows() },
  )
  const search = detailEntryParams('/playlists', new URLSearchParams(), [
    {
      kind: 'playlist',
      id: ID,
      view: new URLSearchParams({
        view: 'grid',
        [GAP_FILTER_PARAM]: gapFilterParam(ID, { gap: 'missing' }),
      }).toString(),
    },
  ])
  const html = wrap(<AppDetailInspector />, queries, search.toString())
  assert.match(html, /<table class="ds-table" aria-label="Playlist tracks"/)
  assert.match(html, /aria-label="Select Opening track"/)
  assert.doesNotMatch(html, /aria-label="Browse views"/)
})
