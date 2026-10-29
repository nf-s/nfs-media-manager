import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import {
  AlbumSelectionItemSchema,
  type AlbumSelectionItem,
} from '@repo/schemas/album-selection'
import {
  FilmSelectionItemSchema,
  QueueFilmSelectionSchema,
  type FilmSelectionItem,
} from '@repo/schemas/film-selection'
import { albumBrowseFields } from '@repo/schemas/browse'
import { ImportRunSchema, type ImportRun } from '@repo/schemas/imports'
import FilmSelectionTable, {
  updateProviderFreshness,
} from './film-selection-table'
import JobsWorkspace from './jobs-workspace'
import ImportsWorkspace from './imports-workspace'
import AlbumImportPageClient from './pages/album-import-page-client'
import ProvidersPageClient from './pages/providers-page-client'
import NewScrapePageClient from './pages/new-scrape-page-client'
import AppNavigation from './app-navigation'
import { LibrarySelector } from './media-scope'
import FilmRefresh from './film-refresh'
import FileImportPageClient from './pages/file-import-page-client'
import ImportsPageClient from './pages/imports-page-client'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const albumProvider = ProviderSummarySchema.parse({
  id: 'music',
  displayName: 'Music metadata',
  description: '',
  surface: 'provider',
  mediaTypes: ['album'],
  rateLimit: { minTimeMs: 1000, maxConcurrent: 1 },
  supportsScrape: true,
  supportsSync: false,
  supportsLegacyImport: false,
  connection: null,
  secrets: [],
  pluginPath: null,
})
const filmProvider = ProviderSummarySchema.parse({
  ...albumProvider,
  id: 'cinema',
  displayName: 'Film metadata',
  mediaTypes: ['film'],
})
const album = AlbumSelectionItemSchema.parse({
  id: 'album-1',
  mediaType: 'album',
  slug: 'first',
  title: 'First album',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [{ role: 'artist', name: 'Example artist', billingOrder: 0 }],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  dateAdded: '2026-01-01T00:00:00Z',
  durationSec: null,
  spotifyUrl: null,
  trackCount: 0,
  lastScrapedAt: null,
  hasProviderIdentifier: false,
  providerFreshness: {
    music: { lastScrapedAt: null, hasProviderIdentifier: false },
  },
})

function render(
  path: string,
  search: string,
  children: ReactNode,
  runs: ImportRun[] = [],
  spotifyConnected = true,
  selectionItems: (AlbumSelectionItem | FilmSelectionItem)[] = [album],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['providers'], [albumProvider, filmProvider])
  client.setQueryData(['imports'], { sources: [], runs })
  client.setQueryData(['imports', 'album'], { sources: [], runs })
  client.setQueryData(['imports', 'film'], { sources: [], runs })
  client.setQueryData(
    ['import-formats'],
    [{ id: 'ratings', label: 'Film ratings CSV', kind: 'csv' }],
  )
  client.setQueryData(
    ['album-import-formats'],
    [
      { id: 'album-csv', label: 'Album CSV', kind: 'csv' },
      { id: 'upc-csv', label: 'UPC CSV', kind: 'csv' },
    ],
  )
  client.setQueryData(['spotify-account'], {
    configured: spotifyConnected,
    connected: spotifyConnected,
    expiresAt: null,
    scope: null,
    redirectUri: null,
  })
  client.setQueryData(['album-fields'], albumBrowseFields)
  client.setQueryData(['album-facets'], [])
  const params = new URLSearchParams({
    q: '',
    sortBy: 'dateAdded',
    direction: 'desc',
    filters: '[]',
    ranges: '[]',
    freshness: '[]',
  })
  for (const scope of ['album', 'film']) {
    const items = selectionItems.filter((item) => item.mediaType === scope)
    client.setQueryData([`${scope}-selection`, params.toString()], {
      pages: [
        { items, page: 1, pageCount: 1, totalCount: items.length, size: 50 },
      ],
      pageParams: [1],
    })
  }
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              {children}
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

test('album selection renders artists and provider freshness with no initial selection or enabled queue', () => {
  const html = render(
    '/jobs/metadata',
    'mediaType=album',
    <FilmSelectionTable mediaType="album" providers={[albumProvider]} />,
  )
  assert.match(html, /Example artist/)
  assert.match(html, /Music metadata · Last scraped/)
  assert.match(html, /Never/)
  assert.match(html, /Select all loaded albums/)
  assert.match(html, /href="\/albums\/album-1"/)
  assert.match(html, /Needs ID for Music metadata/)
  assert.match(html, /0 selected/)
  assert.doesNotMatch(html, /aria-label="Select First album" checked/)
  assert.match(
    html,
    /disabled=""[^>]*>Launch metadata jobs for 0 selected albums/,
  )
})

test('failed metadata attempts show the error and scoped job link instead of Never', () => {
  const error = 'Provider request failed: upstream service unavailable. '
    .repeat(12)
    .trim()
  const html = render(
    '/jobs/metadata',
    'mediaType=album',
    <FilmSelectionTable mediaType="album" providers={[albumProvider]} />,
    [],
    true,
    [
      {
        ...album,
        providerFreshness: {
          music: {
            lastScrapedAt: null,
            hasProviderIdentifier: true,
            lastAttempt: {
              status: 'failed',
              startedAt: '2026-10-28T00:00:00Z',
              finishedAt: '2026-10-28T00:01:00Z',
              error,
              jobId: 'failed/job',
            },
          },
        },
      },
    ],
  )
  assert.match(html, /href="\/jobs\?jobId=failed%2Fjob&amp;mediaType=album"/)
  assert.match(html, />Failed<\/a>/)
  assert.match(html, /class="job-status [^"]*" data-status="failed"/)
  assert.match(
    html,
    /class="flex w-full min-w-0 max-w-full [^"]*overflow-hidden"/,
  )
  assert.match(html, /table-layout:fixed/)
  assert.ok(html.includes(`title="${error}"`))
  assert.match(html, /class="[^"]*truncate[^"]*"[^>]*>Provider request failed/)
  assert.doesNotMatch(html, /<td[^>]*>Never/)
})

function renderFreshness(
  state: AlbumSelectionItem['providerFreshness'][string],
) {
  const film = FilmSelectionItemSchema.parse({
    ...album,
    id: 'film-1',
    mediaType: 'film',
    title: 'First film',
    runtimeMinutes: null,
    watched: false,
    sourceKind: null,
    budget: null,
    boxOffice: null,
    providerFreshness: { cinema: state },
  })
  const items = [{ ...album, providerFreshness: { music: state } }, film]
  return items.map((item) => ({
    scope: item.mediaType,
    html: render(
      '/jobs/metadata',
      `mediaType=${item.mediaType}`,
      <FilmSelectionTable
        mediaType={item.mediaType}
        providers={[item.mediaType === 'album' ? albumProvider : filmProvider]}
      />,
      [],
      true,
      items,
    ),
  }))
}

test('both libraries reserve Never for no attempt and no success, and offer distinct filters', () => {
  for (const { html } of renderFreshness({
    lastScrapedAt: null,
    hasProviderIdentifier: true,
    lastAttempt: null,
  })) {
    assert.match(html, /<td title="No successful scrape">Never<\/td>/)
    assert.match(
      html,
      /<option value="all" selected="">All scrape statuses<\/option>/,
    )
    assert.match(html, /<option value="never">Never attempted<\/option>/)
    assert.match(html, /<option value="failed">Latest attempt failed<\/option>/)
    assert.match(
      html,
      /<option value="unscraped">No successful scrape<\/option>/,
    )
    for (const days of [30, 90, 180, 365])
      assert.ok(
        html.includes(
          `<option value="${days}">No success or older than ${days} days</option>`,
        ),
      )
    assert.doesNotMatch(html, /Never scraped|Never or older/)
  }
})

test('latest failed, running and cancelled attempts take precedence over success dates in both libraries', () => {
  const statuses: NonNullable<
    AlbumSelectionItem['providerFreshness'][string]['lastAttempt']
  >['status'][] = ['failed', 'running', 'cancelled']
  for (const status of statuses) {
    for (const lastScrapedAt of [null, '2026-01-01T00:00:00Z']) {
      for (const { scope, html } of renderFreshness({
        lastScrapedAt,
        hasProviderIdentifier: true,
        lastAttempt: {
          status,
          startedAt: '2026-10-28T00:00:00Z',
          finishedAt: status === 'running' ? null : '2026-10-28T00:01:00Z',
          jobId: 'attempt/job',
          error:
            status === 'failed' ? 'Upstream <unavailable> & retry later' : null,
        },
      })) {
        assert.ok(
          html.includes(
            `href="/jobs?jobId=attempt%2Fjob&amp;mediaType=${scope}"`,
          ),
        )
        const label =
          status === 'failed'
            ? 'Failed'
            : status === 'running'
              ? 'Running'
              : 'Cancelled'
        assert.ok(html.includes(`>${label}</a>`))
        assert.doesNotMatch(
          html,
          /<td[^>]*>Never|<time[^>]*aria-label="Last successful/,
        )
        if (lastScrapedAt)
          assert.ok(html.includes(`Last successful scrape: ${lastScrapedAt}`))
        else assert.match(html, /No successful scrape/)
        if (status === 'failed')
          assert.match(
            html,
            /title="Upstream &lt;unavailable&gt; &amp; retry later"/,
          )
      }
    }
  }
})

test('successful attempts and retained legacy successes display the successful date', () => {
  const date = '2026-01-01T00:00:00Z'
  for (const lastAttempt of [
    null,
    {
      status: 'succeeded',
      startedAt: date,
      finishedAt: date,
      jobId: 'success',
      error: null,
    },
  ]) {
    const state = AlbumSelectionItemSchema.shape.providerFreshness.parse({
      music: { lastScrapedAt: date, hasProviderIdentifier: true, lastAttempt },
    }).music
    assert.ok(state)
    for (const { html } of renderFreshness(state)) {
      assert.ok(
        html.includes(`<time dateTime="${date}" aria-label="Last successful`),
      )
      assert.doesNotMatch(html, /<td[^>]*>Never|>Failed<|>Running<|>Cancelled</)
    }
  }
})

test('failed attempts without an error still show a job link and do not claim Never', () => {
  for (const { html } of renderFreshness({
    lastScrapedAt: null,
    hasProviderIdentifier: false,
    lastAttempt: {
      status: 'failed',
      startedAt: '2026-10-28T00:00:00Z',
      finishedAt: null,
      error: null,
      jobId: 'failed',
    },
  })) {
    assert.match(html, />Failed<\/a>/)
    assert.match(html, /Needs ID/)
    assert.doesNotMatch(html, /<td[^>]*>Never|title="null"/)
  }
})

test('freshness changes replace only their provider and retain distinct never, failed and unscraped modes for queueing', () => {
  const existing = updateProviderFreshness([], 'other', '90')
  for (const mode of ['never', 'failed', 'unscraped']) {
    const filters = updateProviderFreshness(
      updateProviderFreshness(existing, 'music', '30'),
      'music',
      mode,
    )
    assert.deepEqual(filters, [
      { provider: 'other', mode: 'older', olderThanDays: 90 },
      { provider: 'music', mode },
    ])
    const queue = QueueFilmSelectionSchema.parse({
      providers: ['music'],
      mediaItemIds: ['album-1'],
      batchId: '00000000-0000-4000-8000-000000000001',
      freshness: filters.filter((filter) => filter.provider === 'music'),
    })
    assert.deepEqual(queue.freshness, [{ provider: 'music', mode }])
    assert.deepEqual(updateProviderFreshness(filters, 'music', 'all'), existing)
  }
  assert.deepEqual(existing, [
    { provider: 'other', mode: 'older', olderThanDays: 90 },
  ])
  for (const days of [30, 90, 180, 365])
    assert.deepEqual(updateProviderFreshness([], 'music', String(days)), [
      { provider: 'music', mode: 'older', olderThanDays: days },
    ])
})

test('jobs sidebar offers one metadata destination and retains album scope', () => {
  const html = render(
    '/jobs/metadata',
    'mediaType=album',
    <JobsWorkspace>
      <NewScrapePageClient />
    </JobsWorkspace>,
  )
  for (const path of ['/jobs', '/jobs/metadata'])
    assert.ok(html.includes(`href="${path}?mediaType=album"`))
  assert.match(html, /Album metadata/)
  assert.doesNotMatch(html, /href="\/jobs\/(new|refresh)/)
  assert.match(html, /Music metadata/)
  assert.doesNotMatch(html, /Film metadata|Specific IDs|Selection limit/)
})

test('album imports expose Spotify and album CSV, not film NFO or film CSV', () => {
  const html = render(
    '/imports/spotify',
    '',
    <ImportsWorkspace>
      <AlbumImportPageClient kind="spotify" />
    </ImportsWorkspace>,
  )
  assert.match(html, /href="\/imports\/spotify\?mediaType=album"/)
  assert.match(html, /href="\/imports\/albums\?mediaType=album"/)
  assert.match(html, /Reconnect Spotify/)
  assert.match(html, /Preview saved albums/)
  assert.match(html, /value="20"/)
  assert.match(html, /Albums to preview/)
  assert.match(html, /Read all saved albums to find newest additions/)
  assert.doesNotMatch(html, /type="checkbox" required=""/)
  assert.doesNotMatch(html, /disabled=""[^>]*>Preview saved albums/)
  assert.match(html, /Reads only the requested batch, sorted by date added/)
  assert.match(html, /No albums are imported and no jobs are queued/)
  assert.doesNotMatch(html, /Start offset|type="checkbox"[^>]*checked=""/)
  assert.doesNotMatch(html, /Find new NFO|Film ratings CSV|Import [1-9]/)
})

test('film import links preserve catalog format deep links and NFO destination', () => {
  const html = render(
    '/imports/csv',
    'format=ratings&mediaType=film',
    <ImportsWorkspace>
      <span>Preview</span>
    </ImportsWorkspace>,
  )
  assert.match(html, /href="\/imports\/csv\?format=ratings&amp;mediaType=film"/)
  assert.match(html, /href="\/imports\/nfo\?mediaType=film"/)
  assert.doesNotMatch(html, /Spotify saved albums|Album CSV/)
})

test('provider workspace filters actual media capabilities', () => {
  const html = render('/providers', 'mediaType=album', <ProvidersPageClient />)
  assert.match(html, /Music metadata/)
  assert.doesNotMatch(html, /Film metadata/)
})

test('main navigation retains library scope including Tags and direct Spotify links', () => {
  for (const path of ['/albums', '/imports/spotify']) {
    const html = render(path, '', <AppNavigation />)
    for (const section of ['tags', 'imports', 'jobs', 'providers'])
      assert.ok(html.includes(`href="/${section}?mediaType=album"`))
  }
})

test('main navigation has one Browse destination and preserves current browse filters', () => {
  const html = render(
    '/albums',
    'q=artist&view=table&filters=%5B%5D',
    <AppNavigation />,
  )
  assert.match(
    html,
    /aria-current="page" href="\/albums\?q=artist&amp;view=table&amp;filters=%5B%5D">Browse/,
  )
  assert.equal((html.match(/<a /g) ?? []).length, 5)
  assert.doesNotMatch(html, />Albums<|>Films<|href="\/films/)
  const detail = render('/films/one', '', <AppNavigation />)
  assert.match(detail, /aria-current="page" href="\/films">Browse/)
})

test('library selector reflects explicit and route-implied scope without duplicate workspace tabs', () => {
  function unexpectedNavigation() {
    throw new Error('Navigation forbidden during rendering')
  }
  for (const path of ['/albums/one', '/jobs/refresh', '/imports/spotify']) {
    const html = render(
      path,
      'mediaType=album',
      <AppRouterContext.Provider
        value={{
          back: unexpectedNavigation,
          forward: unexpectedNavigation,
          refresh: unexpectedNavigation,
          push: unexpectedNavigation,
          replace: unexpectedNavigation,
          prefetch: unexpectedNavigation,
        }}
      >
        <LibrarySelector />
      </AppRouterContext.Provider>,
    )
    assert.match(html, /<select aria-label="Library"/)
    assert.match(html, /<option value="album" selected="">Albums<\/option>/)
    assert.equal((html.match(/<select /g) ?? []).length, 1)
    assert.doesNotMatch(html, /<nav/)
  }
})

test('active administration links retain context but do not leak filters to other sections', () => {
  const html = render(
    '/jobs',
    'mediaType=album&status=attention&jobId=one',
    <AppNavigation />,
  )
  assert.match(
    html,
    /href="\/jobs\?mediaType=album&amp;status=attention&amp;jobId=one"/,
  )
  assert.match(html, /href="\/providers\?mediaType=album"/)
  assert.match(html, /href="\/albums"/)
  assert.doesNotMatch(html, /\/providers\?[^"]*(?:jobId|status)=/)
})

test('legacy album refresh component renders the same unchecked metadata workspace', () => {
  const html = render('/jobs/refresh', 'mediaType=album', <FilmRefresh />)
  assert.match(html, /Album metadata/)
  assert.match(html, /Example artist/)
  assert.doesNotMatch(html, /value="180" selected=""/)
  assert.match(
    html,
    /disabled=""[^>]*>Launch metadata jobs for 0 selected albums/,
  )
})

test('album CSV alias offers catalog formats without film upload or NFO actions', () => {
  const html = render(
    '/imports/csv',
    'mediaType=album',
    <ImportsWorkspace>
      <FileImportPageClient kind="csv" />
    </ImportsWorkspace>,
  )
  assert.match(html, /UPC CSV/)
  assert.match(html, /Choose album CSV file/)
  assert.doesNotMatch(html, /Film ratings CSV|Preview new films/)
})

test('NFO deep links cannot offer film imports under an album scope', () => {
  const html = render(
    '/imports/nfo',
    'mediaType=album',
    <ImportsWorkspace>
      <FileImportPageClient kind="nfo" />
    </ImportsWorkspace>,
  )
  assert.match(html, /Open film NFO import/)
  assert.doesNotMatch(html, /Preview new films|type="file"/)
})

function importRun(
  mediaType: ImportRun['mediaType'],
  status: ImportRun['status'],
) {
  return ImportRunSchema.parse({
    id: `${mediaType}-${status}`,
    mediaType,
    status,
    stage: `${mediaType}-stage-${status}`,
    processed: 0,
    total: 2,
    errorMessage: null,
    result: null,
    createdAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
  })
}

test('history separates every run status by declared scope and retains mixed unknown runs', () => {
  const runs = ImportRunSchema.shape.status.options.flatMap((status) => [
    importRun('album', status),
    importRun('film', status),
    importRun(null, status),
  ])
  for (const scope of ['album', 'film']) {
    const other = scope === 'album' ? 'film' : 'album'
    const html = render(
      '/imports',
      `mediaType=${scope}`,
      <ImportsWorkspace>
        <ImportsPageClient />
      </ImportsWorkspace>,
      runs,
    )
    for (const status of ImportRunSchema.shape.status.options) {
      assert.ok(html.includes(`${scope}-stage-${status}`))
      assert.ok(html.includes(`null-stage-${status}`))
      assert.ok(!html.includes(`${other}-stage-${status}`))
    }
    assert.equal((html.match(/Mixed \/ legacy scope unknown/g) ?? []).length, 5)
    assert.doesNotMatch(html, /Shared import history/)
  }
})

test('history uses declared run scope for metadata links even with zero result counts', () => {
  const run = importRun('album', 'succeeded')
  run.result = {
    albums: 0,
    films: 0,
    created: 0,
    jobBatchId: 'album-batch',
    queuedJobs: 0,
  }
  const html = render(
    '/imports',
    'mediaType=album',
    <ImportsWorkspace>
      <ImportsPageClient />
    </ImportsWorkspace>,
    [run],
  )
  assert.match(html, /href="\/jobs\?batchId=album-batch&amp;mediaType=album"/)
})

test('global import guard links to the other library without leaking its history rows', () => {
  const html = render(
    '/imports',
    'mediaType=film',
    <ImportsWorkspace>
      <ImportsPageClient />
    </ImportsWorkspace>,
    [importRun('album', 'running')],
  )
  assert.match(html, /An album import is in progress/)
  assert.match(html, /href="\/imports\?mediaType=album"/)
  assert.match(html, /No imports yet/)
  assert.doesNotMatch(html, /album-stage-running/)
})

test('main navigation preserves explicit scope across administration and route-implied detail scope', () => {
  for (const path of [
    '/tags',
    '/imports/csv',
    '/jobs',
    '/jobs/new',
    '/jobs/refresh',
    '/jobs/metadata',
    '/providers',
  ]) {
    for (const scope of ['album', 'film']) {
      const html = render(path, `mediaType=${scope}`, <AppNavigation />)
      for (const target of ['tags', 'imports', 'jobs', 'providers'])
        assert.ok(html.includes(`href="/${target}?mediaType=${scope}"`))
    }
  }
  assert.match(
    render('/albums/first', 'mediaType=film', <AppNavigation />),
    /href="\/jobs\?mediaType=album"/,
  )
  assert.match(
    render('/films/first', 'mediaType=album', <AppNavigation />),
    /href="\/jobs\?mediaType=film"/,
  )
})

test('Spotify configuration names exact API callback without switching the signed-in browser host', () => {
  const html = render(
    '/imports/spotify',
    '',
    <ImportsWorkspace>
      <AlbumImportPageClient kind="spotify" />
    </ImportsWorkspace>,
    [],
    false,
  )
  assert.match(html, /http:\/\/127\.0\.0\.1:4001\/api\/v1\/spotify\/callback/)
  assert.match(html, /Keep using this app address/)
  assert.match(html, /callback returns to your signed-in session automatically/)
  assert.doesNotMatch(
    html,
    /localhost:3001\/api\/v1\/spotify\/callback|127\.0\.0\.1:3001\/api\/v1\/spotify\/callback/,
  )
})
