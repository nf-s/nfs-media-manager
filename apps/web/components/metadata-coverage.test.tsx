import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { CoverageSchema, type CoverageSubject } from '@repo/schemas/coverage'
import { ArtistDetailSchema } from '@repo/schemas/creators'
import { ArtistDetail } from './artist-detail'
import {
  CoverageReview,
  MetadataCoverage,
  PlaylistCoverage,
  coverageRequest,
  type MetadataCoverageKind,
} from './metadata-coverage'
import { ConfigContext } from './providers'
import {
  artistCoverageKey,
  artistCoverageQueueRequest,
  artistGapHref,
} from '@/utils/coverage-entries'
import {
  coverageGapIds,
  coverageKey,
  coveragePath,
  coverageQueueRequest,
} from '@/utils/metadata-coverage'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in coverage tests')
})

const batchId = '00000000-0000-4000-8000-000000000000'
const many = Array.from({ length: 120 }, (_, index) => `album-${index}`)
const coverage = CoverageSchema.parse({
  total: 42,
  olderThanDays: 180,
  providers: [
    {
      provider: 'discogs',
      displayName: 'Discogs',
      eligible: 40,
      covered: 36,
      stale: 2,
      missing: 2,
      unavailableReason: null,
      missingItemIds: ['album-3', 'album-7'],
      staleItemIds: ['album-11', 'album-12'],
    },
    {
      provider: 'musicbrainz',
      displayName: 'MusicBrainz',
      eligible: 42,
      covered: 42,
      stale: 0,
      missing: 0,
      unavailableReason: null,
      missingItemIds: [],
      staleItemIds: [],
    },
    {
      provider: 'rym',
      displayName: 'Rate Your Music',
      eligible: 42,
      covered: 10,
      stale: 0,
      missing: 32,
      unavailableReason: 'credentials-missing',
      missingItemIds: ['album-1'],
      staleItemIds: [],
    },
  ],
})

function render(
  kind: MetadataCoverageKind,
  data?: unknown,
  failed = false,
  onShowGap?: () => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  const queryKey = [kind, 'set-1', 'coverage']
  if (data !== undefined) client.setQueryData(queryKey, data)
  if (failed)
    client
      .getQueryCache()
      .build(client, { queryKey })
      .setState({
        status: 'error',
        error: new Error('Offline'),
        fetchStatus: 'idle',
      })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <MetadataCoverage kind={kind} id="set-1" onShowGap={onShowGap} />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Coverage shows each provider with its gap actions and unavailable reason', () => {
  assert.equal(
    coveragePath('playlist', 'set 1'),
    '/api/v1/playlists/set%201/coverage',
  )
  assert.equal(coveragePath('artist', 'a'), '/api/v1/artists/a/coverage')
  for (const kind of ['playlist', 'artist'] satisfies MetadataCoverageKind[]) {
    const html = render(kind, coverage)
    assert.match(html, /<h3>Coverage<\/h3>/)
    assert.match(
      html,
      kind === 'playlist'
        ? /42 library albums · last successful scrape · stale after 180 days/
        : /42 albums · stale after 180 days/,
    )
    assert.match(html, /class="ds-mark" title="Discogs">DI</)
    assert.match(html, /36 of 40/)
    assert.match(html, />Queue 2 missing</)
    assert.match(html, />Refresh 2 stale</)
    assert.match(html, /42 of 42/)
    assert.match(html, /Complete/)
    assert.match(html, /data-status="attention">Credentials required</)
    assert.doesNotMatch(html, /Queue 32 missing/)
    assert.match(html, /2 (?:library )?albums need an identifier first/)
  }
})

test('with a track list, the gap counts link to it beside Queue and Refresh', () => {
  const html = render('playlist', coverage, false, () => {})
  assert.match(
    html,
    /data-variant="link"[^>]*aria-label="Show entries for 2 library albums with no successful Discogs scrape"[^>]*>2 without a successful scrape</,
  )
  assert.match(
    html,
    /aria-label="Queue Discogs scrapes for 2 library albums"[^>]*>Queue</,
  )
  assert.match(
    html,
    /aria-label="Show entries for 2 library albums with stale Discogs metadata"[^>]*>2 stale</,
  )
  assert.match(
    html,
    /aria-label="Refresh Discogs metadata for 2 library albums"[^>]*>Refresh</,
  )
  // An unavailable provider's gap can still be shown, not queued.
  assert.match(
    html,
    /aria-label="Show entries for 32 library albums with no successful Rate Your Music scrape"/,
  )
  assert.doesNotMatch(
    html,
    /Queue Rate Your Music scrapes for 32 library albums/,
  )
  assert.doesNotMatch(render('artist', coverage), /data-variant="link"/)
})

test('Spotify scrape coverage distinguishes albums in the library from albums with no scrape', () => {
  const data = CoverageSchema.parse({
    total: 2,
    olderThanDays: 180,
    providers: [
      {
        provider: 'spotify',
        displayName: 'Spotify',
        eligible: 2,
        covered: 0,
        stale: 0,
        missing: 2,
        unavailableReason: null,
        missingItemIds: ['album-1', 'album-2'],
        staleItemIds: [],
      },
    ],
  })
  const html = render('playlist', data, false, () => {})
  assert.match(html, /2 library albums · last successful scrape/)
  assert.match(html, /0 of 2/)
  assert.match(
    html,
    /aria-label="Show entries for 2 library albums with no successful Spotify scrape"[^>]*>2 without a successful scrape</,
  )
})

test('a review of selected rows states the first 100 of the selected albums', () => {
  const provider = coverage.providers[0]
  assert.ok(provider)
  const html = renderToStaticMarkup(
    <CoverageReview
      review={{ provider, gap: 'missing', ids: many.slice(0, 100), count: 120 }}
      olderThanDays={180}
      pending={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )
  assert.match(html, /Queue 100 metadata jobs for Discogs/)
  assert.match(
    html,
    /100 albums without a successful scrape \(the first 100 of 120\)/,
  )
})

test('Coverage shows a skeleton, empty states and a retryable error', () => {
  const loading = render('playlist')
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /class="ds-skel"/)
  assert.match(render('artist', { ...coverage, total: 0 }), /No albums/)
  const failed = render('artist', undefined, true)
  assert.match(failed, /role="alert"/)
  assert.match(failed, /Could not load coverage/)
  assert.match(failed, />Retry</)
})

test('the review states the provider and the number of jobs and flags a broad run', () => {
  const missing = coverage.providers[0]
  assert.ok(missing)
  const small = renderToStaticMarkup(
    <CoverageReview
      review={coverageRequest(missing, 'missing')}
      olderThanDays={180}
      pending={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )
  assert.match(small, /aria-label="Review metadata jobs"/)
  assert.match(small, /Queue 2 metadata jobs for Discogs/)
  assert.match(small, /2 albums without a successful scrape/)
  assert.match(small, />Confirm 2 metadata jobs</)
  assert.match(small, />Cancel</)
  assert.doesNotMatch(small, /data-tone="attention"/)
  const broad = renderToStaticMarkup(
    <CoverageReview
      review={coverageRequest(
        { ...missing, stale: 120, staleItemIds: many.slice(0, 100) },
        'stale',
      )}
      olderThanDays={180}
      pending={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )
  assert.match(broad, /Queue 100 metadata jobs for Discogs/)
  assert.match(broad, /last fetched over 180 days ago/)
  assert.match(broad, /the first 100 of 120/)
  assert.match(broad, /data-tone="attention"/)
})

test('queue requests send at most 100 IDs and confirm a broad run only after review', () => {
  const missing = coverageQueueRequest({
    provider: 'discogs',
    gap: 'missing',
    ids: ['album-3', 'album-7'],
    olderThanDays: 180,
    confirmed: true,
    batchId,
  })
  assert.deepEqual(missing.freshness, [
    { provider: 'discogs', mode: 'unscraped' },
  ])
  assert.equal(missing.confirmBroadRun, false)
  assert.deepEqual(missing.providers, ['discogs'])
  const stale = coverageQueueRequest({
    provider: 'discogs',
    gap: 'stale',
    ids: many,
    olderThanDays: 90,
    confirmed: true,
    batchId,
  })
  assert.equal(stale.mediaItemIds.length, 100)
  assert.equal(stale.confirmBroadRun, true)
  assert.deepEqual(stale.freshness, [
    { provider: 'discogs', mode: 'older', olderThanDays: 90 },
  ])
  assert.equal(
    coverageQueueRequest({
      provider: 'discogs',
      gap: 'stale',
      ids: many.slice(0, 6),
      olderThanDays: 90,
      confirmed: false,
      batchId,
    }).confirmBroadRun,
    false,
  )
  const provider = coverage.providers[0]
  assert.ok(provider)
  assert.deepEqual(coverageGapIds(provider, 'stale'), ['album-11', 'album-12'])
})

const artistCoverage = CoverageSchema.parse({
  total: 4,
  olderThanDays: 180,
  providers: [
    {
      provider: 'musicbrainz',
      displayName: 'MusicBrainz',
      eligible: 4,
      covered: 1,
      stale: 1,
      missing: 2,
      unavailableReason: null,
      missingItemIds: ['artist-2', 'artist-4'],
      staleItemIds: ['artist-3'],
    },
    {
      provider: 'lastfm',
      displayName: 'Last.fm',
      eligible: 4,
      covered: 0,
      stale: 0,
      missing: 4,
      unavailableReason: 'credentials-missing',
      missingItemIds: ['artist-1', 'artist-2', 'artist-3', 'artist-4'],
      staleItemIds: [],
    },
  ],
})

function renderPlaylistCoverage(
  subject: CoverageSubject,
  cache: [unknown[], unknown][],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  for (const [key, data] of cache) client.setQueryData(key, data)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <PlaylistCoverage
            id="set-1"
            subject={subject}
            onSubjectChange={() => {}}
            onShowGap={() => {}}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

/** The href of the link with this accessible name. */
function linkTo(html: string, label: string) {
  const anchor = html.match(
    new RegExp(`<a[^>]*aria-label="${label}"[^>]*>`),
  )?.[0]
  const href = anchor?.match(/href="([^"]+)"/)?.[1]
  assert.ok(href, `Expected a link named ${label}`)
  return new URL(href.replaceAll('&amp;', '&'), 'https://app.example.test')
}

test('a playlist Coverage switches between its albums and its artists', () => {
  const albums = renderPlaylistCoverage('albums', [
    [coverageKey('playlist', 'set-1'), coverage],
  ])
  assert.match(albums, /<h3>Coverage<\/h3>/)
  assert.match(albums, /role="group" aria-label="Coverage of"/)
  assert.match(albums, /aria-pressed="true"[^>]*>Albums</)
  assert.match(albums, /aria-pressed="false"[^>]*>Artists</)
  assert.match(
    albums,
    /42 library albums · last successful scrape · stale after 180 days/,
  )
  assert.match(
    albums,
    /aria-label="Show entries for 2 library albums with no successful Discogs scrape"/,
  )

  const artists = renderPlaylistCoverage('artists', [
    [artistCoverageKey('set-1'), artistCoverage],
  ])
  assert.match(artists, /aria-pressed="true"[^>]*>Artists</)
  assert.match(artists, /4 artists · stale after 180 days/)
  assert.doesNotMatch(artists, /albums/)
  assert.match(artists, /1 of 4/)
  assert.match(
    artists,
    /aria-label="Queue 2 missing for MusicBrainz"[^>]*>Queue</,
  )
  assert.match(
    artists,
    /aria-label="Refresh 1 stale for MusicBrainz"[^>]*>Refresh</,
  )
  assert.match(artists, /data-status="attention">Credentials required</)
  assert.doesNotMatch(artists, /Queue 4 missing for Last.fm/)
})

test('artist gap counts open Artists Metadata filtered to the playlist and the gap', () => {
  const html = renderPlaylistCoverage('artists', [
    [artistCoverageKey('set-1'), artistCoverage],
  ])
  assert.match(
    html,
    /<a[^>]*data-variant="link"[^>]*aria-label="Show the artists missing MusicBrainz"[^>]*>2 missing<\/a>|<a[^>]*aria-label="Show the artists missing MusicBrainz"[^>]*data-variant="link"[^>]*>2 missing<\/a>/,
  )
  const missing = linkTo(html, 'Show the artists missing MusicBrainz')
  assert.equal(missing.pathname, '/jobs/metadata')
  assert.equal(missing.searchParams.get('mediaType'), 'artist')
  assert.deepEqual(
    JSON.parse(missing.searchParams.get('playlistIds') ?? '[]'),
    ['set-1'],
  )
  assert.deepEqual(JSON.parse(missing.searchParams.get('freshness') ?? '[]'), [
    { provider: 'musicbrainz', mode: 'unscraped' },
  ])
  assert.equal(missing.searchParams.has('sortBy'), false)
  const stale = linkTo(html, 'Show the artists with stale MusicBrainz')
  assert.deepEqual(JSON.parse(stale.searchParams.get('freshness') ?? '[]'), [
    { provider: 'musicbrainz', mode: 'older', olderThanDays: 180 },
  ])
  assert.equal(stale.searchParams.get('sortBy'), 'lastScrapedAt')
  assert.equal(stale.searchParams.get('provider'), 'musicbrainz')
  assert.equal(stale.searchParams.get('direction'), 'desc')
  // An unavailable provider's artists can still be listed, not queued.
  assert.equal(
    linkTo(html, 'Show the artists missing Last.fm').searchParams.get(
      'mediaType',
    ),
    'artist',
  )
  assert.equal(
    artistGapHref('a b', 'lastfm', 'missing', 30),
    `/jobs/metadata?${new URLSearchParams({
      playlistIds: '["a b"]',
      freshness: '[{"provider":"lastfm","mode":"unscraped"}]',
      mediaType: 'artist',
    })}`,
  )
})

test('artist Coverage shows a skeleton and an empty playlist', () => {
  assert.match(renderPlaylistCoverage('artists', []), /aria-busy="true"/)
  const empty = renderPlaylistCoverage('artists', [
    [
      artistCoverageKey('set-1'),
      {
        ...artistCoverage,
        total: 0,
        providers: artistCoverage.providers.map((provider) => ({
          ...provider,
          eligible: 0,
          covered: 0,
          stale: 0,
          missing: 0,
          missingItemIds: [],
          staleItemIds: [],
        })),
      },
    ],
  ])
  assert.match(empty, /No artists/)
  assert.doesNotMatch(empty, /Queue/)
})

test('an artist review names artists and the artist queue rules', () => {
  const provider = artistCoverage.providers[0]
  assert.ok(provider)
  const html = renderToStaticMarkup(
    <CoverageReview
      review={coverageRequest(provider, 'missing')}
      olderThanDays={180}
      subject="artists"
      pending={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )
  assert.match(html, /Queue 2 metadata jobs for MusicBrainz/)
  assert.match(html, /2 artists never fetched/)
  assert.match(html, /Artists fetched since or with an active job are skipped/)
  assert.doesNotMatch(html, /album/i)
})

test('artist queue requests go through the artist queue with its freshness filter', () => {
  const missing = artistCoverageQueueRequest({
    provider: 'fixture-provider',
    gap: 'missing',
    ids: ['artist-2', 'artist-4'],
    olderThanDays: 180,
    confirmed: true,
  })
  assert.deepEqual(missing, {
    artistIds: ['artist-2', 'artist-4'],
    providers: ['fixture-provider'],
    freshness: [{ provider: 'fixture-provider', mode: 'unscraped' }],
    confirmBroadRun: false,
  })
  const artists = many.map((id) => id.replace('album', 'artist'))
  const stale = artistCoverageQueueRequest({
    provider: 'lastfm',
    gap: 'stale',
    ids: artists,
    olderThanDays: 90,
    confirmed: true,
  })
  assert.equal(stale.artistIds.length, 100)
  assert.equal(stale.confirmBroadRun, true)
  assert.deepEqual(stale.freshness, [
    { provider: 'lastfm', mode: 'older', olderThanDays: 90 },
  ])
  // Provider IDs are validated before catalog eligibility is checked at the API.
  assert.throws(() =>
    artistCoverageQueueRequest({
      provider: 'invalid provider',
      gap: 'missing',
      ids: ['artist-1'],
      olderThanDays: 180,
      confirmed: true,
    }),
  )
})

const artistDetail = ArtistDetailSchema.parse({
  id: 'set-1',
  name: 'Synthetic artist',
  sortName: null,
  artworkUrl: null,
  profile: { tags: [] },
  providers: [],
  identifiers: [],
  history: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  albumCount: 1,
  trackCount: 1,
  playlistCount: 0,
})

function renderArtist(search: string) {
  const client = new QueryClient()
  client.setQueryData(['artist', artistDetail.id], artistDetail)
  client.setQueryData(coverageKey('artist', artistDetail.id), coverage)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <PathnameContext.Provider value={`/artists/${artistDetail.id}`}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              <ArtistDetail id={artistDetail.id} />
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

test('an artist shows Coverage in its own tab, not in Overview', () => {
  const overview = renderArtist('')
  const tabs = [...overview.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(tabs, [
    'Overview',
    'Albums',
    'Tracks',
    'Listening',
    'Coverage',
    'Sources',
  ])
  assert.doesNotMatch(overview, /<h3>Coverage<\/h3>/)
  assert.doesNotMatch(overview, /Coverage by provider/)

  const tab = renderArtist('tab=coverage')
  assert.match(tab, /aria-selected="true"[^>]*>Coverage</)
  assert.match(tab, /<h3>Coverage<\/h3>/)
  assert.match(tab, /42 albums · stale after 180 days/)
  assert.match(tab, />Queue 2 missing</)
  // An artist's coverage counts its albums only; there is no mode switch.
  assert.doesNotMatch(tab, /aria-label="Coverage of"/)
})
