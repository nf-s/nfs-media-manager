import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ArtistMetadataItemSchema } from '@repo/schemas/creators'
import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in artist metadata tests')
})
const timestamp = '2026-01-01T00:00:00.000Z'

test('artist metadata renders artist selection, playlist and freshness filters with explicit provider selection', async () => {
  const { default: NewScrapePageClient } =
    await import('./pages/new-scrape-page-client')
  const client = new QueryClient()
  client.setQueryData(['ai-status'], { available: true, reason: null })
  const params = new URLSearchParams({
    q: '',
    sortBy: 'name',
    direction: 'asc',
    freshness: '[]',
    filters: '[]',
    ranges: '[]',
  })
  client.setQueryData(
    ['artist-selection', params.toString(), 1],
    BrowsePageSliceSchema(ArtistMetadataItemSchema).parse({
      page: 1,
      size: 50,
      hasMore: false,
      items: [
        {
          id: 'fixture-artist',
          name: 'Fixture artist',
          sortName: null,
          createdAt: timestamp,
          artworkUrl: null,
          albumCount: 2,
          trackCount: 5,
          playlistCount: 1,
          providers: [
            {
              provider: 'musicbrainz',
              lastScrapedAt: timestamp,
              lastAttemptAt: timestamp,
              lastJobStatus: 'succeeded',
            },
          ],
        },
      ],
    }),
  )
  client.setQueryData(
    [
      'artist-selection',
      'count',
      'q=&freshness=%5B%5D&filters=%5B%5D&ranges=%5B%5D',
    ],
    { totalCount: 1 },
  )
  client.setQueryData(
    ['providers'],
    [
      ProviderSummarySchema.parse({
        id: 'musicbrainz',
        displayName: 'MusicBrainz',
        description: '',
        surface: 'provider',
        mediaTypes: ['album'],
        supportsScrape: true,
        supportsLegacyImport: false,
        pluginPath: null,
        secrets: [],
        rateLimit: { minTimeMs: 0, maxConcurrent: 1 },
      }),
    ],
  )
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3000',
            apiBaseUrl: 'http://localhost:4000',
          }}
        >
          <PathnameContext.Provider value="/jobs/metadata">
            <SearchParamsContext.Provider
              value={new URLSearchParams({ mediaType: 'artist' })}
            >
              <NewScrapePageClient />
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(html, /aria-label="Artist metadata"/)
    assert.match(html, /<option value="artist" selected="">Artists<\/option>/)
    assert.match(html, /Select all loaded artists/)
    assert.match(html, /Select all 1 matching artists/)
    assert.match(html, /Select Fixture artist/)
    assert.match(html, /Search artists/)
    assert.match(html, /role="combobox"/)
    assert.match(html, /Record search/)
    assert.match(html, /<\/svg>Filters<\/button>/)
    assert.match(html, /Filter Playlists/)
    assert.match(html, /Filter MusicBrainz freshness/)
    assert.match(html, /dateTime="2026-01-01T00:00:00.000Z"/)
    assert.doesNotMatch(html, /Album metadata|Film metadata|Legacy import/)
    const providerControls = html.match(
      /<fieldset class="ops-providers"[\s\S]*?<\/fieldset>/,
    )?.[0]
    // The selection bar, with providers and Review, appears once rows are selected.
    assert.equal(providerControls, undefined)
    assert.doesNotMatch(html, /Review 0 metadata jobs/)
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
})

test('artist freshness keeps a successful scrape date visible after a failed attempt', async () => {
  const { ArtistScrapeState } = await import('./artist-metadata-table')
  const html = renderToStaticMarkup(
    <ArtistScrapeState
      label="MusicBrainz"
      state={{
        provider: 'musicbrainz',
        lastScrapedAt: timestamp,
        lastAttemptAt: '2026-02-02T00:00:00.000Z',
        lastJobStatus: 'failed',
      }}
    />,
  )
  assert.match(html, /dateTime="2026-01-01T00:00:00.000Z"/)
  assert.match(html, /data-status="failed">Failed</)
  assert.match(html, /title="Last successful MusicBrainz scrape: 2026-01-01 /)
  assert.doesNotMatch(html, />Never</)
})

test('artist freshness distinguishes unattempted, failed and queued without claiming success', async () => {
  const { ArtistScrapeState } = await import('./artist-metadata-table')
  const render = (
    lastJobStatus: 'queued' | 'failed' | null,
    lastAttemptAt: string | null,
  ) =>
    renderToStaticMarkup(
      <ArtistScrapeState
        label="Spotify"
        state={{
          provider: 'spotify',
          lastScrapedAt: null,
          lastAttemptAt,
          lastJobStatus,
        }}
      />,
    )
  assert.match(render(null, null), />Never</)
  assert.match(render('failed', timestamp), /data-status="failed">Failed</)
  assert.match(render(null, timestamp), /data-status="never">Not scraped</)
  assert.match(render('queued', null), />Queued</)
})
