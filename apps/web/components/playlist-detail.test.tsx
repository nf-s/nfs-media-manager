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
  PlaylistDetailSchema,
  PlaylistSummarySchema,
  type PlaylistDetail,
} from '@repo/schemas/tracks'
import { PlaybackViewContext, type PlaybackView } from './playback-provider'
import PlaylistsWorkspace from './playlists-workspace'
import { ConfigContext } from './providers'
import { idlePlaybackState } from '@/utils/playback-engine'
import {
  playlistEntryView,
  playlistEntryViewParam,
} from '@/utils/playlist-links'
import { playlistWindowSlots } from './playlist-detail'
import { TrackEntriesTable, trackEntryKey } from './track-entries-table'
import { DetailInspectorProvider } from './detail-inspector-context'
import {
  detailEntries,
  detailEntryParams,
  type DetailEntry,
} from '@/utils/detail-inspector'

// The Tracks browser imports a CSS module, which Node cannot load; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const summary = PlaylistSummarySchema.parse({
  id: 'playlist-1',
  name: 'Synthetic mix',
  source: 'spotify',
  ownerName: 'Example owner',
  description: null,
  artworkUrl: null,
  spotifyUrl: 'https://open.spotify.com/playlist/1234567890ABCDEFGHIJKL',
  importedAt: '2026-01-02T00:00:00.000Z',
  trackCount: 2,
  linkedTrackCount: 1,
  albumCount: 1,
  durationSec: 400,
  sync: {
    syncable: true,
    schedule: 'daily',
    lastCheckedAt: '2026-01-02T00:00:00.000Z',
    nextScheduledAt: null,
    job: {
      jobId: 'job-1',
      status: 'running',
      errorMessage: null,
      finishedAt: null,
      progress: { pagesRead: 2, totalPages: 5 },
    },
  },
})

function track(id: string, title: string, spotifyTrackId: string) {
  return {
    id,
    mediaType: 'track',
    title,
    artworkUrl: null,
    releaseDate: null,
    artists: ['Example artist'],
    artistCredits: [{ id: 'example-artist', name: 'Example artist' }],
    albumName: 'Spotify album',
    album: id === 'track-1' ? { id: 'album-1', title: 'Fixture album' } : null,
    albumLinkStrategy: null,
    albumTags: [],
    playlists: [],
    durationSec: 200,
    dateAdded: null,
    spotifyTrackId,
    spotifyMatch: spotifyTrackId ? 'spotify-import' : 'unmatched',
    spotifyUrl: null,
    isrc: null,
    scrobbles: 0,
    lastListenedAt: null,
  }
}

function detail(playlist = summary): PlaylistDetail {
  return PlaylistDetailSchema.parse({
    ...playlist,
    items: {
      page: 1,
      size: 100,
      totalCount: 3,
      pageCount: 1,
      items: [
        {
          kind: 'track',
          position: 1,
          addedAt: '2026-01-01T00:00:00.000Z',
          track: track('track-1', 'Opening track', '1234567890ABCDEFGHIJK1'),
        },
        {
          kind: 'track',
          position: 2,
          addedAt: null,
          track: track('track-2', 'Closing track', '1234567890ABCDEFGHIJK2'),
        },
        {
          kind: 'album',
          position: 0,
          addedAt: null,
          album: {
            id: 'album-2',
            title: 'Member album',
            artists: ['Album artist'],
            artworkUrl: null,
            releaseDate: null,
            spotifyUrl: null,
          },
        },
      ],
    },
  })
}

async function render(
  search: string,
  playlist = detail(),
  playback?: PlaybackView,
  page: ReactNode = <PlaylistsWorkspace />,
  path = '/playlists',
): Promise<string> {
  const { AppDetailInspector } = await import('./detail-inspector')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['playlists', 'browse', '', [], 'name', 'asc', 1], {
    items: [summary],
    page: 1,
    size: 100,
    hasMore: false,
    totalCount: 1,
  })
  client.setQueryData(['playlist', playlist.id], playlist)
  const view = playlistEntryView(
    new URLSearchParams(
      detailEntries(path, new URLSearchParams(search)).at(-1)?.view,
    ).get('playlistView'),
    playlist.id,
  )
  client.setQueryData(
    [
      'playlist',
      playlist.id,
      'entries',
      view.sortBy,
      view.direction,
      view.q ?? '',
      view.kinds ?? [],
      1,
    ],
    {
      ...playlist.items,
      name: playlist.name,
      items: playlist.items.items.map((entry, index) => ({
        entry,
        key: trackEntryKey(entry),
        index,
      })),
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
          <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              <DetailInspectorProvider>
                {playback ? (
                  <PlaybackViewContext.Provider value={playback}>
                    {page}
                    <AppDetailInspector />
                  </PlaybackViewContext.Provider>
                ) : (
                  <>
                    {page}
                    <AppDetailInspector />
                  </>
                )}
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

function drawerOf(html: string) {
  const start = html.indexOf('aria-label="Playlist details"')
  assert.ok(start >= 0, 'playlist drawer')
  return html.slice(start)
}

function linkTargets(html: string, label: string) {
  const href = html.match(new RegExp(`href="([^"]+)"[^>]*>${label}</a>`))?.[1]
  assert.ok(href)
  const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
  return detailEntries(url.pathname, url.searchParams)
}

test('a nested deep link renders only its active detail and places Back before Open page', async () => {
  const search = detailEntryParams(
    '/playlists',
    new URLSearchParams({ q: 'original' }),
    [
      { kind: 'playlist', id: 'playlist-1' },
      { kind: 'track', id: 'track-1' },
    ],
  )
  const html = await render(search.toString())
  assert.match(html, /aria-label="Track details"/)
  assert.doesNotMatch(html, /aria-label="Playlist details"/)
  const back = html.indexOf('aria-label="Back"')
  const open = html.indexOf('Open page</a>')
  assert.ok(back >= 0 && back < open)
  assert.match(html, /href="\/tracks\/track-1"><svg[\s\S]*?<\/svg>Open page/)
})

test('no drawer opens without the playlist parameter', async () => {
  assert.doesNotMatch(await render(''), /Playlist details/)
})

test('the drawer lists entries in playlist order in the shared table', async () => {
  const html = drawerOf(await render('playlist=playlist-1'))
  assert.match(html, /<h2 class="ds-detail-title">Synthetic mix<\/h2>/)
  assert.match(html, /Example owner/)
  assert.match(html, /2 tracks/)
  assert.match(
    html,
    /href="https:\/\/open\.spotify\.com\/playlist\/1234567890ABCDEFGHIJKL"/,
  )
  assert.match(
    html,
    /href="\/tracks\?filters=[^"]*Synthetic\+mix[^"]*"[^>]*>Filter tracks</,
  )
  const table = html.match(
    /<table class="ds-table" aria-label="Playlist tracks" aria-rowcount="4">[\s\S]*?<\/table>/,
  )?.[0]
  assert.ok(table, 'compact table of entries')
  const order = ['Opening track', 'Closing track', 'Member album'].map(
    (title) => table.indexOf(title),
  )
  assert.ok(order.every((index) => index > 0))
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  )
  assert.deepEqual(linkTargets(table, 'Opening track'), [
    { kind: 'playlist', id: 'playlist-1' },
    { kind: 'track', id: 'track-1' },
  ])
  assert.deepEqual(linkTargets(table, 'Example artist'), [
    { kind: 'playlist', id: 'playlist-1' },
    { kind: 'artist', id: 'example-artist' },
  ])
  assert.deepEqual(linkTargets(table, 'Spotify album').at(-1), {
    kind: 'album',
    id: 'album-1',
  })
  assert.deepEqual(linkTargets(table, 'Member album').at(-1), {
    kind: 'album',
    id: 'album-2',
  })
  assert.match(html, /3 entries/)
  assert.doesNotMatch(html, /Load more tracks/)
  assert.match(
    table,
    /aria-label="Play Opening track: Connect Spotify playback in the player\."[^>]*disabled=/,
  )
  assert.match(html, /aria-selected="true"[^>]*>Overview</)
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(tabs, ['Overview', 'Listening', 'Coverage', 'Sources'])
  // Coverage has its own tab; Overview holds the tracks.
  assert.doesNotMatch(html, /<h3>Coverage<\/h3>/)
  assert.match(html, /aria-label="Play Synthetic mix"[^>]*>.*Play<\/button>/)
})

test('track rows have play and queue buttons while playback is on', async () => {
  const html = drawerOf(
    await render('playlist=playlist-1', detail(), {
      ...idlePlaybackState,
      enabled: true,
      connection: 'connected',
    }),
  )
  assert.match(html, /aria-label="Play Opening track"/)
  assert.match(html, /aria-label="Play Closing track"/)
  assert.match(html, /aria-label="Add Closing track to queue"/)
  // Albums inside a playlist open first; only their own detail plays them.
  assert.doesNotMatch(html, /aria-label="Play Member album"/)
})

test('the sync tab shows the schedule, progress and the latest job', async () => {
  const html = drawerOf(await render('playlist=playlist-1&tab=sync'))
  assert.match(html, /aria-selected="true"[^>]*>Sources</)
  assert.match(html, /aria-label="Sources"/)
  assert.match(html, /<option value="daily" selected="">Daily<\/option>/)
  for (const label of [
    'Off',
    'Every hour',
    'Every 3 hours',
    'Every 6 hours',
    'Weekly',
  ])
    assert.match(html, new RegExp(`>${label}</option>`))
  assert.match(html, /aria-valuenow="2" aria-valuetext="2 of 5"/)
  assert.match(html, /Import in progress/)
  assert.match(html, /data-status="running">Running</)
  const job = html.match(/title="View job" href="([^"]+)"/)?.[1]
  assert.ok(job)
  const jobUrl = new URL(job.replaceAll('&amp;', '&'), 'http://localhost')
  assert.deepEqual(detailEntries(jobUrl.pathname, jobUrl.searchParams), [
    { kind: 'playlist', id: 'playlist-1', view: 'tab=sync' },
    { kind: 'job', id: 'job-1' },
  ])
  assert.match(html, /disabled=""[^>]*>Sync now</)
  assert.match(html, /role="progressbar"/)
})

test('the sync tab explains a missing next sync after a failed import', async () => {
  const failed = detail(
    PlaylistSummarySchema.parse({
      ...summary,
      sync: {
        ...summary.sync,
        job: {
          jobId: 'job-2',
          status: 'failed',
          errorMessage: 'Spotify refused the playlist.',
          finishedAt: '2026-01-02T00:00:00.000Z',
          progress: { pagesRead: 2, totalPages: null },
        },
      },
    }),
  )
  const html = drawerOf(await render('playlist=playlist-1&tab=sync', failed))
  assert.match(html, /2 pages</)
  assert.doesNotMatch(html, /2 of/)
  assert.match(html, /the last import failed\. Sync now to resume\./)
  assert.match(html, /role="alert">[\s\S]*?Spotify refused the playlist\./)
  assert.doesNotMatch(html, /disabled=""[^>]*>Sync now</)
  assert.doesNotMatch(html, /role="progressbar"/)
})

test('a legacy playlist says in one line that it is not synced', async () => {
  const legacy = detail(
    PlaylistSummarySchema.parse({
      ...summary,
      source: null,
      spotifyUrl: null,
      sync: undefined,
    }),
  )
  const html = drawerOf(await render('playlist=playlist-1&tab=sync', legacy))
  assert.match(html, /This playlist is not synced from Spotify\./)
  assert.doesNotMatch(html, /Sync now|<select/)
})

test('the Tracks browser opens the same drawer and filters itself by the playlist', async () => {
  const { default: TrackBrowser } = await import('./track-browser')
  const html = drawerOf(
    await render(
      'playlist=playlist-1&item=track-9',
      detail(),
      undefined,
      <TrackBrowser />,
      '/tracks',
    ),
  )
  assert.match(
    html,
    /href="\/playlists\/playlist-1"><svg[\s\S]*?<\/svg>Open page/,
  )
  assert.match(html, /<button[^>]*>Filter tracks<\/button>/)
  assert.deepEqual(linkTargets(html, 'Opening track').at(-1), {
    kind: 'track',
    id: 'track-1',
  })
  assert.doesNotMatch(html, /aria-label="Track details"/)
})

test('playlist data columns share sortable headers and column controls', async () => {
  const html = await render('')
  for (const label of [
    'Playlist',
    'Owner',
    'Tracks',
    'In album library',
    'Albums',
    'Duration',
    'Imported',
    'Schedule',
    'Last checked',
  ])
    assert.match(html, new RegExp(`<button[^>]*>[^<]*${label}`))
  assert.match(html, /> Columns</)
  assert.match(html, />Source<\/label>/)
})

test('playlist entries expose sorting for every data column', async () => {
  const html = drawerOf(await render('playlist=playlist-1'))
  for (const view of ['Grid', 'List', 'Table'])
    assert.ok(html.includes(`aria-label="${view} view"`))
  for (const label of ['Title', 'Artists', 'Album', 'Duration', 'Added'])
    assert.match(html, new RegExp(`<button[^>]*>[^<]*${label}`))
  assert.match(html, />Filters(?: · \d+)?<\/button>/)
  assert.match(html, /class="ds-toolbar"/)
  assert.match(
    html,
    /<button class="ds-btn" data-icon="" type="button" aria-label="Sort descending"/,
  )
  assert.ok(
    html.indexOf('aria-label="Search playlist entries"') <
      html.indexOf('<thead>'),
  )
  assert.ok(html.indexOf('aria-label="Filter Type"') > html.indexOf('<thead>'))
  assert.doesNotMatch(html, /<select[^>]*aria-label="Entry type"/)
  assert.match(html, /aria-label="Resize details panel"/)
})

test('playlist grid and list keep artwork, playback, navigation, and the visible result window', async () => {
  const entries = detail().items.items.map((entry, index) => {
    const artworkUrl = `https://example.test/${entry.kind}-${index}.jpg`
    const item =
      entry.kind === 'track'
        ? { ...entry, track: { ...entry.track, artworkUrl } }
        : { ...entry, album: { ...entry.album, artworkUrl } }
    return { index, item: { index, key: trackEntryKey(entry), entry: item } }
  })
  const views: ('grid' | 'list')[] = ['grid', 'list']
  for (const view of views) {
    const label = view === 'grid' ? 'Grid' : 'List'
    const html = await render(
      'playlist=playlist-1',
      detail(),
      { ...idlePlaybackState, enabled: true, connection: 'connected' },
      <TrackEntriesTable
        scope="playlist"
        view={view}
        onViewChange={() => {}}
        window={{
          slots: [...entries, { index: 3, item: null }],
          total: 684,
          rowHeight: 64,
          height: 684 * 64,
          columns: view === 'grid' ? 2 : 1,
          gap: 0,
          padTop: 0,
          padBottom: 0,
          scroller: () => {},
          onScroll: () => {},
        }}
        search="Fixture"
        onSearch={() => {}}
        sortBy="position"
        direction="asc"
        onSort={() => {}}
        kindFilter={{ value: [], onChange: () => {} }}
        empty="No tracks."
      />,
    )
    const cards = html.slice(0, html.indexOf('aria-label="Playlist details"'))
    assert.match(
      cards,
      new RegExp(`aria-pressed="true" aria-label="${label} view"`),
    )
    assert.match(
      cards,
      /aria-label="Search playlist entries"[^>]*value="Fixture"/,
    )
    assert.match(cards, /aria-label="Sort by"/)
    assert.match(cards, />Filters(?: · \d+)?<\/button>/)
    assert.match(cards, /aria-posinset="3" aria-setsize="684"/)
    assert.match(cards, /class="ds-(?:card|row)" aria-hidden="true"/)
    assert.doesNotMatch(cards, /<table|Visible columns/)
    assert.match(cards, /src="https:\/\/example\.test\/track-0\.jpg"/)
    assert.match(cards, /src="https:\/\/example\.test\/album-2\.jpg"/)
    const play = cards.indexOf('Play Opening track')
    assert.ok(play >= 0 && play < cards.indexOf('Add Opening track to queue'))
    assert.deepEqual(linkTargets(cards, 'Opening track'), [
      { kind: 'playlist', id: 'playlist-1' },
      { kind: 'track', id: 'track-1' },
    ])
    assert.deepEqual(linkTargets(cards, 'Member album').at(-1), {
      kind: 'album',
      id: 'album-2',
    })
  }
})

test('a playback return URL restores the playlist table search and sorting', async () => {
  const params = new URLSearchParams({
    playlist: 'playlist-1',
    playlistView: playlistEntryViewParam('playlist-1', {
      ...playlistEntryView(null, 'playlist-1'),
      sortBy: 'title',
      direction: 'desc',
      q: 'Fixture',
      kinds: ['track'],
    }),
  })
  const html = drawerOf(await render(params.toString()))
  assert.match(html, /aria-label="Search playlist entries"[^>]*value="Fixture"/)
  assert.match(html, /aria-sort="descending"><div[^>]*><button[^>]*>Title/)
  assert.match(html, /matching entries/)
})

test('a playlist inspector link restores Details independently of the workspace view', async () => {
  const entry: DetailEntry = {
    kind: 'playlist',
    id: summary.id,
    view: new URLSearchParams({
      view: 'list',
      playlistView: playlistEntryViewParam(summary.id, {
        ...playlistEntryView(null, summary.id),
        sortBy: 'title',
        direction: 'desc',
      }),
    }).toString(),
  }
  const params = detailEntryParams(
    '/playlists',
    new URLSearchParams({ view: 'grid' }),
    [entry],
  )
  const html = drawerOf(await render(params.toString()))
  assert.match(html, /aria-pressed="true" aria-label="List view"/)
  assert.match(html, /<option value="title" selected="">Title<\/option>/)
  assert.deepEqual(linkTargets(html, 'Opening track'), [
    entry,
    { kind: 'track', id: 'track-1' },
  ])
  assert.doesNotMatch(html, /<table/)
})

test('overlapping playlist pages reserve duplicate row space and keep playback offsets', () => {
  const page = detail()
  const first = page.items.items[0]
  const second = page.items.items[1]
  const third = page.items.items[2]
  assert.ok(first)
  assert.ok(second)
  assert.ok(third)
  const slots = [first, second, second, third].map((entry, index) => ({
    index,
    item: { entry, key: trackEntryKey(entry), index },
  }))
  const rows = playlistWindowSlots(slots)
  assert.deepEqual(
    rows.map(({ index, item }) => [index, item?.index ?? null]),
    [
      [0, 0],
      [1, 1],
      [2, null],
      [3, 3],
    ],
  )
  assert.equal(rows[3]?.item?.entry, third)
})
