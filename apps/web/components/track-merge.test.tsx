import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query'
import { TrackListItemSchema, TrackQuerySchema } from '@repo/schemas/tracks'
import TrackMerge, {
  canMergeLastfmTrack,
  changeTrackScrobbleMatch,
  loadTrackMergeCandidates,
  mergeLibraryTrack,
  TrackMergePanel,
  TrackMergeReview,
} from './track-merge'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { ConfigContext } from './providers'
import { listeningSeriesKey } from '@/utils/listening-series'

const source = TrackListItemSchema.parse({
  id: 'lastfm/fixture',
  mediaType: 'track',
  title: 'Fixture Song',
  artists: ['Fixture Artist'],
  albumName: 'Recorded Album',
  album: null,
  albumLinkStrategy: null,
  albumTags: [],
  artworkUrl: null,
  releaseDate: null,
  playlists: [],
  sources: ['lastfm'],
  durationSec: null,
  dateAdded: null,
  spotifyTrackId: null,
  spotifyMatch: 'unmatched',
  spotifyUrl: null,
  isrc: null,
  scrobbles: 3,
  lastListenedAt: null,
})
const target = TrackListItemSchema.parse({
  ...source,
  id: 'spotify-fixture',
  title: 'Fixture Song - Album Version',
  artists: ['Fixture Artist', 'Featured Fixture'],
  albumName: 'Spotify Album',
  sources: ['spotify'],
  playlists: [{ id: 'playlist-fixture', name: 'Fixture Playlist' }],
  spotifyTrackId: '1234567890ABCDEFGHIJKL',
  spotifyMatch: 'spotify-import',
  spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
})
const albumMatched = TrackListItemSchema.parse({
  ...source,
  id: 'album-track-fixture',
  title: 'Album-derived Fixture',
  spotifyTrackId: target.spotifyTrackId,
  spotifyUrl: target.spotifyUrl,
  spotifyMatch: 'album-track-list',
})

function render(children: ReactNode, candidates = [target]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['tracks', 'merge-candidates', source.title, 1], {
    items: candidates,
    page: 1,
    size: 20,
    pageCount: 1,
    totalCount: candidates.length,
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
          {children}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

function unexpectedAction() {
  throw new Error('No action should run while rendering')
}

test('merge is offered only for Last.fm records without a native Spotify identity', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden while the merge control is closed')
  })
  assert.equal(canMergeLastfmTrack(source), true)
  assert.equal(canMergeLastfmTrack(albumMatched), true)
  assert.equal(canMergeLastfmTrack(target), false)
  assert.equal(
    canMergeLastfmTrack({ ...target, sources: ['lastfm', 'spotify'] }),
    false,
  )
  assert.equal(canMergeLastfmTrack({ ...source, sources: [] }), false)
  const html = render(<TrackMerge track={source} onMerged={unexpectedAction} />)
  assert.match(html, />Merge with Spotify track<\/button>/)
  assert.doesNotMatch(html, /<dialog|Confirm merge/)
  assert.equal(
    render(<TrackMerge track={target} onMerged={unexpectedAction} />),
    '',
  )
  assert.equal(network.mock.callCount(), 0)
})

test('the side panel starts with the recorded track and stored Spotify choices without a default merge', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden during server rendering')
  })
  const html = render(
    <TrackMergePanel
      track={source}
      onClose={unexpectedAction}
      onMerged={unexpectedAction}
    />,
    [target, source, albumMatched],
  )
  assert.match(html, /<dialog[^>]*class="dtl-dialog"/)
  assert.match(html, /class="dtl-dialog-body"/)
  assert.match(html, />Track match<\/b>/)
  assert.match(html, /<strong>Fixture Song<\/strong>/)
  assert.match(html, /Recorded Album<\/span>/)
  assert.match(html, />3 scrobbles</)
  assert.match(html, /Search Spotify library tracks/)
  assert.match(
    html,
    /placeholder="Search library tracks"[^>]*value="Fixture Song"/,
  )
  assert.match(html, /Fixture Song - Album Version/)
  assert.match(html, /Featured Fixture/)
  assert.match(html, /Spotify Album/)
  assert.equal((html.match(/>Merge<\/button>/g) ?? []).length, 1)
  assert.match(
    html,
    /aria-label="Merge with Fixture Song - Album Version by Fixture Artist, Featured Fixture"/,
  )
  assert.match(html, /aria-label="Open Last.fm \(opens in a new tab\)"/)
  assert.match(html, /aria-label="Open Spotify \(opens in a new tab\)"/)
  assert.doesNotMatch(html, /Album-derived Fixture|Confirm merge/)
  assert.equal(network.mock.callCount(), 0)
})

test('review identifies both records and explains what is retained before confirmation', () => {
  const html = render(
    <TrackMergeReview
      source={source}
      target={target}
      pending={false}
      onConfirm={unexpectedAction}
      onBack={unexpectedAction}
    />,
  )
  assert.match(html, /Last.fm record to merge/)
  assert.match(html, /Spotify track to keep/)
  assert.match(html, /Recorded Album/)
  assert.match(html, /Spotify Album/)
  assert.match(html, /3 scrobbles/)
  assert.match(
    html,
    /href="https:\/\/www.last.fm\/music\/Fixture%20Artist\/_\/Fixture%20Song"/,
  )
  assert.match(
    html,
    /href="https:\/\/open.spotify.com\/track\/1234567890ABCDEFGHIJKL"/,
  )
  assert.match(html, /keeps its Spotify ID and playlists/)
  assert.match(html, /Later syncs keep this choice/)
  assert.match(html, />Confirm merge<\/button>/)
  const pending = render(
    <TrackMergeReview
      source={source}
      target={target}
      pending
      onConfirm={unexpectedAction}
      onBack={unexpectedAction}
    />,
  )
  assert.match(pending, /disabled=""[^>]*>Merging/)
  assert.match(pending, /disabled=""[^>]*>Choose another track/)
})

test('a playable peer opens merge review with the exact named target', () => {
  const html = render(
    <TrackMergePanel
      track={source}
      initialTarget={target}
      onClose={unexpectedAction}
      onMerged={unexpectedAction}
    />,
  )
  assert.match(html, /Last.fm record to merge/)
  assert.match(html, /Spotify track to keep/)
  assert.match(html, /Fixture Song - Album Version/)
  assert.match(html, />Confirm merge<\/button>/)
  assert.doesNotMatch(html, /Search Spotify library tracks/)
})

test('scrobble correction reviews the recorded name and both track identities', () => {
  const html = render(
    <TrackMergeReview
      source={target}
      target={albumMatched}
      correction={{
        artistKey: 'fixture artist',
        trackKey: 'recorded song',
        artistName: 'Recorded Artist',
        trackName: 'Recorded Song',
      }}
      pending={false}
      onConfirm={unexpectedAction}
      onBack={unexpectedAction}
    />,
  )
  assert.match(html, /Confirm scrobble match/)
  assert.match(html, /Recorded Song/)
  assert.match(html, /Recorded Artist/)
  assert.match(html, /Fixture Song - Album Version/)
  assert.match(html, /Album-derived Fixture/)
  assert.match(html, />Confirm match<\/button>/)
  assert.doesNotMatch(html, /Confirm merge/)
})

test('scrobble correction sends only stable name keys and the reviewed target', async (t) => {
  const network = t.mock.method(
    globalThis,
    'fetch',
    async (input: string, options: RequestInit) => {
      assert.equal(
        input,
        'http://example.test/api/v1/tracks/lastfm%2Ffixture/scrobble-match',
      )
      assert.equal(options.method, 'POST')
      assert.deepEqual(JSON.parse(String(options.body)), {
        artistKey: 'fixture artist',
        trackKey: 'recorded song',
        targetId: albumMatched.id,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { targetId: albumMatched.id },
      })
    },
  )
  assert.deepEqual(
    await changeTrackScrobbleMatch(
      'http://example.test',
      source.id,
      albumMatched.id,
      {
        artistKey: 'fixture artist',
        trackKey: 'recorded song',
        artistName: 'Recorded Artist',
        trackName: 'Recorded Song',
      },
    ),
    { targetId: albumMatched.id },
  )
  assert.equal(network.mock.callCount(), 1)
})

test('candidate search restricts stored tracks to native Spotify imports before pagination', async (t) => {
  const network = t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/v1/tracks')
      assert.equal(url.searchParams.get('q'), 'Fixture & title')
      assert.equal(url.searchParams.get('page'), '2')
      assert.equal(url.searchParams.get('size'), '20')
      assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? '[]'), [
        {
          field: 'spotifyMatch',
          value: 'Spotify playlist / Liked Songs',
          mode: 'any',
        },
        { field: 'spotifyMatch', value: 'Spotify track search', mode: 'any' },
      ])
      assert.notEqual(init?.method, 'POST')
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: {
          items: [target],
          page: 2,
          size: 20,
          totalCount: 21,
          pageCount: 2,
        },
      })
    },
  )
  const result = await loadTrackMergeCandidates(
    'http://localhost:4001',
    'Fixture & title',
    2,
  )
  assert.deepEqual(result.items, [target])
  assert.equal(network.mock.callCount(), 1)
})

test('correction candidates include Last.fm-only tracks and every other stored source', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    const query = TrackQuerySchema.parse(Object.fromEntries(url.searchParams))
    assert.equal(query.q, 'Fixture')
    assert.deepEqual(query.filters, [
      { field: 'source', value: 'Album track list', mode: 'any' },
      { field: 'source', value: 'Last.fm', mode: 'any' },
      { field: 'source', value: 'Spotify playlists', mode: 'any' },
      { field: 'source', value: 'Liked Songs', mode: 'any' },
      { field: 'source', value: 'Spotify track search', mode: 'any' },
    ])
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: {
        items: [source],
        page: 1,
        size: 20,
        totalCount: 1,
        pageCount: 1,
      },
    })
  })
  const result = await loadTrackMergeCandidates(
    'http://example.test',
    'Fixture',
    1,
    undefined,
    true,
  )
  assert.deepEqual(result.items, [source])
  assert.equal(network.mock.callCount(), 1)
})

test('confirming submits the reviewed source and target without replacing Spotify metadata', async (t) => {
  const network = t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(
        input,
        'http://localhost:4001/api/v1/tracks/lastfm%2Ffixture/merge',
      )
      assert.equal(init?.method, 'POST')
      assert.equal(init?.body, JSON.stringify({ targetId: target.id }))
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { targetId: target.id },
      })
    },
  )
  assert.deepEqual(
    await mergeLibraryTrack('http://localhost:4001', source, target),
    { targetId: target.id },
  )
  assert.equal(network.mock.callCount(), 1)
})

test('invalid source or target pairs cannot trigger a merge request', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Invalid merge must not reach the API')
  })
  await assert.rejects(
    mergeLibraryTrack('http://localhost:4001', target, source),
    /not a separate Last.fm/,
  )
  await assert.rejects(
    mergeLibraryTrack('http://localhost:4001', source, albumMatched),
    /imported Spotify track/,
  )
  await assert.rejects(
    mergeLibraryTrack('http://localhost:4001', source, {
      ...target,
      id: source.id,
    }),
    /different track/,
  )
  assert.equal(network.mock.callCount(), 0)
})

test('source and target errors remain available to the confirmation UI', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        statusCode: 409,
        message: 'The selected track is no longer an imported Spotify track.',
      },
      { status: 409 },
    ),
  )
  await assert.rejects(
    mergeLibraryTrack('http://localhost:4001', source, target),
    (error: unknown) => {
      assert.equal(
        errorMessage(error, 'Could not merge these tracks.'),
        'The selected track is no longer an imported Spotify track.',
      )
      return true
    },
  )
})

test('merge invalidation skips the still-observed deleted detail while refreshing target and facets', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const keys = [
    ['track', source.id],
    ['track', target.id],
    ['tracks', 'facets'],
  ]
  const fetched: string[] = []
  const stops = keys.map((queryKey) => {
    client.setQueryData(queryKey, 'stored')
    const observer = new QueryObserver(client, {
      queryKey,
      staleTime: Infinity,
      queryFn: async () => {
        fetched.push(JSON.stringify(queryKey))
        return 'refreshed'
      },
    })
    return observer.subscribe(() => {})
  })
  try {
    await invalidateScrobbleLinks(client, source.id)
    assert.deepEqual(
      fetched.sort(),
      [
        JSON.stringify(['track', target.id]),
        JSON.stringify(['tracks', 'facets']),
      ].sort(),
    )
    assert.equal(client.getQueryData(['track', source.id]), 'stored')
    assert.equal(
      client.getQueryState(['track', source.id])?.isInvalidated,
      true,
    )
    assert.equal(client.getQueryData(['track', target.id]), 'refreshed')
    assert.equal(client.getQueryData(['tracks', 'facets']), 'refreshed')
  } finally {
    for (const stop of stops) stop()
    client.clear()
  }
})

test('merge invalidation cancels a pending source detail read without starting another', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const queryKey = ['track', source.id]
  client.setQueryData(queryKey, 'stored')
  let requests = 0
  let aborted = false
  const observer = new QueryObserver(client, {
    queryKey,
    staleTime: Infinity,
    queryFn: ({ signal }) => {
      requests += 1
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('Cancelled fixture request'))
          },
          { once: true },
        )
      })
    },
  })
  const stop = observer.subscribe(() => {})
  try {
    const pending = observer.refetch()
    await invalidateScrobbleLinks(client, source.id)
    await pending
    assert.equal(aborted, true)
    assert.equal(requests, 1)
    assert.equal(client.getQueryData(queryKey), 'stored')
    assert.equal(client.getQueryState(queryKey)?.isInvalidated, true)
  } finally {
    stop()
    client.clear()
  }
})

test('scrobble invalidation refreshes artist listening charts but not artist details', async () => {
  const client = new QueryClient()
  const series = listeningSeriesKey('artist', 'artist-1')
  const detail = ['artist', 'artist-1']
  client.setQueryData(series, 'stored')
  client.setQueryData(detail, 'stored')
  try {
    await invalidateScrobbleLinks(client)
    assert.equal(client.getQueryState(series)?.isInvalidated, true)
    assert.equal(client.getQueryState(detail)?.isInvalidated, false)
  } finally {
    client.clear()
  }
})
