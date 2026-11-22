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
import {
  loadTrackDuplicateLayout,
  trackDuplicateCountKey,
  trackDuplicateLayoutKey,
} from '@/utils/track-duplicates'
import { TrackListItemSchema } from '@repo/schemas/tracks'
import type { LibraryView } from '@/utils/media-scope'
import type { RowSelection } from './merge-bar'
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
  /** Caches more reads, such as the Possible duplicates layout and count. */
  seed?: (client: QueryClient) => void,
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
  seed?.(client)
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

const duplicateRow = (id: string, name: string) => ({
  id,
  name,
  creator: 'Fixture Artist',
  matches: [],
})
const duplicateGroup = (
  id: string,
  offset: number,
  memberIds: string[],
  evidence: string[],
  merge: {
    keep: { id: string; title: string; by: string }
    versions: number
    removed: number
    removedRecords: number
  } | null,
) => ({
  id,
  rule: 'key' as const,
  evidence,
  cautions: [],
  memberCount: memberIds.length,
  scrobbles: 10,
  memberIds,
  merge,
  offset,
  rowCount: memberIds.length,
})

test('Possible duplicates is read from the URL and sent with the Matches rows and the group layout', async (t) => {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    requests.push(url)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: url.pathname.endsWith('/layout')
        ? { totalRows: 0, groups: [] }
        : emptyPage,
    })
  })
  const params = new URLSearchParams({
    duplicates: 'true',
    q: 'Night',
    sortBy: 'scrobbles',
    direction: 'desc',
    creatorId: 'fixture-artist',
  })
  const state = trackMatchDiagnosticsQuery(params)
  assert.equal(state.duplicates, true)
  assert.equal(
    trackMatchDiagnosticsQuery(new URLSearchParams()).duplicates,
    undefined,
  )
  assert.equal(
    trackMatchDiagnosticsQuery(new URLSearchParams({ duplicates: 'false' }))
      .duplicates,
    undefined,
  )
  await loadTrackMatchDiagnosticsPage('http://example.test', {
    ...state,
    page: 1,
    size: 50,
  })
  await loadTrackDuplicateLayout('http://example.test', state)
  const shared = {
    q: 'Night',
    sortBy: 'scrobbles',
    direction: 'desc',
    creatorId: 'fixture-artist',
    duplicates: 'true',
  }
  assert.equal(requests[0]?.pathname, '/api/v1/tracks/match-diagnostics')
  assert.deepEqual(Object.fromEntries(requests[0]?.searchParams ?? []), {
    ...shared,
    page: '1',
    size: '50',
  })
  // The layout takes the rows' request without the page.
  assert.equal(requests[1]?.pathname, '/api/v1/tracks/duplicates/layout')
  assert.deepEqual(Object.fromEntries(requests[1]?.searchParams ?? []), shared)
})

test('the Possible duplicates toggle leads the Tracks Matches toolbar with the group count once ready', async () => {
  const off = await render(
    'track',
    emptyPage,
    new URLSearchParams(),
    (client) =>
      client.setQueryData(trackDuplicateCountKey(), {
        count: 1234,
        ready: true,
      }),
  )
  assert.match(
    off,
    /<div class="ds-toolbar"><button class="ds-btn" type="button" aria-pressed="false"><svg[^>]*>.*?<\/svg>Possible duplicates<span class="ds-count">1,234<\/span><\/button><select[^>]*aria-label="Match status"/,
  )
  // The count is scoped to the creator the list is held to.
  const scoped = await render(
    'track',
    emptyPage,
    new URLSearchParams({ duplicates: 'true', creatorId: 'fixture-artist' }),
    (client) => {
      client.setQueryData(trackDuplicateCountKey(), {
        count: 1234,
        ready: true,
      })
      client.setQueryData(trackDuplicateCountKey('fixture-artist'), {
        count: 2,
        ready: true,
      })
    },
  )
  assert.match(
    scoped,
    /aria-pressed="true"><svg[^>]*>.*?<\/svg>Possible duplicates<span class="ds-count">2<\/span>/,
  )
  // Before the first rebuild the toggle has no count.
  const building = await render(
    'track',
    emptyPage,
    new URLSearchParams(),
    (client) =>
      client.setQueryData(trackDuplicateCountKey(), { count: 0, ready: false }),
  )
  assert.match(building, /<\/svg>Possible duplicates<\/button>/)
})

test('Possible duplicates draws a group row above the first row of each group: the details behind an icon, and what speaks against merging', async () => {
  const params = new URLSearchParams({ duplicates: 'true' })
  const page = MatchDiagnosticsPageSchema.parse({
    totalCount: 4,
    pageCount: 1,
    providers: [],
    items: [
      duplicateRow('track-a', 'Night Drive'),
      duplicateRow('track-b', 'Night Drive (Remastered 2011)'),
      duplicateRow('track-c', 'Longwave'),
      duplicateRow('track-d', 'Longwave (Demo)'),
    ],
  })
  const html = await render('track', page, params, (client) =>
    client.setQueryData(
      trackDuplicateLayoutKey(trackMatchDiagnosticsQuery(params)),
      {
        totalRows: 4,
        groups: [
          duplicateGroup(
            'group-1',
            0,
            ['track-a', 'track-b'],
            ['Same artist', 'Same title without “Remastered 2011”'],
            {
              keep: { id: 'track-a', title: 'Night Drive', by: 'Fixture' },
              versions: 0,
              removed: 1,
              removedRecords: 1,
            },
          ),
          {
            ...duplicateGroup(
              'group-2',
              2,
              ['track-c', 'track-d'],
              ['Same title and artist'],
              null,
            ),
            cautions: [{ code: 'version', words: ['Demo'] }],
          },
        ],
      },
    ),
  )
  const rows = [...html.matchAll(/<tr ([^>]*)>/g)].map(
    ([, attrs]) => attrs ?? '',
  )
  assert.deepEqual(
    rows
      .filter((attrs) => /aria-rowindex/.test(attrs))
      .map((attrs) => attrs.replace(/ data-selected="[^"]*"/, '')),
    [
      'data-group="" aria-rowindex="2"',
      'aria-rowindex="3"',
      'aria-rowindex="4"',
      'data-group="" aria-rowindex="5"',
      'aria-rowindex="6"',
      'aria-rowindex="7"',
    ],
  )
  // The header, four tracks and two group rows.
  assert.match(html, /aria-rowcount="7"/)
  const groupRows = [
    ...html.matchAll(/<tr data-group="" aria-rowindex="\d+">.*?<\/tr>/g),
  ].map(([row]) => row)
  assert.equal(groupRows.length, 2)
  const [clear = '', unsure = ''] = groupRows
  // Nothing speaks against the first group: its buttons, then the details behind the icon.
  assert.match(
    clear,
    /<td colSpan="\d+"><span class="ds-group-actions"><button class="ds-btn"[^>]*>Merge<\/button><button class="ds-btn"[^>]*>Keep separate<\/button><div class="secondary-cell-details"><button[^>]*aria-label="What Merge does"/,
  )
  assert.match(
    clear,
    /<div>Merge keeps “Night Drive”: 1 Last\.fm record is removed and its plays and names move to it\.<\/div><div>Same artist<\/div><div>Same title without “Remastered 2011”<\/div>/,
  )
  assert.doesNotMatch(clear, /ds-group-evidence/)
  // The second says what speaks against it; its members cannot all be read, so the details hold only the evidence.
  assert.match(
    unsure,
    /<span class="ds-group-evidence" title="Against merging: “Demo” is in some titles only">Against merging: “Demo” is in some titles only<\/span><\/span><\/td><\/tr>$/,
  )
  assert.match(unsure, /<div>Same title and artist<\/div>/)
  assert.doesNotMatch(unsure, /Merge keeps/)
  // The bar for the result of Merge or Keep separate waits under the table.
  assert.match(
    html,
    /<\/table><\/div><div class="ds-selectbar sec-selectbar"><\/div>/,
  )
})

test('Possible duplicates with nothing listed says so, and with a search or filter offers Clear filters', async () => {
  const none = await render(
    'track',
    emptyPage,
    new URLSearchParams({ duplicates: 'true' }),
  )
  assert.match(none, /No possible duplicates/)
  assert.doesNotMatch(none, /No matching items|No library items|data-group/)
  const searched = await render(
    'track',
    emptyPage,
    new URLSearchParams({ duplicates: 'true', q: 'Night' }),
  )
  assert.match(
    searched,
    /No matching items\.<button[^>]*>Clear filters<\/button>/,
  )
  assert.doesNotMatch(searched, /No possible duplicates/)
  const all = await render('track', emptyPage)
  assert.match(all, /No library items\./)
})

test('Tracks Matches rows have tick boxes, and other libraries do not', async () => {
  const page = MatchDiagnosticsPageSchema.parse({
    totalCount: 2,
    pageCount: 1,
    providers: [],
    items: [
      duplicateRow('track-a', 'Night Drive'),
      duplicateRow('track-b', 'Longwave'),
    ],
  })
  for (const params of [
    new URLSearchParams(),
    new URLSearchParams({ duplicates: 'true' }),
  ]) {
    const html = await render('track', page, params)
    assert.match(
      html,
      /<thead><tr><th scope="col" data-sticky="" style="--ds-sticky-left:0px"><input type="checkbox" class="ds-check" aria-label="Select loaded tracks"\/><\/th><th [^>]*style="--ds-sticky-left:36px"/,
    )
    assert.match(
      html,
      /<tr aria-rowindex="2"[^>]*><td data-sticky="" style="--ds-sticky-left:0px"><input type="checkbox" class="ds-check" aria-label="Select Night Drive"\/><\/td><td [^>]*style="--ds-sticky-left:36px"/,
    )
    assert.match(html, /aria-label="Select Longwave"/)
    // The selection column is the first of the fixed layout.
    assert.match(html, /<colgroup><col style="width:min\(36px, [^"]*"\/>/)
  }
  const albums = await render(
    'album',
    MatchDiagnosticsPageSchema.parse({
      totalCount: 1,
      pageCount: 1,
      providers: [],
      items: [duplicateRow('album-a', 'Night Album')],
    }),
  )
  assert.match(albums, /Night Album/)
  assert.doesNotMatch(albums, /type="checkbox"|Select loaded|Select Night/)
})

test('Possible duplicates group rows and the empty state span the selection column too', async () => {
  const params = new URLSearchParams({ duplicates: 'true' })
  const page = MatchDiagnosticsPageSchema.parse({
    totalCount: 2,
    pageCount: 1,
    providers: [],
    items: [
      duplicateRow('track-a', 'Night Drive'),
      duplicateRow('track-b', 'Night Drive (Remastered 2011)'),
    ],
  })
  const html = await render('track', page, params, (client) =>
    client.setQueryData(
      trackDuplicateLayoutKey(trackMatchDiagnosticsQuery(params)),
      {
        totalRows: 2,
        groups: [
          duplicateGroup(
            'group-1',
            0,
            ['track-a', 'track-b'],
            ['Same artist'],
            null,
          ),
        ],
      },
    ),
  )
  const header = /<thead><tr>(.*?)<\/tr><\/thead>/.exec(html)?.[1] ?? ''
  const headers = [...header.matchAll(/<th[ >]/g)].length
  const cells = [
    ...(
      /<tr aria-rowindex="3"[^>]*>(.*?)<\/tr>/.exec(html)?.[1] ?? ''
    ).matchAll(/<td[ >]/g),
  ].length
  assert.ok(headers > 1)
  assert.equal(cells, headers)
  assert.match(
    html,
    new RegExp(`<tr data-group="" aria-rowindex="2"><td colSpan="${headers}">`),
  )
  assert.match(html, /aria-rowcount="4"/)
  const none = await render('track', emptyPage, params)
  const emptyHeaders = [
    ...(/<thead><tr>(.*?)<\/tr><\/thead>/.exec(none)?.[1] ?? '').matchAll(
      /<th[ >]/g,
    ),
  ].length
  assert.match(
    none,
    new RegExp(
      `<td colSpan="${emptyHeaders}" class="table-state"><div role="status">No possible duplicates`,
    ),
  )
})

function selectionOf(ids: string[]): RowSelection {
  return {
    ids,
    count: ids.length,
    has: (id) => ids.includes(id),
    all: false,
    some: ids.length > 0,
    toggle: () => undefined,
    setAll: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
  }
}

test('the Tracks Matches bar offers Merge for ticked rows and otherwise reports the last group action', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const { TrackMatchesBar } = await import('./match-diagnostics-workspace')
  const client = new QueryClient()
  const error = 'The tracks could not be kept separate.'
  const bar = (
    ids: string[],
    reported: string | null,
    progress: string | null = null,
  ) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://example.test',
            apiBaseUrl: 'http://api.example.test',
          }}
        >
          <TrackMatchesBar
            actions={{
              change: null,
              error: reported,
              progress,
              setChange: () => undefined,
              setError: () => undefined,
              dismiss: () => undefined,
            }}
            selection={selectionOf(ids)}
            total={250}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  try {
    assert.equal(
      bar([], null),
      '<div class="ds-selectbar sec-selectbar"></div>',
    )
    const reporting = bar([], error)
    assert.match(reporting, new RegExp(`<span role="alert">${error}</span>`))
    assert.match(reporting, /aria-label="Dismiss"/)
    assert.doesNotMatch(reporting, />Merge</)
    // Groups still being merged are reported before any has finished.
    assert.match(
      bar([], null, 'Merging 2 groups…'),
      /<span role="status">Merging 2 groups…<\/span>/,
    )
    // A selection takes the bar over from the result.
    const selecting = bar(['track-a', 'track-b'], error)
    assert.match(selecting, /<button[^>]*>Merge<\/button>/)
    assert.match(selecting, /aria-label="Clear selection"/)
    assert.doesNotMatch(selecting, new RegExp(error))
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})
