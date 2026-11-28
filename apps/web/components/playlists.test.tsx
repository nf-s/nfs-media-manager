import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  PlaylistSummarySchema,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import PlaylistsWorkspace from './playlists-workspace'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const playlist = PlaylistSummarySchema.parse({
  id: 'playlist-1',
  name: 'Synthetic mix',
  source: 'spotify',
  ownerName: 'Example owner',
  description: null,
  artworkUrl: null,
  spotifyUrl: null,
  importedAt: '2026-01-02T00:00:00.000Z',
  trackCount: 12,
  linkedTrackCount: 7,
  albumCount: 3,
  durationSec: 3900,
})

function render(
  children: ReactNode,
  data: Array<[unknown[], unknown]>,
  search = '',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  for (const [key, value] of data) client.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/playlists">
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

function playlistPage(
  items: PlaylistSummary[],
  hasMore = false,
  library = 'tracks',
): [unknown[], unknown] {
  return [
    ['playlists', 'browse', library, '', [], 'name', 'asc', 1],
    {
      items,
      page: 1,
      size: 100,
      hasMore,
      totalCount: hasMore ? undefined : items.length,
    },
  ]
}

const libraryRow = (library: 'tracks' | 'albums') =>
  PlaylistSummarySchema.parse({
    ...playlist,
    id: 'library-1',
    name: 'Late Shift',
    source: null,
    ownerName: null,
    importedAt: null,
    trackCount: 0,
    linkedTrackCount: 0,
    albumCount: 0,
    durationSec: 0,
    origin: 'library',
    type: 'playlist',
    library,
    view: null,
    updatedAt: '2026-11-28T01:00:00.000Z',
    itemCount: 52,
  })

const smartView = {
  filters: JSON.stringify([{ field: 'genre', value: 'ambient', mode: 'any' }]),
  sortBy: 'dateAdded',
  direction: 'desc',
}
const smartRow = (library: 'tracks' | 'albums') =>
  PlaylistSummarySchema.parse({
    ...libraryRow(library),
    id: 'smart-1',
    name: 'Ambient, Newest First',
    type: 'smart',
    view: smartView,
    itemCount: null,
  })

const importedRow = PlaylistSummarySchema.parse({
  ...playlist,
  origin: 'imported',
  type: 'playlist',
  library: null,
  updatedAt: playlist.importedAt,
  itemCount: 12,
})

/** The cells of the row whose title link reads `name`. */
function rowOf(html: string, name: string) {
  const rows = html.match(/<tr[^>]*aria-rowindex[\s\S]*?<\/tr>/g) ?? []
  const row = rows.find((row) => row.includes(`>${name}</a>`))
  assert.ok(row, `row for ${name}`)
  return row
}

function cellsOf(row: string) {
  return (row.match(/<td[\s\S]*?<\/td>/g) ?? []).map((cell) =>
    cell.replace(/<[^>]+>/g, ''),
  )
}

test('the default columns are Playlist, Type, Source, the count, Saved view and Updated', () => {
  for (const [search, library, noun] of [
    ['', 'tracks', 'Tracks'],
    ['mediaType=album', 'albums', 'Albums'],
  ] as const) {
    const html = render(
      <PlaylistsWorkspace />,
      [playlistPage([importedRow], false, library)],
      search,
    )
    const head = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''
    // A header's label is its sort button's, or its text without one.
    const labels = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(
      ([, cell = '']) =>
        (/class="ds-th-sort"[^>]*>([^<]+)/.exec(cell)?.[1] ?? cell).replace(
          /<[^>]+>/g,
          '',
        ),
    )
    assert.deepEqual(labels, [
      'Playlist',
      'Type',
      'Source',
      noun,
      'Saved view',
      'Updated',
      'Actions',
    ])
    for (const label of ['Type', 'Source', noun, 'Updated'])
      assert.match(head, new RegExp(`title="Sort by ${label}"`))
    assert.doesNotMatch(head, /title="Sort by Saved view"/)
  }
})

test('every column the page had stays available under Columns, hidden by default', () => {
  const html = render(<PlaylistsWorkspace />, [playlistPage([importedRow])])
  for (const label of [
    'Owner',
    'Tracks',
    'In album library',
    'Albums',
    'Duration',
    'Imported',
    'Schedule',
    'Last checked',
    'Added to library',
    'Description',
    'Next import',
  ]) {
    assert.match(html, new RegExp(`/>${label}</label>`))
    // In Tracks the count column is headed Tracks too.
    if (label !== 'Tracks')
      assert.doesNotMatch(html, new RegExp(`title="Sort by ${label}"`))
  }
  assert.equal((html.match(/title="Sort by Tracks"/g) ?? []).length, 1)
})

test('Type, Source, count and Saved view for each kind of row', () => {
  const smartCount = new URLSearchParams({ filters: smartView.filters })
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([importedRow, libraryRow('tracks'), smartRow('tracks')]),
    [['tracks', 'browse-count', smartCount.toString()], { totalCount: 7 }],
  ])
  const [, importedType, importedSource, importedCount, importedView] = cellsOf(
    rowOf(html, 'Synthetic mix'),
  )
  assert.deepEqual(
    [importedType, importedSource, importedCount, importedView],
    ['Playlist', 'Spotify', '12', '–'],
  )
  const [, type, source, count, view, updated] = cellsOf(
    rowOf(html, 'Late Shift'),
  )
  assert.deepEqual(
    [type, source, count, view, updated],
    ['Playlist', 'Library', '52', '–', '2026-11-28'],
  )
  const smart = rowOf(html, 'Ambient, Newest First')
  const [, smartType, smartSource, smartTotal, smartText] = cellsOf(smart)
  assert.deepEqual(
    [smartType, smartSource, smartTotal, smartText],
    ['Smart playlist', 'Library', '7', 'Tag: Ambient · Added, newest first'],
  )
  assert.match(smart, /title="Tag: Ambient · Added, newest first"/)
})

test('a library playlist opens in the inspector and a smart playlist opens Browse with its view', () => {
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([importedRow, libraryRow('tracks'), smartRow('tracks')]),
  ])
  assert.match(
    rowOf(html, 'Synthetic mix'),
    /<a class="ds-cell-title" href="\/playlists\/playlist-1"[^>]*>Synthetic mix<\/a>/,
  )
  assert.match(
    rowOf(html, 'Late Shift'),
    /<a class="ds-cell-title" href="\/playlists\/library\/library-1"[^>]*>Late Shift<\/a>/,
  )
  const params = new URLSearchParams(smartView)
  params.set('smartPlaylist', 'smart-1')
  assert.ok(
    rowOf(html, 'Ambient, Newest First').includes(
      `href="/tracks?${params.toString().replaceAll('&', '&amp;')}"`,
    ),
  )
  // Albums and Tracks rows of every kind play.
  for (const name of ['Synthetic mix', 'Late Shift', 'Ambient, Newest First'])
    assert.match(rowOf(html, name), /aria-label="Play [^"]+"/)
})

test('the three-dot menu is on library rows only, with the items of each kind', () => {
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([importedRow, libraryRow('tracks'), smartRow('tracks')]),
  ])
  const items = (row: string) =>
    [
      ...(row.match(/<div[^>]*role="menu"[\s\S]*?<\/div>/)?.[0] ?? '').matchAll(
        /role="menuitem"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g,
      ),
    ].map(([, label]) => label)
  const imported = rowOf(html, 'Synthetic mix')
  assert.doesNotMatch(imported, /role="menu"/)
  assert.match(imported, /title="Remove Synthetic mix"/)
  assert.deepEqual(items(rowOf(html, 'Late Shift')), [
    'Rename',
    'Delete playlist',
  ])
  assert.deepEqual(items(rowOf(html, 'Ambient, Newest First')), [
    'Open in Browse',
    'Rename',
    'Delete smart playlist',
  ])
  assert.match(
    rowOf(html, 'Late Shift'),
    /aria-label="More actions for Late Shift" title="More actions"/,
  )
})

test('playlist rows open the drawer and the Spotify link sits in Source', () => {
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([
      {
        ...importedRow,
        spotifyUrl: 'https://open.spotify.com/playlist/example',
      },
    ]),
  ])
  assert.match(
    rowOf(html, 'Synthetic mix'),
    /open\.spotify\.com\/playlist\/example/,
  )
  assert.doesNotMatch(html, /Playlist details/)
  // The Playlist column names the playlist without its album or track type.
  assert.doesNotMatch(html, /(Album|Track) playlist/)
})

test('an empty playlist table links to the import page', () => {
  const html = render(<PlaylistsWorkspace />, [playlistPage([])])
  assert.match(html, /No playlists\./)
  assert.match(html, /Import playlists/)
})

test('the playlists directory renders only its visible rows while counting and afterward', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...importedRow,
    id: `playlist-${index + 1}`,
    name: `Fixture playlist ${index + 1}`,
  }))
  for (const totalCount of [undefined, 305]) {
    const data = [playlistPage(rows, true)]
    if (totalCount)
      data.push([
        ['playlists', 'browse-count', 'tracks', '', []],
        { totalCount },
      ])
    const html = render(<PlaylistsWorkspace />, data)
    const rowCount = (
      html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr\b/g) ?? []
    ).length
    assert.ok(
      rowCount <= 30,
      `Expected the visible window, rendered ${rowCount} rows`,
    )
    assert.match(html, /aria-rowindex="2"/)
    assert.match(html, />Fixture playlist 1<\/a>/)
    assert.doesNotMatch(html, /Fixture playlist 100/)
    if (totalCount) {
      assert.match(html, /305 playlists/)
      assert.match(html, /aria-rowcount="306"/)
      assert.match(html, /style="height:9152px;padding:0;border:0"/)
    } else {
      assert.match(html, /Counting playlists/)
      assert.doesNotMatch(html, /aria-rowcount=/)
    }
  }
})

test('compact playlist names retain their complete text', () => {
  const name =
    'A long playlist title with several words that must remain available'
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([{ ...importedRow, name }]),
  ])
  assert.ok(html.includes(`title="${name}"`))
  assert.ok(html.includes(`aria-label="Remove ${name}"`))
  assert.ok(html.includes(`>${name}</a>`))
})

test('the page head has New playlist, then the toolbar: search, count, columns', () => {
  const html = render(<PlaylistsWorkspace />, [
    playlistPage([importedRow, libraryRow('tracks'), smartRow('tracks')]),
  ])
  assert.match(
    html,
    /<button class="ds-btn" type="button" popoverTarget="[^"]+" aria-haspopup="dialog" aria-controls="[^"]+"><svg[^>]*lucide-plus[^>]*>[\s\S]*?<\/svg>New playlist<\/button>/,
  )
  const create = html.indexOf('>New playlist</button>')
  const search = html.indexOf('aria-label="Search playlists"')
  const count = html.indexOf('3 playlists')
  const columns = html.indexOf('aria-label="Visible columns"')
  const actions = html.indexOf(
    'href="/imports/spotify-playlists?mediaType=track"',
  )
  assert.ok(create > 0 && create < actions)
  assert.ok(search > 0 && actions < search && count > search && columns > count)
  assert.match(html, /placeholder="Search playlists"/)
  assert.match(html, /aria-label="Filter Source"/)
})

test('playlist imports preserve Albums', () => {
  const html = render(
    <PlaylistsWorkspace />,
    [playlistPage([playlist], false, 'albums')],
    'mediaType=album',
  )
  assert.match(html, /href="\/imports\/spotify-playlists\?mediaType=album"/)
})
