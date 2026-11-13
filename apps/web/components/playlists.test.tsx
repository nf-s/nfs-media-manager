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
  AlbumPlaylistsSchema,
  PlaylistSummarySchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
} from '@repo/schemas/tracks'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import AlbumPlaylists from './album-playlists'
import PlaylistsWorkspace from './playlists-workspace'
import SpotifyPlaylistImport from './spotify-playlist-import'
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

const filterParam = (name: string) =>
  new URLSearchParams({
    filters: JSON.stringify([
      { field: 'playlist', value: name, mode: 'required' },
    ]),
  })
    .toString()
    .replaceAll('&', '&amp;')

test('playlists table links tracks and albums filtered by playlist and labels sources', () => {
  const html = render(<PlaylistsWorkspace />, [
    [
      ['playlists'],
      [playlist, { ...playlist, id: 'legacy', name: 'Old list', source: null }],
    ],
  ])
  assert.ok(html.includes(`href="/tracks?${filterParam('Synthetic mix')}"`))
  assert.ok(html.includes(`href="/albums?${filterParam('Synthetic mix')}"`))
  assert.match(html, /7 of 12/)
  assert.match(html, /1 h 5 min/)
  assert.match(html, />Spotify</)
  assert.match(html, />Library</)
  assert.equal((html.match(/>Remove</g) ?? []).length, 1)
  assert.match(html, /aria-sort="ascending"><button[^>]*>Playlist ↑/)
  assert.match(html, /href="\/imports\/spotify-playlists\?mediaType=album"/)
})

test('an empty playlist table links to the import page', () => {
  const html = render(<PlaylistsWorkspace />, [[['playlists'], []]])
  assert.match(html, /No playlists\./)
  assert.match(html, /Import playlists/)
})

test('album playlists render nothing without memberships and pills with track counts otherwise', () => {
  const empty = AlbumPlaylistsSchema.parse({ playlists: [], tracks: [] })
  assert.equal(
    render(<AlbumPlaylists albumId="album-1" />, [
      [['album-playlists', 'album-1'], empty],
    ]),
    '',
  )
  const html = render(<AlbumPlaylists albumId="album-1" />, [
    [
      ['album-playlists', 'album-1'],
      AlbumPlaylistsSchema.parse({
        playlists: [
          { id: 'p1', name: 'Synthetic mix', trackCount: 2 },
          { id: 'p2', name: 'Old list', trackCount: 0 },
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
  assert.ok(
    html.includes(
      `class="metadata-tag" href="/albums?${filterParam('Synthetic mix')}"`,
    ),
  )
  assert.match(html, /2 tracks/)
  assert.doesNotMatch(html, /0 tracks/)
  assert.match(html, /Tracks in the track library/)
  assert.match(html, /href="\/tracks\/track-1">First track/)
})

test('playlist import asks to reconnect when the connection lacks playlist access', () => {
  const html = render(<SpotifyPlaylistImport />, [
    [['spotify-account'], { ...account, playlists: false }],
  ])
  assert.match(html, /does not include playlist access/)
  assert.match(html, /Reconnect Spotify/)
  assert.doesNotMatch(html, /List playlists|Liked Songs/)
})

test('playlist import keeps Liked Songs separate and lists only after an explicit request', () => {
  const imports = SpotifyPlaylistImportsSchema.parse({
    likedSongs: {
      stored: {
        playlistId: 'liked',
        importedAt: '2026-01-02T00:00:00.000Z',
        trackCount: 40,
      },
      job: null,
    },
    jobs: {},
  })
  const before = render(<SpotifyPlaylistImport />, [
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
  ])
  assert.match(before, /Liked Songs/)
  assert.match(before, /40 tracks/)
  assert.match(before, />Import again</)
  assert.match(before, />List playlists</)
  assert.doesNotMatch(before, /Import selected/)

  const base = {
    ownerName: 'Example owner',
    importable: true,
    trackTotal: 10,
    artworkUrl: null,
    stored: null,
    current: true,
    job: null,
  }
  const html = render(<SpotifyPlaylistImport />, [
    [['spotify-account'], account],
    [
      ['spotify-playlist-imports'],
      {
        ...imports,
        jobs: {
          '1234567890ABCDEFGHIJK1': {
            jobId: 'job-1',
            status: 'running',
            errorMessage: null,
            finishedAt: null,
          },
        },
      },
    ],
    [
      ['spotify-playlists'],
      SpotifyPlaylistListSchema.parse({
        total: 4,
        playlists: [
          { ...base, spotifyId: '1234567890ABCDEFGHIJK1', name: 'Running' },
          {
            ...base,
            spotifyId: '1234567890ABCDEFGHIJK2',
            name: 'Followed',
            importable: false,
          },
          {
            ...base,
            spotifyId: '1234567890ABCDEFGHIJK3',
            name: 'Huge',
            trackTotal: 10001,
          },
          {
            ...base,
            spotifyId: '1234567890ABCDEFGHIJK4',
            name: 'Stored',
            stored: { playlistId: 'p4', importedAt: null, trackCount: 5 },
            current: false,
          },
        ],
      }),
    ],
  ])
  assert.match(html, /List playlists again/)
  assert.equal((html.match(/owns or collaborates on/g) ?? []).length, 1)
  assert.match(html, /data-status="running"[^>]*>Importing\.\.\.</)
  assert.match(html, /Over 10,000 tracks, cannot be imported/)
  assert.match(html, /Changed on Spotify/)
  for (const name of ['Running', 'Followed', 'Huge'])
    assert.match(html, new RegExp(`aria-label="Select ${name}" disabled=""`))
  assert.doesNotMatch(html, /aria-label="Select Stored" disabled=""/)
  assert.match(html, /0 selected/)
  assert.match(html, /disabled=""[^>]*>Import selected/)
})
