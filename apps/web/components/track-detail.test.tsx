import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TrackDetailSchema, type TrackDetail } from '@repo/schemas/tracks'
import TrackDetailView from './track-detail'
import { ConfigContext } from './providers'
import { PlaybackViewContext } from './playback-provider'
import { idlePlaybackState } from '@/utils/playback-engine'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const scrobbled = TrackDetailSchema.parse({
  id: 'lastfm-track',
  mediaType: 'track',
  title: 'Synthetic track',
  artworkUrl: null,
  releaseDate: null,
  artists: ['Example artist'],
  albumName: 'Recorded album',
  album: null,
  albumLinkStrategy: null,
  albumTags: [],
  playlists: [],
  sources: ['lastfm'],
  durationSec: null,
  dateAdded: '2026-01-02T00:00:00.000Z',
  spotifyTrackId: null,
  spotifyMatch: 'unmatched',
  spotifyUrl: null,
  isrc: null,
  scrobbles: 3,
  lastListenedAt: '2026-01-04T00:00:00.000Z',
  lastfmSources: [
    {
      artistName: 'Example artist',
      trackName: 'Synthetic track',
      albumNames: ['Recorded album'],
      count: 3,
      manuallyMatched: false,
    },
  ],
  listening: {
    total: 3,
    firstListenedAt: '2026-01-02T00:00:00.000Z',
    lastListenedAt: '2026-01-04T00:00:00.000Z',
    months: [{ month: '2026-01', count: 3 }],
    sources: [
      {
        artistName: 'Example artist',
        trackName: 'Synthetic track',
        count: 3,
        strategy: 'exact',
      },
    ],
  },
})

function render(item: TrackDetail, filters = '') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['track', item.id], item)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams(filters)}>
            <PlaybackViewContext.Provider
              value={{ ...idlePlaybackState, enabled: true }}
            >
              <TrackDetailView id={item.id} />
            </PlaybackViewContext.Provider>
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('unmatched Last.fm tracks show recorded metadata, listening and an actionable source filter', () => {
  const html = render(scrobbled)
  assert.match(html, /Synthetic track/)
  assert.match(html, /Example artist/)
  assert.match(html, /Recorded album/)
  assert.match(html, /<dt>Duration<\/dt><dd>-<\/dd>/)
  assert.match(html, /No Spotify match for playback\./)
  assert.match(html, /Recorded by Last.fm/)
  assert.match(html, /Spotify has not been searched for this track/)
  assert.doesNotMatch(html, />Play<\/button>|>Add to queue<\/button>/)
  assert.match(html, /<h2>Listening<\/h2>/)
  assert.match(html, /<dt>Scrobbles<\/dt><dd>3<\/dd>/)
  const sourceLink = html.match(/href="([^\"]+)">Last.fm<\/a>/)?.[1]
  assert.ok(sourceLink)
  const params = new URL(sourceLink, 'http://localhost').searchParams
  assert.deepEqual(JSON.parse(params.get('filters') ?? '[]'), [
    { field: 'source', value: 'Last.fm' },
  ])
})

test('tracks with a Spotify match keep album metadata, playback and every source', () => {
  const matched = TrackDetailSchema.parse({
    ...scrobbled,
    album: { id: 'album-1', title: 'Library album' },
    albumTags: ['Electronic'],
    durationSec: 243,
    releaseDate: '2020-01-01T00:00:00.000Z',
    sources: ['lastfm', 'spotify', 'spotify-liked'],
    spotifyTrackId: '1234567890ABCDEFGHIJKL',
    spotifyMatch: 'spotify-import',
    spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
  })
  const html = render(matched)
  assert.match(html, /href="\/albums\/album-1">Open album<\/a>/)
  assert.match(html, /Electronic/)
  assert.match(html, /<dt>Duration<\/dt><dd>4:03<\/dd>/)
  assert.match(html, />Play<\/button>/)
  assert.match(html, />Add to queue<\/button>/)
  assert.match(html, />Last.fm<\/a>/)
  assert.match(html, />Spotify playlists<\/a>/)
  assert.match(html, />Liked Songs<\/a>/)
  assert.doesNotMatch(html, /No Spotify match/)
  assert.match(html, /Spotify ID came from a playlist or Liked Songs import/)
  assert.match(html, /unique artist and title match/)
})

test('album-derived Spotify IDs explain the exact fallback without claiming verification', () => {
  const html = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      album: { id: 'album-1', title: 'Library album' },
      spotifyTrackId: '1234567890ABCDEFGHIJKL',
      spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
      spotifyMatch: 'album-track-list',
    }),
  )
  assert.match(html, /exactly one track has the same title/)
  assert.match(html, /has not been checked against Spotify/)
  assert.doesNotMatch(html, /Spotify ID came from a playlist/)
})

test('manual source choices are identified separately from automatic matches', () => {
  const html = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      spotifyTrackId: '1234567890ABCDEFGHIJKL',
      spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
      spotifyMatch: 'spotify-import',
      lastfmSources: scrobbled.lastfmSources.map((source) => ({
        ...source,
        manuallyMatched: true,
      })),
    }),
  )
  assert.match(html, /chosen manually/)
  assert.match(html, /Manually matched/)
  assert.doesNotMatch(html, /unique artist and title match/)
})

test('source metadata reflects an active exclusion filter', () => {
  const filters = new URLSearchParams({
    filters: JSON.stringify([
      { field: 'source', value: 'Last.fm', mode: 'exclude' },
    ]),
  })
  assert.match(
    render(scrobbled, filters.toString()),
    /class="metadata-tag[^\"]*exclude[^\"]*"[^>]*>Last.fm<\/a>/,
  )
})
