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
  loadMatchDiagnosticsPage,
  loadTrackMatchDiagnosticsPage,
  matchDiagnosticsKey,
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
