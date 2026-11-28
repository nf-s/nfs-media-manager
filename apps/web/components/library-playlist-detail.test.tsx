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
  LibraryPlaylistDetailSchema,
  LibraryPlaylistEntriesPageSchema,
  type LibraryPlaylistLibrary,
} from '@repo/schemas/library-playlists'
import { LibraryPlaylistDetail } from './library-playlist-detail'
import { ConfigContext } from './providers'
import {
  libraryPlaylistEntriesKey,
  libraryPlaylistKey,
} from '@/utils/library-playlists'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const timestamp = '2026-11-01T00:00:00.000Z'
const media = {
  artworkUrl: null,
  originalTitle: null,
  summary: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: timestamp,
  updatedAt: timestamp,
}
const items: Record<LibraryPlaylistLibrary, unknown> = {
  tracks: {
    id: 'track-1',
    mediaType: 'track',
    title: 'Harbour Lights',
    artworkUrl: null,
    releaseDate: null,
    artists: ['Mira Kestrel'],
    albumName: 'Paper Moons',
    album: null,
    albumLinkStrategy: null,
    albumTags: [],
    playlists: [],
    durationSec: 200,
    dateAdded: null,
    spotifyTrackId: '1234567890ABCDEFGHIJK1',
    spotifyMatch: 'spotify-import',
    spotifyUrl: null,
    isrc: null,
    scrobbles: 0,
    lastListenedAt: null,
  },
  albums: {
    ...media,
    id: 'album-1',
    mediaType: 'album',
    slug: 'paper-moons',
    title: 'Paper Moons',
    credits: [
      { id: 'artist-1', name: 'Mira Kestrel', role: 'artist', billingOrder: 0 },
    ],
    dateAdded: null,
    durationSec: null,
    spotifyUrl: null,
    trackCount: 9,
  },
  films: {
    ...media,
    id: 'film-1',
    mediaType: 'film',
    slug: 'winter-index',
    title: 'Winter Index',
    credits: [
      { id: 'person-1', name: 'Ada Lune', role: 'director', billingOrder: 0 },
    ],
    runtimeMinutes: 90,
    watched: false,
    sourceKind: null,
    budget: null,
    boxOffice: null,
  },
  subscriptions: {
    type: 'youtube',
    id: 'abcdefghijk',
    sourceId: `UC${'c'.repeat(22)}`,
    sourceTitle: 'Example Repairs',
    sourceThumbnailUrl: null,
    title: 'Fixing radios',
    description: 'Valves and dials.',
    tags: [],
    publishedAt: timestamp,
    publishedPrecision: 'time',
    durationSec: 754,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    viewCount: 12,
    likeCount: null,
    commentCount: null,
    live: 'none',
  },
  mixes: {
    type: 'rinse',
    id: 'rinse.example-show-1',
    sourceId: 'rinse.example-show',
    sourceTitle: 'Lantern Club',
    sourceThumbnailUrl: null,
    title: 'Lantern Club late set',
    description: 'Late set.',
    tags: [],
    publishedAt: timestamp,
    publishedPrecision: 'day',
    durationSec: 3600,
    url: 'https://www.rinse.fm/episodes/example-show-1',
    artworkUrl: null,
    artists: [],
    audioUrl: null,
  },
}

function playlist(
  library: LibraryPlaylistLibrary,
  entryCount: number,
  repeatCount = 0,
) {
  return LibraryPlaylistDetailSchema.parse({
    id: `pl-${library}`,
    library,
    type: 'playlist',
    name: 'Late Shift',
    entryCount,
    view: null,
    updatedAt: '2026-11-28T08:00:00.000Z',
    createdAt: timestamp,
    repeatCount,
  })
}

function render(library: LibraryPlaylistLibrary, entryCount = 1, repeats = 0) {
  const detail = playlist(library, entryCount, repeats)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(libraryPlaylistKey(detail.id), detail)
  const parsed = LibraryPlaylistEntriesPageSchema.safeParse({
    library,
    page: 1,
    size: 100,
    hasMore: false,
    items: entryCount
      ? [
          {
            id: 'entry-1',
            position: 1,
            addedAt: '2026-11-20T10:00:00.000Z',
            item: items[library],
          },
        ]
      : [],
  })
  assert.ok(parsed.success, `${library}: ${parsed.error?.message}`)
  const page = parsed.data
  client.setQueryData(
    [...libraryPlaylistEntriesKey(detail.id), entryCount, detail.updatedAt, 1],
    {
      items: page.items.map((entry) => ({ ...entry, library })),
      hasMore: false,
      totalCount: entryCount,
    },
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
          <PathnameContext.Provider value="/playlists">
            <SearchParamsContext.Provider value={new URLSearchParams()}>
              <LibraryPlaylistDetail id={detail.id} />
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

const libraries = [
  ['tracks', 'Tracks', 'Artists', 'Mira Kestrel', 'Harbour Lights', 'track'],
  ['albums', 'Albums', 'Artists', 'Mira Kestrel', 'Paper Moons', 'album'],
  ['films', 'Films', 'Directors', 'Ada Lune', 'Winter Index', 'film'],
  [
    'subscriptions',
    'Items',
    'Channel',
    'Example Repairs',
    'Fixing radios',
    'subscription',
  ],
  ['mixes', 'Mixes', 'Show', 'Lantern Club', 'Lantern Club late set', 'mix'],
] as const

test('the header has the kind, the name, its facts and the Filter action', () => {
  const html = render('tracks', 52)
  assert.match(html, /<span class="ds-detail-kind">Playlist<\/span>|>Playlist</)
  assert.match(html, /<h2 class="ds-detail-title">Late Shift<\/h2>/)
  assert.match(html, /52 tracks/)
  assert.match(html, /Updated 2026-11-28/)
  assert.match(html, />Library</)
  const filter = html.match(/<a[^>]*href="([^"]+)"[^>]*>Filter tracks<\/a>/)
  assert.ok(filter?.[1], 'Filter tracks')
  const url = new URL(filter[1].replaceAll('&amp;', '&'), 'http://x')
  assert.equal(url.pathname, '/tracks')
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
    { field: 'libraryPlaylist', value: 'pl-tracks', mode: 'required' },
  ])
  assert.match(render('albums'), />Filter albums<\/a>/)
  for (const [library, label] of [
    ['films', 'Filter films'],
    ['subscriptions', 'Filter items'],
    ['mixes', 'Filter mixes'],
  ] as const) {
    const link = render(library).match(
      new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${label}</a>`),
    )
    assert.ok(link?.[1], label)
    assert.equal(
      new URL(link[1].replaceAll('&amp;', '&'), 'http://x').pathname,
      `/${library}`,
    )
  }
})

test('More has Rename and Delete playlist', () => {
  const html = render('tracks')
  const menu = html.match(
    /<div[^>]*role="menu" aria-label="More actions"[\s\S]*?<\/div>/,
  )?.[0]
  assert.ok(menu, 'More actions menu')
  const labels = [
    ...menu.matchAll(/role="menuitem"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g),
  ].map(([, label]) => label)
  assert.deepEqual(labels.slice(0, 2), ['Rename', 'Delete playlist'])
})

test('every library lists its entries in the one table with its creator column', () => {
  for (const [library, title, creator, by, item, kind] of libraries) {
    const html = render(library)
    assert.match(html, new RegExp(`<h3>${title}</h3>`))
    const table = html.match(
      new RegExp(
        `<table class="ds-table" aria-label="${title}" aria-rowcount="2"[\\s\\S]*?</table>`,
      ),
    )?.[0]
    assert.ok(table, `${library} table`)
    const heads = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(
      ([, cell = '']) =>
        cell.replace(/<span class="ds-th-resizer"[\s\S]*?<\/span>/g, ''),
    )
    assert.deepEqual(
      heads.map((cell) => cell.replace(/<[^>]+>/g, '')),
      ['#Position', 'Title', creator, 'Added to playlist'],
    )
    assert.match(table, new RegExp(`>${item}</a>`))
    assert.match(table, new RegExp(`>${by}<`))
    assert.match(
      table,
      /<time dateTime="2026-11-20T10:00:00.000Z"[^>]*>2026-11-20<\/time>/,
    )
    assert.match(table, /aria-label="More actions for [^"]+"/)
    assert.match(table, />Add to another playlist…</)
    assert.match(table, />Remove from this playlist</)
    assert.match(table, />Open details</)
    const plays = /aria-label="Play [^"]+"/.test(table)
    assert.equal(plays, library === 'tracks' || library === 'albums', kind)
  }
})

test('the header plays the entries in Albums and Tracks only', () => {
  for (const [library] of libraries) {
    const html = render(library)
    const header = html.slice(0, html.indexOf('<section'))
    assert.equal(
      /aria-label="Play Late Shift[^"]*"/.test(header),
      library === 'tracks' || library === 'albums',
      library,
    )
  }
})

test('repeated entries show the notice with Remove repeats', () => {
  const html = render('tracks', 6, 3)
  assert.match(
    html,
    /<div class="ds-notice" role="status">[\s\S]*?<span>3 tracks are in this playlist more than once\.<\/span>[\s\S]*?>Remove repeats<\/button>/,
  )
  assert.ok(html.indexOf('more than once') < html.indexOf('<h3>Tracks</h3>'))
  assert.doesNotMatch(render('tracks', 6, 0), /more than once|Remove repeats/)
})

test('an empty playlist says so in its library’s words', () => {
  for (const [library, title] of libraries) {
    const html = render(library, 0)
    assert.match(
      html,
      new RegExp(
        `<h3>${title}</h3>[\\s\\S]*?<div class="ds-state" data-size="sm" role="status"><strong>Empty playlist</strong><span>Add ${title.toLowerCase()} from Browse\\.</span></div>`,
      ),
    )
    assert.doesNotMatch(html, /<table/)
  }
})
