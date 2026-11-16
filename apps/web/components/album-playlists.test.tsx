import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  AlbumPlaylistsSchema,
  PlaylistAlbumAdditionsSchema,
  PlaylistSummarySchema,
} from '@repo/schemas/tracks'
import AlbumPlaylists from './album-playlists'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const account = SpotifyAccountStatusSchema.parse({
  configured: true,
  connected: true,
  expiresAt: null,
  scope: null,
  redirectUri: null,
  playback: false,
  playlists: true,
  playlistChanges: true,
})

const summary = {
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
}

const playlists = [
  PlaylistSummarySchema.parse({
    ...summary,
    id: 'p1',
    name: 'Synthetic mix',
    acceptsAdditions: true,
  }),
  PlaylistSummarySchema.parse({
    ...summary,
    id: 'p2',
    name: 'Followed list',
    acceptsAdditions: false,
  }),
  PlaylistSummarySchema.parse({
    ...summary,
    id: 'p3',
    name: 'Second mix',
    acceptsAdditions: true,
  }),
]

const empty = AlbumPlaylistsSchema.parse({ playlists: [], tracks: [] })
const noAdditions = PlaylistAlbumAdditionsSchema.parse({ additions: [] })
const pickerKey = ['playlists', 'picker', '', 1]

function pickerPage(
  items = playlists.filter((playlist) => playlist.acceptsAdditions),
) {
  return { items, page: 1, size: 25, hasMore: false, totalCount: items.length }
}

function render(data: Array<[unknown[], unknown]>) {
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
          <AlbumPlaylists albumId="album-1" />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('album playlists list memberships without a duplicate track library section', () => {
  const html = render([
    [['spotify-account'], account],
    [['playlist-additions', 'album-1'], noAdditions],
    [
      ['album-playlists', 'album-1'],
      AlbumPlaylistsSchema.parse({
        playlists: [
          { id: 'p1', name: 'Synthetic mix', trackCount: 2 },
          { id: 'p9', name: 'Old list', trackCount: 0 },
        ],
        tracks: [
          {
            id: 'track-1',
            title: 'First track',
            spotifyTrackId: '1234567890ABCDEFGHIJKL',
            playlists: ['Synthetic mix'],
          },
        ],
      }),
    ],
  ])
  assert.ok(html.includes('class="metadata-tag" href="/playlists/p1"'))
  assert.match(html, /2 tracks/)
  assert.doesNotMatch(html, /0 tracks/)
  assert.doesNotMatch(html, /Tracks in the track library/)
  assert.doesNotMatch(html, /href="\/tracks\/track-1"/)
})

test('add to playlist offers only playlists that accept albums, even with no memberships', () => {
  const html = render([
    [['spotify-account'], account],
    [pickerKey, pickerPage()],
    [['playlist-additions', 'album-1'], noAdditions],
    [['album-playlists', 'album-1'], empty],
  ])
  assert.match(html, /aria-label="Playlist memberships"/)
  assert.match(html, /popoverTarget="[^"]+"[^>]*>Add to playlist</)
  assert.match(html, /popover="auto"/)
  assert.match(html, />Synthetic mix<span class="quiet"> · 12 tracks/)
  assert.match(html, />Second mix</)
  assert.doesNotMatch(html, /Followed list/)
  assert.doesNotMatch(html, /Filter playlists/)
})

test('a long picker keeps server-backed scroll space and an empty picker explains eligibility', () => {
  const firstPage = Array.from({ length: 25 }, (_, index) =>
    PlaylistSummarySchema.parse({
      ...summary,
      id: `mix-${index}`,
      name: `Mix ${index}`,
      acceptsAdditions: true,
    }),
  )
  const long = render([
    [['spotify-account'], account],
    [
      pickerKey,
      { ...pickerPage(firstPage), hasMore: true, totalCount: undefined },
    ],
    [['playlists', 'picker-count', ''], { totalCount: 800 }],
    [['playlist-additions', 'album-1'], noAdditions],
    [['album-playlists', 'album-1'], empty],
  ])
  assert.match(long, /aria-label="Filter playlists"/)
  assert.match(long, /aria-setsize="800"/)
  const reservedHeight = /<li aria-hidden="true" style="height:(\d+)px"/.exec(
    long,
  )?.[1]
  assert.ok(Number(reservedHeight) > 24000)
  assert.match(
    render([
      [['spotify-account'], account],
      [['playlists', 'picker-count', ''], { totalCount: 800 }],
      [['playlist-additions', 'album-1'], noAdditions],
      [['album-playlists', 'album-1'], empty],
    ]),
    /virtual-browse-placeholder/,
  )
  assert.match(
    render([
      [['spotify-account'], account],
      [pickerKey, pickerPage([])],
      [['playlist-additions', 'album-1'], noAdditions],
      [['album-playlists', 'album-1'], empty],
    ]),
    /No imported playlist accepts albums\./,
  )
})

test('a connection without playlist changes offers to allow them instead', () => {
  const html = render([
    [['spotify-account'], { ...account, playlistChanges: false }],
    [['playlist-additions', 'album-1'], noAdditions],
    [['album-playlists', 'album-1'], empty],
  ])
  assert.match(html, /The Spotify connection does not allow playlist changes\./)
  assert.match(html, />Allow playlist changes</)
  assert.doesNotMatch(html, /Add to playlist/)
})

test('without a Spotify connection the control links to the playlist import page', () => {
  const html = render([
    [['spotify-account'], { ...account, connected: false, playlists: false }],
    [['playlist-additions', 'album-1'], noAdditions],
    [['album-playlists', 'album-1'], empty],
  ])
  assert.match(
    html,
    /href="\/imports\/spotify-playlists\?mediaType=album">Connect Spotify/,
  )
  assert.doesNotMatch(html, /Add to playlist|Allow playlist changes/)
})

test('additions show queued, adding with progress, added and failed states', () => {
  const job = {
    errorMessage: null,
    finishedAt: null,
    progress: null,
  }
  const html = render([
    [['spotify-account'], account],
    [pickerKey, pickerPage()],
    [['playlists', 'related', ['gone', 'p1', 'p2', 'p3']], playlists],
    [['album-playlists', 'album-1'], empty],
    [
      ['playlist-additions', 'album-1'],
      PlaylistAlbumAdditionsSchema.parse({
        additions: [
          {
            playlistId: 'p1',
            albumId: 'album-1',
            job: { ...job, jobId: 'a1', status: 'queued' },
          },
          {
            playlistId: 'p3',
            albumId: 'album-1',
            job: {
              ...job,
              jobId: 'a2',
              status: 'running',
              progress: { pagesRead: 1, totalPages: 2 },
            },
          },
          {
            playlistId: 'p2',
            albumId: 'album-1',
            job: {
              ...job,
              jobId: 'a3',
              status: 'succeeded',
              finishedAt: '2026-01-02T00:00:00.000Z',
            },
          },
          {
            playlistId: 'gone',
            albumId: 'album-1',
            job: {
              ...job,
              jobId: 'a4',
              status: 'failed',
              errorMessage: 'The album has no Spotify album reference.',
            },
          },
        ],
      }),
    ],
  ])
  assert.match(
    html,
    /<li>Synthetic mix <a[^>]*data-status="queued"[^>]*>Queued</,
  )
  assert.match(
    html,
    /<li>Second mix <a[^>]*data-status="running"[^>]*>Adding<\/a><span class="quiet"> 1 of 2 pages/,
  )
  assert.match(
    html,
    /<li>Followed list <a[^>]*data-status="succeeded"[^>]*>Added<\/a><span class="quiet"> <time dateTime="2026-01-02T00:00:00.000Z">/,
  )
  assert.match(html, /<li>Playlist <a[^>]*data-status="failed"[^>]*>Failed</)
  assert.match(html, /role="alert">The album has no Spotify album reference\./)
  assert.match(html, /href="\/jobs\/a2"/)
  assert.match(html, /disabled=""[^>]*>Synthetic mix</)
})
