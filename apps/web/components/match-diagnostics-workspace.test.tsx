import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  MatchDiagnosticsPageSchema,
  trackMatchProviderLabels,
  type MatchDiagnosticsPage,
} from '@repo/schemas/match-diagnostics'
import {
  applyTrackMatchPreset,
  loadAlbumMatchHistory,
  loadMatchDiagnosticsPage,
  loadTrackMatchDiagnosticsPage,
  matchDiagnosticsKey,
  rejectAlbumMatch,
  trackMatchDiagnosticsQuery,
  trackMatchPreset,
} from '@/utils/match-diagnostics'
import { browseFacetOptions } from '@/utils/browse-facets'
import { TrackListItemSchema } from '@repo/schemas/tracks'
import type { LibraryView } from '@/utils/media-scope'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}

const emptyPage = MatchDiagnosticsPageSchema.parse({
  totalCount: 0,
  pageCount: 0,
  items: [],
  providers: [],
})

async function render(
  library: LibraryView,
  page: MatchDiagnosticsPage,
  params = new URLSearchParams(),
) {
  const { default: MatchDiagnosticsWorkspace } =
    await import('./match-diagnostics-workspace')
  const client = new QueryClient()
  const key =
    library === 'track'
      ? [...matchDiagnosticsKey(library), trackMatchDiagnosticsQuery(params), 1]
      : [...matchDiagnosticsKey(library), '', 'name', 'asc', 1]
  client.setQueryData(key, page)
  client.setQueryData(['ai-status'], { available: true, reason: null })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://example.test',
            apiBaseUrl: 'http://api.example.test',
          }}
        >
          <SearchParamsContext.Provider value={params}>
            <MatchDiagnosticsWorkspace library={library} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('diagnostics request a bounded page from the selected library with server-side search and sort', async (t) => {
  const requests: URL[] = []
  const signal = new AbortController().signal
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, options: RequestInit) => {
      assert.equal(options.signal, signal)
      assert.equal(options.method, undefined)
      requests.push(new URL(input))
      return Response.json({ statusCode: 200, message: 'OK', data: emptyPage })
    },
  )
  const libraries: LibraryView[] = [
    'track',
    'album',
    'artist',
    'film',
    'subscription',
  ]
  for (const library of libraries)
    await loadMatchDiagnosticsPage(
      'http://example.test',
      library,
      {
        q: ' Release & Mix ',
        page: 3,
        size: 50,
        sortBy: 'lastfm',
        direction: 'desc',
      },
      signal,
    )
  assert.deepEqual(
    requests.map((url) => url.pathname),
    libraries.map((library) => `/api/v1/${library}s/match-diagnostics`),
  )
  for (const url of requests)
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      page: '3',
      size: '50',
      sortBy: 'lastfm',
      direction: 'desc',
      q: 'Release & Mix',
      ...(url.pathname === '/api/v1/albums/match-diagnostics'
        ? { longRym: '1' }
        : {}),
    })
})

test('match presets apply beside regular required, any and exclude filters', () => {
  const base = trackMatchDiagnosticsQuery(
    new URLSearchParams({
      filters: JSON.stringify([
        { field: 'artist', value: 'Example Artist', mode: 'required' },
        { field: 'genre', value: 'Electronic', mode: 'any' },
        { field: 'playlist', value: 'Example playlist', mode: 'exclude' },
      ]),
    }),
  ).filters
  const missingSpotify = applyTrackMatchPreset(base, 'missing-spotify')
  assert.equal(trackMatchPreset(missingSpotify), 'missing-spotify')
  assert.deepEqual(missingSpotify, [
    ...base,
    {
      field: 'matchProvider',
      value: trackMatchProviderLabels.spotify,
      mode: 'exclude',
    },
  ])
  const unmatched = applyTrackMatchPreset(missingSpotify, 'unmatched')
  assert.deepEqual(unmatched, [
    ...base,
    {
      field: 'matchProvider',
      value: trackMatchProviderLabels.noRecording,
      mode: 'required',
    },
  ])
  const noEvidence = applyTrackMatchPreset(unmatched, 'none')
  assert.deepEqual(noEvidence, [
    ...base,
    {
      field: 'matchProvider',
      value: trackMatchProviderLabels.noEvidence,
      mode: 'required',
    },
  ])
  assert.deepEqual(applyTrackMatchPreset(noEvidence, 'all'), base)
})

test('Tracks Matches sends the shared search, filters, ranges, limit and creator before server pagination', async (t) => {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    requests.push(url)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: url.pathname.endsWith('/facets') ? [] : emptyPage,
    })
  })
  const params = new URLSearchParams({
    q: 'Example title',
    playability: 'alternate',
    filters: JSON.stringify([
      { field: 'lastfmArtist', mode: 'exclude', value: 'Wrong Artist' },
    ]),
    ranges: JSON.stringify([{ field: 'durationSec', min: 200, max: 240 }]),
    creatorId: 'fixture-artist',
    limitResults: '30',
    sortBy: 'durationSec',
    direction: 'desc',
  })
  const state = trackMatchDiagnosticsQuery(params)
  await loadTrackMatchDiagnosticsPage('http://example.test', {
    ...state,
    page: 2,
    size: 50,
  })
  const client = new QueryClient()
  try {
    await client.fetchQuery(
      browseFacetOptions('http://example.test', 'tracks', 'spotify', true),
    )
  } finally {
    client.clear()
  }
  assert.equal(requests[0]?.pathname, '/api/v1/tracks/match-diagnostics')
  assert.deepEqual(Object.fromEntries(requests[0]?.searchParams ?? []), {
    q: 'Example title',
    playability: 'alternate',
    filters: JSON.stringify(state.filters),
    ranges: JSON.stringify(state.ranges),
    creatorId: 'fixture-artist',
    limitResults: '30',
    sortBy: 'durationSec',
    direction: 'desc',
    page: '2',
    size: '50',
  })
  assert.equal(requests[1]?.pathname, '/api/v1/tracks/match-diagnostics/facets')
  assert.equal(requests[1]?.searchParams.get('q'), 'spotify')
})

test('older Missing Spotify links open the unavailable queue, and explicit playability wins', () => {
  const params = new URLSearchParams({
    filters: JSON.stringify(applyTrackMatchPreset([], 'missing-spotify')),
    sortBy: 'scrobbles',
  })
  assert.equal(trackMatchDiagnosticsQuery(params).playability, 'unavailable')
  for (const mode of [
    'all',
    'playable',
    'direct',
    'alternate',
    'unavailable',
  ]) {
    params.set('playability', mode)
    assert.equal(trackMatchDiagnosticsQuery(params).playability, mode)
    assert.equal(
      trackMatchPreset(trackMatchDiagnosticsQuery(params).filters),
      'missing-spotify',
    )
  }
  assert.equal(
    trackMatchDiagnosticsQuery(new URLSearchParams()).playability,
    'all',
  )
})

test('Tracks Matches surfaces its presets and shared Browse controls, and can display ordinary track columns', async () => {
  const metadata = TrackListItemSchema.parse({
    id: 'library-track',
    mediaType: 'track',
    title: 'Library Track',
    artists: ['Library Artist'],
    albumName: 'Library Release',
    album: null,
    albumLinkStrategy: null,
    albumTags: [],
    artworkUrl: null,
    releaseDate: null,
    playlists: [],
    sources: ['album'],
    durationSec: 245,
    dateAdded: null,
    spotifyTrackId: null,
    spotifyMatch: 'unmatched',
    spotifyUrl: null,
    isrc: null,
    scrobbles: 25,
    lastListenedAt: null,
  })
  const html = await render(
    'track',
    MatchDiagnosticsPageSchema.parse({
      ...emptyPage,
      totalCount: 1,
      pageCount: 1,
      items: [
        {
          id: metadata.id,
          name: metadata.title,
          creator: 'Library Artist',
          track: metadata,
          matches: [],
        },
      ],
    }),
    new URLSearchParams({
      columns: 'durationSec,scrobbles',
      columnOrder: 'title,scrobbles,durationSec',
      sortBy: 'durationSec',
      direction: 'desc',
    }),
  )
  for (const label of [
    'All tracks',
    'Unmatched recordings',
    'No matches at all',
    'Missing Spotify',
    'Any playable version',
    'Playable via another version',
    'No playable version',
    'Missing Last.fm',
    'Missing Discogs album evidence',
    'Search titles, artists, albums, playlists...',
    'Record search',
    'Resize Duration',
  ])
    assert.ok(html.includes(label), label)
  assert.match(
    html,
    /aria-sort="descending"[^>]*><button[^>]*title="Sort by Duration"/,
  )
  assert.match(html, />4:05<\/td>/)
  assert.match(html, />25<\/td>/)
  assert.ok(html.indexOf('Resize Scrobbles') < html.indexOf('Resize Duration'))
})

test('a Spotify alternate links to the other library entry and identifies its release', async () => {
  const html = await render(
    'track',
    MatchDiagnosticsPageSchema.parse({
      totalCount: 2,
      pageCount: 1,
      providers: [{ key: 'spotify', label: 'Spotify' }],
      items: [
        {
          id: 'ep-entry',
          name: 'Example Song',
          creator: 'Example Artist',
          matches: [],
          spotifyAlternate: {
            trackId: 'album-entry',
            name: 'Example Song',
            albumName: 'Example Album',
            identifier: 'fixture-recording',
          },
        },
        {
          id: 'album-entry',
          name: 'Example Song',
          creator: 'Example Artist',
          matches: [
            {
              provider: 'spotify',
              name: 'Example Song',
              creator: 'Example Artist',
              identifier: 'fixture-recording',
            },
          ],
        },
      ],
    }),
  )
  assert.match(
    html,
    /href="\/tracks\/album-entry\?tab=sources">Other version · Example Album<\/a>/,
  )
  assert.match(
    html,
    /href="\/tracks\/album-entry\?tab=sources">Example Song · Example Artist<\/a>/,
  )
  assert.doesNotMatch(
    html,
    /href="\/tracks\/ep-entry\?tab=sources">Other version/,
  )
})

test('track rows show canonical and recorded identities and use the separate source for review and merge', async () => {
  const html = await render(
    'track',
    MatchDiagnosticsPageSchema.parse({
      totalCount: 1,
      pageCount: 1,
      providers: [
        { key: 'lastfm', label: 'Last.fm' },
        { key: 'spotify', label: 'Spotify' },
        { key: 'discogs', label: 'Discogs album track list' },
      ],
      items: [
        {
          id: 'playable-track',
          name: 'Library Track',
          creator: 'Library Artist',
          albumName: 'Library Release',
          mergeSourceId: 'recorded-track',
          matches: [
            {
              provider: 'lastfm',
              name: 'Recorded Track',
              creator: 'Recorded Artist',
              identifier: null,
              artistKey: 'recorded artist',
              trackKey: 'recorded track',
            },
            {
              provider: 'discogs',
              albumId: 'fixture-album',
              name: 'Discogs Track',
              creator: null,
              identifier: 'release:fixture',
            },
          ],
        },
      ],
    }),
  )
  assert.match(html, /href="\/tracks\/playable-track">Library Track</)
  assert.match(html, /Library Artist/)
  assert.match(html, /Library Release/)
  assert.match(
    html,
    /href="\/albums\/fixture-album\?tab=sources&amp;sourceProvider=discogs">Discogs Track/,
  )
  assert.match(
    html,
    /href="\/tracks\/recorded-track\?tab=sources">Recorded Track · Recorded Artist</,
  )
  assert.match(html, /aria-label="Merge Library Track"/)
  assert.match(
    html,
    /aria-label="Change match for Recorded Track by Recorded Artist"/,
  )
  assert.doesNotMatch(html, /Confirm merge|Confirm match/)
})

test('album Last.fm identities open the existing scrobble link controls and subscriptions link to their source', async () => {
  const album = await render(
    'album',
    MatchDiagnosticsPageSchema.parse({
      totalCount: 1,
      pageCount: 1,
      providers: [{ key: 'lastfm-listening', label: 'Last.fm scrobbles' }],
      items: [
        {
          id: 'library-album',
          name: 'Library Album',
          creator: 'Library Artist',
          matches: [
            {
              provider: 'lastfm-listening',
              name: 'Scrobbled Album',
              creator: 'Recorded Artist',
              identifier: null,
            },
          ],
        },
      ],
    }),
  )
  assert.match(
    album,
    /href="\/albums\/library-album\?tab=sources&amp;sourceProvider=lastfm">Scrobbled Album · Recorded Artist</,
  )
  const subscription = await render(
    'subscription',
    MatchDiagnosticsPageSchema.parse({
      ...emptyPage,
      totalCount: 1,
      pageCount: 1,
      items: [
        {
          id: 'fixture-episode',
          name: 'Fixture Episode',
          creator: 'Fixture Podcast',
          sourceId: 'fixture-podcast',
          matches: [],
        },
      ],
    }),
  )
  assert.match(
    subscription,
    /href="\/subscriptions\/fixture-episode">Fixture Episode</,
  )
  assert.match(
    subscription,
    /href="\/channels\/fixture-podcast">Fixture Podcast</,
  )
})

test('legacy Google identities open the source that supplied each recorded match', async () => {
  const html = await render(
    'album',
    MatchDiagnosticsPageSchema.parse({
      totalCount: 3,
      pageCount: 1,
      providers: [
        { key: 'google-custom-search', label: 'Google Custom Search (legacy)' },
      ],
      items: [
        {
          id: 'legacy-browser-album',
          name: 'Browser Album',
          creator: null,
          matches: [
            {
              provider: 'google-custom-search',
              sourceProvider: 'legacy-browser',
              name: 'Browser Match',
              creator: null,
              identifier: 'fixture-browser-release',
            },
            {
              provider: 'google-custom-search',
              name: 'Metacritic Match',
              creator: null,
              identifier: 'fixture-critic-release',
            },
          ],
        },
        {
          id: 'legacy-record-album',
          name: 'Record Album',
          creator: null,
          matches: [
            {
              provider: 'google-custom-search',
              sourceProvider: 'legacy-record',
              name: 'Record Match',
              creator: null,
              identifier: 'fixture-record-release',
            },
          ],
        },
        {
          id: 'google-album',
          name: 'Google Album',
          creator: null,
          matches: [
            {
              provider: 'google-custom-search',
              name: 'Google Match',
              creator: null,
              identifier: 'fixture-google-release',
            },
          ],
        },
      ],
    }),
  )
  assert.match(
    html,
    /href="\/albums\/legacy-browser-album\?tab=sources&amp;sourceProvider=legacy-browser">Browser Match \(\+1\)<\/a>/,
  )
  assert.match(
    html,
    /href="\/albums\/legacy-browser-album\?tab=sources&amp;sourceProvider=legacy-browser">Browser Match · fixture-browser-release<\/a>/,
  )
  assert.match(
    html,
    /href="\/albums\/legacy-browser-album\?tab=sources&amp;sourceProvider=google-custom-search">Metacritic Match · fixture-critic-release<\/a>/,
  )
  assert.match(
    html,
    /href="\/albums\/legacy-record-album\?tab=sources&amp;sourceProvider=legacy-record">Record Match<\/a>/,
  )
  assert.match(
    html,
    /href="\/albums\/google-album\?tab=sources&amp;sourceProvider=google-custom-search">Google Match<\/a>/,
  )
})

const rejectionTarget = {
  provider: 'google-custom-search',
  sourceProvider: 'legacy-browser',
  snapshotId: 'fixture-snapshot',
  referenceType: 'rym-url',
  identifier: 'https://example.test/release/mismatched',
}
const rejectedAt = '2026-03-01T12:00:00.000Z'

test('Albums Matches labels a rejected identity and only offers rejection for supported exact matches', async () => {
  const html = await render(
    'album',
    MatchDiagnosticsPageSchema.parse({
      totalCount: 1,
      pageCount: 1,
      providers: [
        { key: 'google-custom-search', label: 'Google Custom Search (legacy)' },
      ],
      items: [
        {
          id: 'fixture-album',
          name: 'Library Album',
          creator: null,
          matches: [
            {
              provider: rejectionTarget.provider,
              sourceProvider: rejectionTarget.sourceProvider,
              name: 'Incorrect Release',
              creator: null,
              identifier: rejectionTarget.identifier,
              rejectionTarget,
              rejectedAt,
            },
            {
              provider: rejectionTarget.provider,
              name: 'Other Candidate',
              creator: null,
              identifier: 'fixture-critic-release',
              rejectionTarget: {
                ...rejectionTarget,
                referenceType: 'metacritic-url',
                identifier: 'fixture-critic-release',
              },
            },
            {
              provider: rejectionTarget.provider,
              name: 'Identity Without Evidence',
              creator: null,
              identifier: null,
            },
          ],
        },
      ],
    }),
  )
  assert.match(html, /data-status="attention">Incorrect<\/span>/)
  assert.match(html, /data-status="attention">1 incorrect<\/span>/)
  assert.match(html, /aria-label="Match history for Library Album"/)
  assert.match(
    html,
    /aria-label="Mark Other Candidate · fixture-critic-release as incorrect"/,
  )
  assert.doesNotMatch(
    html,
    /aria-label="Mark (Incorrect Release|Identity Without Evidence)/,
  )
})

test('the rejection request preserves the exact source and history requests a bounded page', async (t) => {
  const requests: { url: URL; method?: string; body?: BodyInit | null }[] = []
  const record = { ...rejectionTarget, rejectedAt }
  const history = {
    page: 2,
    size: 10,
    totalCount: 11,
    pageCount: 2,
    items: [record],
  }
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, options: RequestInit) => {
      requests.push({
        url: new URL(input),
        method: options.method,
        body: options.body,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: options.method === 'POST' ? record : history,
      })
    },
  )
  assert.deepEqual(
    await rejectAlbumMatch(
      'http://example.test',
      'fixture/album',
      rejectionTarget,
    ),
    record,
  )
  assert.deepEqual(
    await loadAlbumMatchHistory('http://example.test', 'fixture/album', 2, 10),
    history,
  )
  assert.equal(
    requests[0]?.url.pathname,
    '/api/v1/albums/fixture%2Falbum/match-rejections',
  )
  assert.equal(requests[1]?.url.pathname, requests[0]?.url.pathname)
  assert.equal(requests[0]?.method, 'POST')
  assert.deepEqual(requests[0]?.body, JSON.stringify(rejectionTarget))
  assert.deepEqual(Object.fromEntries(requests[1]?.url.searchParams ?? []), {
    page: '2',
    size: '10',
    longRym: '1',
  })
})
