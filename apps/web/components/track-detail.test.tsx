import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TrackDetailSchema, type TrackDetail } from '@repo/schemas/tracks'
import {
  SpotifyTrackSearchCandidateSchema,
  SpotifyTrackSearchJobSchema,
  type SpotifyTrackSearch,
  type SpotifyTrackSearchCandidate,
  type SpotifyTrackSearchJob,
} from '@repo/schemas/spotify-track-search'
import { ConfigContext } from './providers'
import { PlaybackViewContext } from './playback-provider'
import { idlePlaybackState } from '@/utils/playback-engine'

// The detail page imports a CSS module, which Node cannot load; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}
let TrackDetailView: typeof import('./track-detail').default
let TrackSources: typeof import('./track-detail').TrackSources
before(async () => {
  const detail = await import('./track-detail')
  TrackDetailView = detail.default
  TrackSources = detail.TrackSources
})

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
  spotifyAlbumId: null,
  scrobbledAlbums: [],
  isrcs: [],
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
  searchCandidates: SpotifyTrackSearchCandidate[] = [],
  resultJob?: SpotifyTrackSearchJob | null,
  earlierResults?: SpotifyTrackSearch['earlierResults'],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['track', item.id], item)
  client.setQueryData(['tracks', 'spotify-track-search', item.id], {
    job: searchJob,
    query: item.title,
    candidates: searchCandidates,
    resultJob,
    earlierResults,
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
  const recordedAlbum =
    /<\/span> · on <span data-workspace-href="([^"]+)"[^>]*tabindex="0">Recorded album<\/span><\/div>/.exec(
      html,
    )?.[1]
  assert.ok(recordedAlbum)
  const albumFilter = new URL(recordedAlbum, 'http://localhost')
  assert.equal(albumFilter.pathname, '/tracks')
  assert.deepEqual(
    JSON.parse(albumFilter.searchParams.get('filters') ?? '[]'),
    [{ field: 'album', value: 'Recorded album' }],
  )
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
    /data-workspace-label="Match to Spotify"[^>]*>Match to Spotify<\/button>/,
  )
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
  assert.deepEqual(pillHref(html, 'Synth-Pop'), [
    { field: 'artistTag', value: 'Synth-pop' },
  ])
  assert.match(
    html,
    /<button type="button"[^>]*aria-label="Sources for Electronic"[^>]*class="browse-pill-action"/,
  )
  assert.match(
    html,
    /<button type="button"[^>]*aria-label="Sources for Synth-Pop"[^>]*class="browse-pill-action"/,
  )
  assert.match(html, /4:03/)
  assert.match(html, /aria-label="Play Synthetic track">.*Play<\/button>/)
  assert.match(
    html,
    /title="Add to queue" aria-label="Add Synthetic track to queue"><svg/,
  )
  for (const source of ['Last.fm', 'Spotify playlists', 'Liked Songs'])
    assert.ok(pillHref(html, source).length)
  assert.doesNotMatch(html, /No Spotify match/)
  // The Spotify logo, on the line under the facts.
  assert.match(
    html,
    /<div class="ds-detail-links"><span class="service-links"[^>]*><a [^>]*aria-label="Open on Spotify: Synthetic track \(opens in a new tab\)"/,
  )
  assert.doesNotMatch(html, /Open at Spotify/)
  assert.match(
    html,
    /href="https:\/\/open.spotify.com\/track\/1234567890ABCDEFGHIJKL"/,
  )
  assert.match(render(matched, '', 'sources'), /unique artist and title match/)
})

test('details list every recorded ISRC with the services that reported it', () => {
  const html = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      isrc: 'ZZAAA2600001',
      isrcs: [
        { isrc: 'ZZAAA2600001', providers: ['spotify'] },
        { isrc: 'ZZAAA2600002', providers: ['spotify', 'tidal'] },
      ],
    }),
  )
  assert.match(
    html,
    /<span class="ds-mono">ZZAAA2600001<\/span> <span class="ds-muted">Spotify<\/span>/,
  )
  assert.match(
    html,
    /<span class="ds-mono">ZZAAA2600002<\/span> <span class="ds-muted">Spotify, TIDAL<\/span>/,
  )
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

const completedSearch = SpotifyTrackSearchJobSchema.parse({
  jobId: 'fixture-search',
  status: 'succeeded',
  resultCount: null,
  errorMessage: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  startedAt: '2026-01-03T00:00:00.000Z',
  finishedAt: '2026-01-03T00:00:01.000Z',
})

const savedCandidate = SpotifyTrackSearchCandidateSchema.parse({
  spotifyTrackId: '1234567890ABCDEFGHIJKL',
  title: 'Synthetic track',
  artists: ['Example artist'],
  albumName: 'Catalog album',
  spotifyAlbumId: null,
  durationSec: 180,
  isrc: null,
  artworkUrl: null,
  spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
})

test('expanded unmatched Spotify Sources shows selectable saved candidates without another search', () => {
  for (const resultCount of [1, null]) {
    const html = render(
      scrobbled,
      'sourceProvider=spotify',
      'sources',
      { ...completedSearch, resultCount },
      [savedCandidate],
    )
    assert.match(html, />Unmatched</)
    assert.match(html, /<details class="ds-source" open=""/)
    assert.match(html, /Saved Spotify matches/)
    assert.match(html, /aria-label="Review Synthetic track from Catalog album"/)
  }
})

test('an empty recent search keeps older saved Spotify results in the expanded source', () => {
  const html = render(
    scrobbled,
    'sourceProvider=spotify',
    'sources',
    { ...completedSearch, jobId: 'latest-empty-search', resultCount: 0 },
    [savedCandidate],
    { ...completedSearch, resultCount: 1 },
  )
  assert.match(html, /Saved Spotify matches/)
  assert.match(html, /Search from /)
  assert.match(html, /aria-label="Review Synthetic track from Catalog album"/)
  assert.doesNotMatch(html, />No matches</)
})

test('expanded Spotify Sources shows distinct candidates from both successful searches', () => {
  const older = { ...completedSearch, jobId: 'earlier-search', resultCount: 1 }
  const html = render(
    scrobbled,
    'sourceProvider=spotify',
    'sources',
    { ...completedSearch, resultCount: 1 },
    [savedCandidate],
    undefined,
    [
      {
        job: older,
        query: 'Earlier query',
        candidates: [
          {
            ...savedCandidate,
            spotifyTrackId: 'ABCDEFGHIJKLMNOPQRSTUV',
            spotifyUrl: 'https://open.spotify.com/track/ABCDEFGHIJKLMNOPQRSTUV',
            title: 'Earlier candidate',
          },
        ],
      },
    ],
  )
  assert.match(html, /aria-label="Review Synthetic track from Catalog album"/)
  assert.match(html, /aria-label="Review Earlier candidate from Catalog album"/)
})

test('an alternate Spotify version leaves the saved candidates read-only', () => {
  const track = TrackDetailSchema.parse({
    ...scrobbled,
    spotifyAlternate: {
      trackId: 'alternate-recording',
      name: 'Synthetic track',
      albumName: null,
      identifier: 'ABCDEFGHIJKLMNOPQRSTUV',
    },
  })
  const html = render(
    track,
    'sourceProvider=spotify',
    'sources',
    { ...completedSearch, resultCount: 1 },
    [savedCandidate],
  )
  assert.match(html, /Open version/)
  assert.match(html, /Saved Spotify matches/)
  assert.match(html, /Catalog album/)
  assert.doesNotMatch(
    html,
    /Search Spotify|Review Synthetic track from Catalog album/,
  )
})

test('unmatched Sources opens Spotify search when there are no saved candidates', () => {
  const empty = render(scrobbled, '', 'sources', {
    ...completedSearch,
    resultCount: 0,
  })
  assert.match(empty, />No matches</)
  assert.match(empty, /aria-haspopup="dialog"[^>]*>Search Spotify<\/button>/)
  assert.doesNotMatch(empty, /Match to Spotify/)
})

test('unmatched Sources can open the search panel while a lookup runs', () => {
  const running = render(scrobbled, '', 'sources', {
    ...completedSearch,
    status: 'running',
    finishedAt: null,
  })
  assert.match(running, />Running</)
  assert.match(running, /aria-haspopup="dialog"[^>]*>Search Spotify<\/button>/)
  assert.doesNotMatch(running, /Match to Spotify/)
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
  assert.match(
    html,
    /<table class="ds-table" data-layout="fixed" aria-label="Scrobbled names"/,
  )
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

test('Sources offers to add a missing Spotify album and warns about albums that do not list the track', () => {
  const html = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      albumName: 'Harbour Lights',
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
      scrobbledAlbums: [
        { id: 'fixture-single', title: 'Harbour Lights', scrobbles: 115 },
        { id: 'fixture-live', title: 'Live Set', scrobbles: 1 },
      ],
    }),
    '',
    'sources',
  )
  assert.equal(html.match(/is not in the library\./g)?.length, 1)
  assert.equal(html.match(/<h3>Album<\/h3>/g)?.length, 1)
  assert.match(
    html,
    /“Harbour Lights” is not in the library\.<\/span><button[^>]*>Add album<\/button>/,
  )
  assert.match(
    html,
    /data-tone="attention" role="status"><svg[^>]*>.*?<\/svg><span>115 plays of this track are counted on “<a[^>]*href="\/albums\/fixture-single"[^>]*>Harbour Lights<\/a>”, which does not list it\.<\/span><\/div>/,
  )
  assert.match(
    html,
    /1 play of this track is counted on “<a[^>]*href="\/albums\/fixture-live"[^>]*>Live Set<\/a>”, which does not list it\./,
  )
})

test('Sources shows no album notices for a track on its library album', () => {
  const html = render(
    TrackDetailSchema.parse({
      ...scrobbled,
      album: { id: 'album-1', title: 'Library album' },
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    }),
    '',
    'sources',
  )
  assert.doesNotMatch(
    html,
    /<h3>Album<\/h3>|not in the library|Add album|does not list it/,
  )
})
