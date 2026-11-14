import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  PlaylistSummarySchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
} from '@repo/schemas/tracks'
import SpotifyPlaylistImport, {
  importPlaylistSortValue,
  type ImportPlaylistSortKey,
} from './spotify-playlist-import'
import { sortTableRows } from '@/utils/secondary-table'
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

const row = {
  ownerName: 'Example owner',
  importable: true,
  trackTotal: 10,
  artworkUrl: null,
  stored: null,
  current: true,
  job: null,
}

const listing = SpotifyPlaylistListSchema.parse({
  total: 5,
  listedAt: '2026-01-03T00:00:00.000Z',
  job: null,
  playlists: [
    {
      ...row,
      spotifyId: '1234567890ABCDEFGHIJK1',
      name: 'Running',
      job: {
        jobId: 'job-1',
        status: 'running',
        errorMessage: null,
        finishedAt: null,
        progress: { pagesRead: 2, totalPages: 5 },
      },
    },
    {
      ...row,
      spotifyId: '1234567890ABCDEFGHIJK2',
      name: 'Followed',
      importable: false,
      notImportableReason: 'Owned by someone else fixture reason.',
    },
    {
      ...row,
      spotifyId: '1234567890ABCDEFGHIJK3',
      name: 'Huge',
      trackTotal: 10001,
    },
    {
      ...row,
      spotifyId: '1234567890ABCDEFGHIJK4',
      name: 'Stored',
      stored: {
        playlistId: 'p4',
        importedAt: '2026-01-02T00:00:00.000Z',
        trackCount: 5,
      },
      current: false,
    },
    {
      ...row,
      spotifyId: '1234567890ABCDEFGHIJK5',
      name: 'Broken',
      job: {
        jobId: 'job-5',
        status: 'failed',
        errorMessage: 'Spotify refused the fixture request.',
        finishedAt: '2026-01-02T00:00:00.000Z',
        progress: { pagesRead: 1, totalPages: 3 },
      },
    },
  ],
})

const stored = PlaylistSummarySchema.parse({
  id: 'p4',
  name: 'Stored',
  source: 'spotify',
  ownerName: 'Example owner',
  description: null,
  artworkUrl: null,
  spotifyUrl: null,
  importedAt: '2026-01-02T00:00:00.000Z',
  trackCount: 5,
  linkedTrackCount: 2,
  albumCount: 1,
  durationSec: 1200,
  acceptsAdditions: true,
  sync: {
    syncable: true,
    schedule: 'daily',
    lastCheckedAt: '2026-01-04T00:00:00.000Z',
    nextScheduledAt: '2026-01-05T00:00:00.000Z',
    job: null,
  },
})

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
          <PathnameContext.Provider value="/imports/spotify-playlists">
            <SearchParamsContext.Provider value={new URLSearchParams()}>
              <SpotifyPlaylistImport />
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

test('playlist import asks to reconnect when the connection lacks playlist access', () => {
  const html = render([[['spotify-account'], { ...account, playlists: false }]])
  assert.match(html, /does not include playlist access/)
  assert.match(html, /Reconnect Spotify/)
  assert.doesNotMatch(html, /List playlists|Liked Songs|compact-table/)
})

test('the stored list renders in the shared table without a listing request', () => {
  const html = render([
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
    [['spotify-playlists'], listing],
    [['playlists'], [stored]],
  ])
  assert.match(
    html,
    /class="table-scroll tags-scroll secondary-table-scroll" role="region" aria-label="Spotify playlists"/,
  )
  assert.match(
    html,
    /<table class="compact-table" aria-label="Spotify playlists"/,
  )
  assert.equal((html.match(/<table/g) ?? []).length, 1)
  assert.match(html, /film-import-workflow table-workspace/)
  assert.match(html, />List again</)
  assert.doesNotMatch(html, /disabled=""[^>]*>List again/)
  assert.match(html, /Listed /)
  assert.match(html, /40 tracks/)
  assert.match(html, />Import again</)
  assert.match(html, /5 of 5 playlists · 0 selected/)
  assert.doesNotMatch(html, /Allow playlist changes/)
})

test('rows show import state, progress, reasons, schedule and drawer links', () => {
  const html = render([
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
    [['spotify-playlists'], listing],
    [['playlists'], [stored]],
  ])
  assert.match(
    html,
    /data-status="running"[^>]*>Importing<\/a><span class="muted"> 2 of 5 pages/,
  )
  assert.match(html, /data-status="failed"[^>]*>Failed</)
  assert.match(html, /Spotify refused the fixture request\./)
  assert.doesNotMatch(html, /1 of 3 pages/)
  assert.match(html, /Owned by someone else fixture reason\./)
  assert.match(html, /Over 10,000 tracks, cannot be imported\./)
  assert.match(html, /Imported [^<]* · 5 tracks · Changed on Spotify/)
  assert.match(
    html,
    /<a class="font-medium hover:underline" href="\/playlists\?playlist=p4">Stored<\/a>/,
  )
  assert.match(html, /href="\/playlists\?playlist=p4&amp;tab=sync"[^>]*>Daily</)
  assert.match(html, /<time dateTime="2026-01-04T00:00:00.000Z">/)
  assert.match(html, />Not imported</)
  for (const name of ['Running', 'Followed', 'Huge'])
    assert.match(html, new RegExp(`aria-label="Select ${name}" disabled=""`))
  for (const name of ['Stored', 'Broken'])
    assert.doesNotMatch(
      html,
      new RegExp(`aria-label="Select ${name}" disabled=""`),
    )
  assert.match(html, /disabled=""[^>]*>Import selected/)
})

test('an unlisted account offers List playlists and an empty table state', () => {
  const html = render([
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
    [
      ['spotify-playlists'],
      SpotifyPlaylistListSchema.parse({ playlists: [], total: 0 }),
    ],
  ])
  assert.match(html, />List playlists</)
  assert.match(html, /nothing is imported/)
  assert.match(html, /No stored playlist list\./)
})

test('a listing in progress shows its page, polls and disables the button', () => {
  const running = {
    ...listing,
    job: {
      jobId: 'listing-1',
      status: 'running',
      errorMessage: null,
      finishedAt: null,
      progress: { pagesRead: 1, totalPages: null },
    },
  }
  const html = render([
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
    [['spotify-playlists'], running],
  ])
  assert.match(html, /disabled=""[^>]*>List again/)
  assert.match(
    html,
    /data-status="running"[^>]*>Listing<\/a><span class="muted"> 1 page</,
  )
  assert.match(
    render([
      [['spotify-account'], account],
      [['spotify-playlist-imports'], imports],
      [
        ['spotify-playlists'],
        {
          ...running,
          job: {
            ...running.job,
            progress: { pagesRead: 2, totalPages: 4 },
          },
        },
      ],
    ]),
    /2 of 4 pages/,
  )
})

test('a failed listing shows its message and keeps the stored list', () => {
  const html = render([
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
    [
      ['spotify-playlists'],
      {
        ...listing,
        job: {
          jobId: 'listing-2',
          status: 'failed',
          errorMessage: 'Spotify is cooling down.',
          finishedAt: '2026-01-04T00:00:00.000Z',
          progress: { pagesRead: 1, totalPages: 3 },
        },
      },
    ],
  ])
  assert.match(
    html,
    /role="alert">The last listing failed: Spotify is cooling down\./,
  )
  assert.match(
    html,
    /href="\/jobs\?jobId=listing-2&amp;mediaType=album">View job/,
  )
  assert.doesNotMatch(html, /disabled=""[^>]*>List again/)
  assert.match(html, /aria-label="Select Stored"/)
})

test('a connection without playlist changes offers to allow them', () => {
  const html = render([
    [['spotify-account'], { ...account, playlistChanges: false }],
    [['spotify-playlist-imports'], imports],
    [['spotify-playlists'], listing],
  ])
  assert.match(
    html,
    /Adding albums to playlists needs playlist change access\./,
  )
  assert.match(html, />Allow playlist changes</)
})

test('playlist import has sortable data columns and a column picker', () => {
  const html = render([
    [['spotify-account'], account],
    [['spotify-playlist-imports'], imports],
    [['spotify-playlists'], listing],
    [['playlists'], [stored]],
  ])
  for (const label of [
    'Playlist',
    'Owner',
    'Tracks',
    'Import',
    'Schedule',
    'Last checked',
    'Added to library',
  ])
    assert.match(html, new RegExp(`<button[^>]*>[^<]*${label}`))
  assert.match(html, /> Columns</)
})

test('import sorting uses counts and stored library dates with missing dates last', () => {
  const values = (key: ImportPlaylistSortKey, direction: 'asc' | 'desc') =>
    sortTableRows(listing.playlists, { key, direction }, (playlist, column) =>
      importPlaylistSortValue(
        playlist,
        playlist.stored
          ? { ...stored, createdAt: '2026-01-01T00:00:00.000Z' }
          : undefined,
        column,
      ),
    ).map((playlist) => playlist.name)
  assert.equal(values('tracks', 'desc')[0], 'Huge')
  assert.equal(values('added', 'asc')[0], 'Stored')
  assert.equal(values('added', 'desc')[0], 'Stored')
  assert.equal(values('owner', 'asc').length, 5)
})

test('import dates sort by timestamp rather than displayed text', () => {
  const base = listing.playlists.find((playlist) => playlist.stored)
  assert.ok(base?.stored)
  const date = '2026-01-01T01:00:00+02:00'
  const playlist = { ...base, stored: { ...base.stored, importedAt: date } }
  const summary = {
    ...stored,
    createdAt: date,
    sync: { ...stored.sync, lastCheckedAt: date, nextScheduledAt: date },
  }
  const keys: ImportPlaylistSortKey[] = [
    'added',
    'imported',
    'checked',
    'nextSync',
  ]
  for (const key of keys)
    assert.equal(
      importPlaylistSortValue(playlist, summary, key),
      Date.parse(date),
    )
})
