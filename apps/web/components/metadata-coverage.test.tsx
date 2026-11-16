import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CoverageSchema } from '@repo/schemas/coverage'
import {
  CoverageReview,
  MetadataCoverage,
  coverageRequest,
  type MetadataCoverageKind,
} from './metadata-coverage'
import { ConfigContext } from './providers'
import {
  coverageGapIds,
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
    assert.match(html, /42 albums · stale after 180 days/)
    assert.match(html, /class="ds-mark" title="Discogs">DI</)
    assert.match(html, /36 of 40/)
    assert.match(html, />Queue 2 missing</)
    assert.match(html, />Refresh 2 stale</)
    assert.match(html, /42 of 42/)
    assert.match(html, /Complete/)
    assert.match(html, /data-status="attention">Credentials required</)
    assert.doesNotMatch(html, /Queue 32 missing/)
    assert.match(html, /2 albums need an identifier first/)
  }
})

test('with a track list, the gap counts link to it beside Queue and Refresh', () => {
  const html = render('playlist', coverage, false, () => {})
  assert.match(
    html,
    /data-variant="link"[^>]*aria-label="Show the entries missing Discogs"[^>]*>2 missing</,
  )
  assert.match(html, /aria-label="Queue 2 missing for Discogs"[^>]*>Queue</)
  assert.match(
    html,
    /aria-label="Show the entries with stale Discogs"[^>]*>2 stale</,
  )
  assert.match(html, /aria-label="Refresh 2 stale for Discogs"[^>]*>Refresh</)
  // An unavailable provider's gap can still be shown, not queued.
  assert.match(html, /aria-label="Show the entries missing Rate Your Music"/)
  assert.doesNotMatch(html, /Queue 32 missing for Rate Your Music/)
  assert.doesNotMatch(render('artist', coverage), /data-variant="link"/)
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
  assert.match(html, /100 albums never fetched \(the first 100 of 120\)/)
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
  assert.match(small, /2 albums never fetched/)
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
