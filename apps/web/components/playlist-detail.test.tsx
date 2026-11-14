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
import PlaylistsWorkspace, {
  playlistSortValue,
  type PlaylistSortKey,
} from './playlists-workspace'
import { sortTableRows } from '@/utils/secondary-table'
import { ConfigContext } from './providers'
import { idlePlaybackState } from '@/utils/playback-engine'

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
    albumName: 'Spotify album',
    album: id === 'track-1' ? { id: 'album-1', title: 'Fixture album' } : null,
    albumLinkStrategy: null,
    albumTags: [],
    playlists: [],
    durationSec: 200,
    dateAdded: null,
    spotifyTrackId,
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

function render(
  search: string,
  playlist = detail(),
  playback?: PlaybackView,
  page: ReactNode = <PlaylistsWorkspace />,
  path = '/playlists',
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['playlists'], [summary])
  client.setQueryData(['playlist', playlist.id], playlist)
  client.setQueryData(['playlist', playlist.id, 'entries', 'position', 'asc'], {
    pages: [playlist],
    pageParams: [1],
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
          <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              {playback ? (
                <PlaybackViewContext.Provider value={playback}>
                  {page}
                </PlaybackViewContext.Provider>
              ) : (
                page
              )}
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

test('no drawer opens without the playlist parameter', () => {
  assert.doesNotMatch(render(''), /Playlist details/)
})

test('the drawer lists entries in playlist order in the shared table', () => {
  const html = drawerOf(render('playlist=playlist-1'))
  assert.match(html, /<h1[^>]*>Synthetic mix<\/h1>/)
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
    /<table class="compact-table" aria-label="Playlist tracks">[\s\S]*?<\/table>/,
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
  assert.match(table, /href="\/tracks\/track-1"[^>]*>Opening track</)
  assert.match(table, /href="\/albums\/album-1"[^>]*>Spotify album</)
  assert.match(table, /href="\/albums\/album-2"[^>]*>Member album</)
  assert.match(html, /3 of 3 loaded/)
  // Playback is off: row numbers only.
  assert.doesNotMatch(table, /aria-label="Play /)
  assert.match(html, /aria-selected="true"[^>]*>Tracks</)
})

test('track rows have play and queue buttons while playback is on', () => {
  const html = drawerOf(
    render('playlist=playlist-1', detail(), {
      ...idlePlaybackState,
      enabled: true,
    }),
  )
  assert.match(html, /aria-label="Play Opening track"/)
  assert.match(html, /aria-label="Play Closing track"/)
  assert.match(html, /aria-label="Add Closing track to queue"/)
  assert.doesNotMatch(html, /aria-label="Play Member album"/)
})

test('the sync tab shows the schedule, progress and the latest job', () => {
  const html = drawerOf(render('playlist=playlist-1&tab=sync'))
  assert.match(html, /aria-selected="true"[^>]*>Sync</)
  assert.match(html, /<option value="daily" selected="">Daily<\/option>/)
  for (const label of [
    'Off',
    'Every hour',
    'Every 3 hours',
    'Every 6 hours',
    'Weekly',
  ])
    assert.match(html, new RegExp(`>${label}</option>`))
  assert.match(html, /2 of 5 pages/)
  assert.match(html, /Import in progress/)
  assert.match(html, /data-status="running"[^>]*>Importing</)
  assert.match(html, /href="\/jobs\?jobId=job-1&amp;mediaType=album"/)
  assert.match(html, /disabled=""[^>]*>Sync now</)
  assert.match(html, /<progress[^>]*value="2"[^>]*max="5"/)
})

test('the sync tab explains a missing next sync after a failed import', () => {
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
  const html = drawerOf(render('playlist=playlist-1&tab=sync', failed))
  assert.match(html, /2 pages</)
  assert.doesNotMatch(html, /2 of/)
  assert.match(html, /the last import failed\. Sync now to resume\./)
  assert.match(html, /role="alert">Spotify refused the playlist\./)
  assert.doesNotMatch(html, /disabled=""[^>]*>Sync now</)
  assert.doesNotMatch(html, /<progress/)
})

test('a legacy playlist says in one line that it is not synced', () => {
  const legacy = detail(
    PlaylistSummarySchema.parse({
      ...summary,
      source: null,
      spotifyUrl: null,
      sync: undefined,
    }),
  )
  const html = drawerOf(render('playlist=playlist-1&tab=sync', legacy))
  assert.match(html, /This playlist is not synced from Spotify\./)
  assert.doesNotMatch(html, /Sync now|<select/)
})

test('the Tracks browser opens the same drawer and filters itself by the playlist', async () => {
  const { default: TrackBrowser } = await import('./track-browser')
  const html = drawerOf(
    render(
      'playlist=playlist-1&item=track-9',
      detail(),
      undefined,
      <TrackBrowser />,
      '/tracks',
    ),
  )
  assert.match(
    html,
    /href="\/playlists\?playlist=playlist-1">Open in Playlists</,
  )
  assert.match(html, /<button[^>]*>Filter tracks<\/button>/)
  assert.match(
    html,
    /<button type="button" class="table-title">Opening track<\/button>/,
  )
  assert.doesNotMatch(html, /aria-label="Track details"/)
})

test('playlist data columns share sortable headers and column controls', () => {
  const html = render('')
  for (const label of [
    'Playlist',
    'Source',
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
})

test('playlist entries expose sorting for every data column', () => {
  const html = drawerOf(render('playlist=playlist-1'))
  for (const label of ['Title', 'Artists', 'Album', 'Duration', 'Added'])
    assert.match(html, new RegExp(`<button[^>]*>[^<]*${label}`))
  assert.match(html, /> Columns</)
})

test('playlist columns sort numeric counts and keep unknown dates last', () => {
  const rows = [
    {
      ...summary,
      id: 'ten',
      trackCount: 10,
      linkedTrackCount: 8,
      ownerName: 'Zed',
      createdAt: null,
    },
    {
      ...summary,
      id: 'two',
      trackCount: 2,
      linkedTrackCount: 1,
      ownerName: 'Ada',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ]
  const sorted = (key: PlaylistSortKey, direction: 'asc' | 'desc') =>
    sortTableRows(rows, { key, direction }, playlistSortValue).map(
      (row) => row.id,
    )
  assert.deepEqual(sorted('tracks', 'asc'), ['two', 'ten'])
  assert.deepEqual(sorted('linkedTracks', 'desc'), ['ten', 'two'])
  assert.deepEqual(sorted('owner', 'asc'), ['two', 'ten'])
  assert.deepEqual(sorted('added', 'desc'), ['two', 'ten'])
})

test('playlist date sorting compares instants across timestamp offsets', () => {
  const rows = [
    { ...summary, id: 'later', createdAt: '2026-01-01T00:00:00Z' },
    { ...summary, id: 'earlier', createdAt: '2026-01-01T01:00:00+02:00' },
  ]
  assert.deepEqual(
    sortTableRows(
      rows,
      { key: 'added', direction: 'asc' },
      playlistSortValue,
    ).map((row) => row.id),
    ['earlier', 'later'],
  )
  const date = '2026-01-01T01:00:00+02:00'
  const dated = {
    ...summary,
    createdAt: date,
    importedAt: date,
    sync: { ...summary.sync, lastCheckedAt: date, nextScheduledAt: date },
  }
  const keys: PlaylistSortKey[] = ['added', 'imported', 'checked', 'nextSync']
  for (const key of keys)
    assert.equal(playlistSortValue(dated, key), Date.parse(date))
})
