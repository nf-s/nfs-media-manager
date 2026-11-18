import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TrackDetailSchema, type TrackDetail } from '@repo/schemas/tracks'
import type { SpotifyTrackSearchJob } from '@repo/schemas/spotify-track-search'
import TrackDetailView, { TrackSources } from './track-detail'
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
  artistCredits: [{ id: 'fixture-artist', name: 'Example artist' }],
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
      artistKey: 'example artist',
      trackKey: 'synthetic track',
      artistName: 'Example artist',
      trackName: 'Synthetic track',
      albumNames: ['Recorded album'],
      count: 3,
      manuallyMatched: false,
      keptSeparate: false,
    },
  ],
  listening: {
    total: 3,
    firstListenedAt: '2026-01-02T00:00:00.000Z',
    lastListenedAt: '2026-01-04T00:00:00.000Z',
    months: [{ month: '2026-01', count: 3 }],
    sources: [
      {
        artistKey: 'example artist',
        trackKey: 'synthetic track',
        artistName: 'Example artist',
        trackName: 'Synthetic track',
        count: 3,
        strategy: 'exact',
      },
    ],
  },
})

function render(
  item: TrackDetail,
  filters = '',
  view: 'detail' | 'sources' = 'detail',
  searchJob: SpotifyTrackSearchJob | null = null,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['track', item.id], item)
  client.setQueryData(['tracks', 'spotify-track-search', item.id], {
    job: searchJob,
    query: item.title,
    candidates: [],
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
          <SearchParamsContext.Provider value={new URLSearchParams(filters)}>
            <PlaybackViewContext.Provider
              value={{
                ...idlePlaybackState,
                enabled: true,
                connection: 'connected',
              }}
            >
              {view === 'sources' ? (
                <TrackSources item={item} />
              ) : (
                <TrackDetailView id={item.id} />
              )}
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

function pillHref(html: string, label: string) {
  const href = new RegExp(
    `href="([^"]+)"[^>]*><span class="ds-pill-label">${label}<`,
  ).exec(html)?.[1]
  assert.ok(href, `Expected a pill link for ${label}`)
  return JSON.parse(
    new URL(href.replaceAll('&amp;', '&'), 'http://localhost').searchParams.get(
      'filters',
    ) ?? '[]',
  )
}

test('unmatched Last.fm tracks show recorded metadata, listening and an actionable source filter', () => {
  const html = render(scrobbled)
  assert.match(html, /<h2 class="ds-detail-title">Synthetic track<\/h2>/)
  assert.match(
    html,
    /by <span class="inline-values"><a[^>]*href="\/artists\/fixture-artist">Example artist<\/a>/,
  )
  assert.match(html, /<\/span> · on Recorded album<\/div>/)
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(tabs, ['Overview', 'Sources'])
  assert.match(html, /<h3>Listening<\/h3>/)
  assert.match(html, /<h3>Appears on<\/h3>/)
  assert.match(html, /No playlist memberships\./)
  assert.match(html, /Match this track to Spotify to add it to a playlist/)
  assert.match(
    html,
    /href="https:\/\/www.last.fm\/music\/Example%20artist\/_\/Synthetic%20track"/,
  )
  assert.doesNotMatch(html, /Recorded by Last.fm|Spotify has not been searched/)
  assert.match(
    html,
    /aria-label="Play Synthetic track"[^>]*disabled=""[^>]*title="No Spotify recording is available\."|disabled=""[^>]*title="No Spotify recording is available\."[^>]*aria-label="Play Synthetic track"/,
  )
  assert.match(
    html,
    /<span class="ds-stat-value">3<\/span><span class="ds-stat-label">scrobbles</,
  )
  assert.deepEqual(pillHref(html, 'Last.fm'), [
    { field: 'source', value: 'Last.fm' },
  ])
  assert.match(
    render(scrobbled, 'tab=playlists'),
    /role="tab" aria-selected="true"[^>]*>Overview/,
  )
})

test('tracks with a Spotify match keep album metadata, playback and every source', () => {
  const matched = TrackDetailSchema.parse({
    ...scrobbled,
    album: { id: 'album-1', title: 'Library album' },
    albumTags: ['Electronic'],
    artistTags: ['Synth-pop'],
    durationSec: 243,
    releaseDate: '2020-01-01T00:00:00.000Z',
    sources: ['lastfm', 'spotify', 'spotify-liked'],
    spotifyTrackId: '1234567890ABCDEFGHIJKL',
    spotifyMatch: 'spotify-import',
    spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
  })
  const html = render(matched)
  assert.match(html, /href="\/albums\/album-1">Library album<\/a>/)
  assert.deepEqual(pillHref(html, 'Electronic'), [
    { field: 'albumTag', value: 'Electronic' },
  ])
  assert.match(html, /<h3>Album tags<\/h3>/)
  assert.match(html, /<h3>Artist tags<\/h3>/)
  assert.deepEqual(pillHref(html, 'Synth-pop'), [
    { field: 'artistTag', value: 'Synth-pop' },
  ])
  assert.match(html, /4:03/)
  assert.match(html, /aria-label="Play Synthetic track">.*Play<\/button>/)
  assert.match(
    html,
    /aria-label="Add Synthetic track to queue">.*Queue<\/button>/,
  )
  for (const source of ['Last.fm', 'Spotify playlists', 'Liked Songs'])
    assert.ok(pillHref(html, source).length)
  assert.doesNotMatch(html, /No Spotify match/)
  assert.match(html, /aria-label="Open at Spotify \(opens in a new tab\)"/)
  assert.match(
    html,
    /href="https:\/\/open.spotify.com\/track\/1234567890ABCDEFGHIJKL"/,
  )
  assert.match(render(matched, '', 'sources'), /unique artist and title match/)
})

test('Sources offers Spotify search on uncovered tracks and opens a verified alternate directly', () => {
  assert.match(render(scrobbled, '', 'sources'), />Search Spotify<\/button>/)
  const alternate = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      spotifyAlternate: {
        trackId: 'alternate-recording',
        name: 'Synthetic track',
        albumName: null,
        identifier: '1234567890ABCDEFGHIJKL',
      },
    }),
    '',
    'sources',
  )
  assert.match(alternate, /Other Spotify version/)
  assert.match(alternate, /href="\/tracks\/alternate-recording\?tab=sources"/)
  assert.doesNotMatch(alternate, />Search Spotify<\/button>/)
})

test('album-derived Spotify IDs identify the stored track list that supplied them', () => {
  const html = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      album: { id: 'album-1', title: 'Library album' },
      spotifyTrackId: '1234567890ABCDEFGHIJKL',
      spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
      spotifyMatch: 'album-track-list',
    }),
    '',
    'sources',
  )
  assert.match(html, /stored track list supplied the Spotify track ID/)
  assert.doesNotMatch(html, />Search Spotify<\/button>/)
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
    '',
    'sources',
  )
  assert.match(html, /chosen manually/)
  assert.match(html, /Manually matched/)
  assert.match(html, />Add scrobbled name<\/button>/)
  assert.match(html, />Merge Last.fm names<\/button>/)
  assert.doesNotMatch(html, />Merge with Spotify track<\/button>/)
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
    /class="ds-pill" data-mode="exclude"[^>]*><span class="ds-pill-label">Last.fm</,
  )
})

test('Sources lists the recorded and scrobbled Last.fm names in tables', () => {
  const html = render(scrobbled, '', 'sources')
  assert.match(html, /<h3>Recorded by Last.fm<\/h3>/)
  assert.match(html, /<table class="ds-table" aria-label="Scrobbled names">/)
  assert.match(html, /Example artist — Synthetic track/)
  assert.match(html, />Add scrobbled name<\/button>/)
  assert.match(html, />Merge Last.fm names<\/button>/)
  assert.match(html, />Merge with Spotify track<\/button>/)
  assert.match(
    html,
    /aria-label="Change match for Synthetic track by Example artist"/,
  )
  assert.match(html, /aria-label="Remove Synthetic track by Example artist"/)
  assert.match(
    html,
    /https:\/\/www.last.fm\/music\/Example%20artist\/_\/Synthetic%20track/,
  )
})
