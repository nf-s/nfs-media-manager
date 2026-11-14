import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import { PlaylistSummarySchema } from '@repo/schemas/tracks'
import TrackPlaylistAdditions from './track-playlist-additions'
import { TrackPlaylistAdditionsSchema } from '@repo/schemas/track-playlist-additions'
import { resolvedTrackReplacement } from './playlist-addition-controls'
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

const noAdditions = TrackPlaylistAdditionsSchema.parse({ additions: [] })
function render(
  connected = account,
  spotifyTrackId: string | null = '1234567890ABCDEFGHIJKL',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['spotify-account'], connected)
  client.setQueryData(['playlists'], playlists)
  client.setQueryData(['track-playlist-additions', 'track-1'], noAdditions)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <TrackPlaylistAdditions
            track={{ id: 'track-1', spotifyTrackId }}
            onResolved={() => {
              throw new Error('No navigation on render')
            }}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('a matched track offers only writable imported playlists', () => {
  const html = render()
  assert.match(html, /Add to playlist/)
  assert.match(html, /Synthetic mix/)
  assert.doesNotMatch(html, /Followed list/)
})

test('unmatched tracks explain the prerequisite without offering a Spotify write', () => {
  const html = render(account, null)
  assert.match(html, /Match this track to Spotify/)
  assert.doesNotMatch(html, /popoverTarget|Allow playlist changes/)
})

test('track permission and connection controls retain Tracks context', () => {
  assert.match(
    render({ ...account, playlistChanges: false }),
    /Allow playlist changes/,
  )
  assert.doesNotMatch(
    render({ ...account, playlistChanges: false }),
    /Add to playlist/,
  )
  assert.match(
    render({ ...account, connected: false }),
    /href="\/imports\/spotify-playlists\?mediaType=track">Connect Spotify/,
  )
})

test('identity replacement requires a completed addition and a different resolved track', () => {
  const addition = {
    playlistId: 'p1',
    resolvedTrackId: 'retained',
    job: {
      jobId: 'j1',
      status: 'succeeded',
      errorMessage: null,
      finishedAt: null,
      progress: null,
    },
  }
  const parsed = TrackPlaylistAdditionsSchema.parse({
    additions: [{ ...addition, trackId: 'source' }],
  }).additions
  assert.equal(resolvedTrackReplacement('source', parsed), 'retained')
  assert.equal(resolvedTrackReplacement('retained', parsed), null)
  assert.equal(
    resolvedTrackReplacement(
      'source',
      parsed.map((item) => ({
        ...item,
        job: { ...item.job, status: 'running' },
      })),
    ),
    null,
  )
  assert.equal(
    resolvedTrackReplacement(
      'source',
      parsed.map((item) => ({ ...item, resolvedTrackId: null })),
    ),
    null,
  )
})
