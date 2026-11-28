import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { ReactNode } from 'react'
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
import JobsWorkspace from './jobs-workspace'
import ImportsWorkspace from './imports-workspace'
import AlbumImportPageClient from './pages/album-import-page-client'
import ProvidersPageClient from './pages/providers-page-client'
import AppNavigation from './app-navigation'
import { LibrarySelector } from './media-scope'
import FileImportPageClient from './pages/file-import-page-client'
import ImportsPageClient from './pages/imports-page-client'
import JobsPageClient from './pages/jobs-page-client'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}
let FilmSelectionTable: typeof import('./film-selection-table').default
let updateProviderFreshness: typeof import('./film-selection-table').updateProviderFreshness
let NewScrapePageClient: typeof import('./pages/new-scrape-page-client').default
before(async () => {
  const selection = await import('./film-selection-table')
  FilmSelectionTable = selection.default
  updateProviderFreshness = selection.updateProviderFreshness
  NewScrapePageClient = (await import('./pages/new-scrape-page-client')).default
})

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
  supportsLegacyImport: false,
  secrets: [],
  pluginPath: null,
})
const filmProvider = ProviderSummarySchema.parse({
  ...albumProvider,
  id: 'cinema',
  displayName: 'Film metadata',
  mediaTypes: ['film'],
})
const youtubeProvider = ProviderSummarySchema.parse({
  ...albumProvider,
  id: 'youtube',
  displayName: 'YouTube',
  mediaTypes: [],
  subscriptions: true,
  supportsScrape: false,
})
const spotifyProvider = ProviderSummarySchema.parse({
  ...albumProvider,
  id: 'spotify',
  displayName: 'Spotify',
  subscriptions: true,
  supportsScrape: false,
})
const accountProvider = ProviderSummarySchema.parse({
  ...youtubeProvider,
  id: 'scrobbles',
  displayName: 'Scrobble history',
  subscriptions: false,
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
  hasLegacyImport: false,
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
  client.setQueryData(['ai-status'], { available: true, reason: null })
  client.setQueryData(
    ['providers'],
    [
      albumProvider,
      filmProvider,
      youtubeProvider,
      spotifyProvider,
      accountProvider,
    ],
  )
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
    playback: false,
    expiresAt: null,
    scope: null,
    redirectUri: null,
  })
  client.setQueryData(['album-fields'], albumBrowseFields)
  client.setQueryData(['albums', 'facets', ''], [])
  const params = new URLSearchParams({
    q: '',
    sortBy: 'dateAdded',
    direction: 'desc',
    filters: '[]',
    ranges: '[]',
    freshness: '[]',
    legacyImport: 'all',
  })
  for (const scope of ['album', 'film']) {
    const items = selectionItems.filter((item) => item.mediaType === scope)
    client.setQueryData([`${scope}-selection`, params.toString(), 1], {
      items,
      page: 1,
      pageCount: 1,
      totalCount: items.length,
      size: 50,
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
  assert.doesNotMatch(html, /aria-label="Select First album" checked/)
  // The selection bar, with providers and Review, appears once rows are selected.
  assert.doesNotMatch(html, /ds-selectbar|metadata jobs/)
})

test('both metadata tables distinguish legacy imports and offer a multiselect header filter', () => {
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
    providerFreshness: {
      cinema: { lastScrapedAt: null, hasProviderIdentifier: true },
    },
  })
  for (const item of [album, film]) {
    const html = render(
      '/jobs/metadata',
      `mediaType=${item.mediaType}`,
      <FilmSelectionTable
        mediaType={item.mediaType}
        providers={[item.mediaType === 'album' ? albumProvider : filmProvider]}
      />,
      [],
      true,
      [
        { ...item, hasLegacyImport: true },
        { ...item, id: `${item.id}-new`, title: 'New item' },
      ],
    )
    assert.match(html, /aria-label="Filter Legacy import"/)
    assert.match(html, /type="checkbox"[^>]*\/><span>Yes/)
    assert.match(html, /type="checkbox"[^>]*\/><span>No/)
    const rows = html.match(/<tr[^>]*>.*?<\/tr>/g) ?? []
    assert.equal(rows.length, 3)
    assert.match(rows[1] ?? '', /<td>Yes<\/td>/)
    assert.match(rows[2] ?? '', /<td>No<\/td>/)
    for (const row of rows.slice(1))
      assert.match(
        row,
        /title="No successful [^"]+ scrape"><span class="ds-status" data-status="never">Never</,
      )
  }
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
  assert.match(html, /href="\/jobs\/failed%2Fjob"/)
  assert.match(html, /data-status="failed">Failed<\/span><\/a>/)
  assert.match(html, /data-layout="fixed"/)
  assert.ok(html.includes(`title="${error}"`))
  assert.match(
    html,
    /class="ds-cell-sub ops-danger"[^>]*>Provider request failed/,
  )
  assert.doesNotMatch(html, /data-status="never"/)
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
    assert.match(html, /data-status="never">Never</)
    assert.match(html, /disabled="">All values<\/button>/)
    for (const label of [
      'Never attempted',
      'Latest attempt failed',
      'No successful scrape',
      ...[30, 90, 180, 365].map(
        (days) => `No success or older than ${days} days`,
      ),
    ])
      assert.ok(html.includes(`<span>${label}</span>`))
    assert.doesNotMatch(html, /Never scraped|Never or older/)
  }
})

test('latest failed, running and cancelled attempts take precedence over success dates in both libraries', () => {
  const statuses: NonNullable<
    AlbumSelectionItem['providerFreshness'][string]['lastAttempt']
  >['status'][] = ['failed', 'running', 'cancelled']
  for (const status of statuses) {
    for (const lastScrapedAt of [null, '2026-01-01T00:00:00Z']) {
      for (const { html } of renderFreshness({
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
        assert.ok(html.includes('href="/jobs/attempt%2Fjob"'))
        const label =
          status === 'failed'
            ? 'Failed'
            : status === 'running'
              ? 'Running'
              : 'Cancelled'
        assert.ok(html.includes(`>${label}</span></a>`))
        assert.doesNotMatch(html, /data-status="never"/)
        if (lastScrapedAt) {
          assert.match(html, /Last successful [^"]+ scrape: 2026-01-01 /)
          assert.ok(
            html.includes(
              `<time dateTime="${lastScrapedAt}" class="ds-cell-sub">`,
            ),
          )
        } else assert.match(html, /No successful [^"]+ scrape/)
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
      assert.ok(html.includes(`<time dateTime="${date}">`))
      assert.match(html, /title="Last successful [^"]+ scrape: 2026-01-01 /)
      assert.doesNotMatch(
        html,
        /data-status="never"|>Failed<|>Running<|>Cancelled</,
      )
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
    assert.match(html, />Failed<\/span><\/a>/)
    assert.match(html, /Needs ID/)
    assert.doesNotMatch(html, /data-status="never"|title="null"/)
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

test('provider overview reads the selected library from the URL', () => {
  const html = render('/providers', 'mediaType=album', <ProvidersPageClient />)
  assert.match(html, /<option value="album" selected="">Albums<\/option>/)
  assert.match(html, /<h1>Providers<\/h1>/)
})

/** Navigation markup without icons, so links read as label text. */
function renderNavigation(path: string, search: string) {
  return render(path, search, <AppNavigation />)
    .replace(/<svg.*?<\/svg>/g, '')
    .replace(/<span>([^<]*)<\/span>/g, '$1')
}

/** The rail's own links, without the activity popover's links. */
function navLinks(html: string) {
  return html.match(/<a class="ds-nav-item"/g) ?? []
}

test('main navigation retains library scope including Tags and direct Spotify links', () => {
  for (const path of ['/albums', '/imports/spotify']) {
    const html = renderNavigation(path, '')
    for (const section of ['tags', 'imports'])
      assert.ok(html.includes(`href="/${section}?mediaType=album"`))
    // Jobs and Providers appear once, under System, for every library.
    assert.match(html, /System<\/div>/)
    assert.match(html, /href="\/jobs">Jobs</)
    assert.match(html, /href="\/providers">Providers</)
  }
})

test('main navigation has one Browse destination and preserves current browse filters', () => {
  const html = renderNavigation('/albums', 'q=artist&view=table&filters=%5B%5D')
  assert.match(
    html,
    /aria-current="page" href="\/albums\?q=artist&amp;view=table&amp;filters=%5B%5D">Browse/,
  )
  assert.equal(navLinks(html).length, 10)
  assert.match(html, /href="\/albums\/ratings">Ratings/)
  assert.match(html, /href="\/albums\/matches">Matches/)
  assert.match(html, /href="\/albums\/changes">History/)
  assert.doesNotMatch(html, /href="\/artists/)
  assert.match(html, /href="\/playlists\?mediaType=album">Playlists/)
  assert.match(html, /href="\/collections\?mediaType=album">Collections/)
  assert.doesNotMatch(html, />Albums<|>Films<|href="\/films/)
  const detail = renderNavigation('/films/one', '')
  assert.match(detail, /aria-current="page" href="\/films">Browse/)
  assert.equal(navLinks(detail).length, 10)
  assert.match(detail, /href="\/films\/ratings">Ratings/)
  assert.match(detail, /href="\/films\/matches">Matches/)
  assert.match(
    detail,
    /href="\/people\?mediaType=film">People.*href="\/playlists\?mediaType=film">Playlists.*href="\/collections\?mediaType=film">Collections/,
  )
  const playlists = renderNavigation('/playlists', 'mediaType=film')
  assert.match(
    playlists,
    /aria-current="page" href="\/playlists\?mediaType=film">Playlists/,
  )
  assert.match(playlists, /href="\/films">Browse/)
})

test('main navigation browses tracks from the track and playlist pages', () => {
  const tracks = renderNavigation('/tracks', 'q=title')
  assert.match(tracks, /aria-current="page" href="\/tracks\?q=title">Browse/)
  assert.match(tracks, /href="\/playlists\?mediaType=track">Playlists/)
  assert.doesNotMatch(tracks, />Collections<|href="\/collections/)
  const playlists = renderNavigation('/playlists', '')
  assert.match(playlists, /href="\/tracks">Browse/)
  assert.match(
    playlists,
    /aria-current="page" href="\/playlists\?mediaType=track">Playlists/,
  )
  assert.doesNotMatch(playlists, />Collections<|href="\/collections/)
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
  const html = renderNavigation(
    '/jobs',
    'mediaType=album&status=attention&jobId=one',
  )
  assert.match(
    html,
    /aria-current="page" href="\/jobs\?mediaType=album&amp;status=attention&amp;jobId=one">Jobs/,
  )
  assert.match(html, /href="\/providers">Providers/)
  assert.match(html, /href="\/albums">Browse/)
  assert.doesNotMatch(html, /\/providers\?[^"]*(?:jobId|status)=/)
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

test('import results retain warnings, errors and job links in a labelled cell disclosure', () => {
  const run = importRun('album', 'succeeded')
  run.errorMessage = 'An additional retained diagnostic.'
  run.result = {
    albums: 3,
    films: 0,
    created: 3,
    updated: 2,
    warnings: [
      'A long synthetic warning that stays available.',
      'Second warning.',
    ],
    jobBatchId: 'album-batch',
    queuedJobs: 3,
    skippedJobs: 2,
  }
  const html = render(
    '/imports',
    'mediaType=album',
    <ImportsWorkspace>
      <ImportsPageClient />
    </ImportsWorkspace>,
    [run],
  )
  assert.match(html, /aria-label="Import result details"/)
  assert.match(html, /popover="auto" role="dialog"/)
  assert.match(html, /Warnings \(2\)/)
  assert.match(html, /A long synthetic warning that stays available\./)
  assert.match(html, /An additional retained diagnostic\./)
  assert.match(html, /href="\/jobs\?batchId=album-batch&amp;mediaType=album"/)
  assert.doesNotMatch(html, /<summary>Warnings/)
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
      const html = renderNavigation(path, `mediaType=${scope}`)
      // Jobs and Providers keep the library open before them in the rail.
      const shown =
        path.startsWith('/jobs') || path === '/providers' ? 'album' : scope
      for (const target of ['tags', 'imports'])
        assert.ok(html.includes(`href="/${target}?mediaType=${shown}"`))
    }
  }
  assert.match(
    renderNavigation('/albums/first', 'mediaType=film'),
    /href="\/tags\?mediaType=album"/,
  )
  assert.match(
    renderNavigation('/films/first', 'mediaType=album'),
    /href="\/tags\?mediaType=film"/,
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

test('Subscriptions navigation has Browse, Matches, Channels, Playlists, Imports, Jobs and Providers', () => {
  const html = renderNavigation('/subscriptions', 'q=talk')
  assert.equal(navLinks(html).length, 7)
  assert.match(html, /href="\/subscriptions\/matches">Matches/)
  assert.match(
    html,
    /aria-current="page" href="\/subscriptions\?q=talk">Browse/,
  )
  assert.match(
    html,
    /href="\/subscriptions\/channels">Channels.*href="\/playlists\?mediaType=subscription">Playlists.*href="\/imports\/youtube\?mediaType=subscription">Imports/,
  )
  assert.match(html, /href="\/jobs">Jobs/)
  assert.match(html, /href="\/providers">Providers/)
  assert.doesNotMatch(
    html,
    /Tags|Collections|href="\/(albums|films|tags|collections)/,
  )
  const playlists = renderNavigation('/playlists', 'mediaType=subscription')
  assert.match(
    playlists,
    /aria-current="page" href="\/playlists\?mediaType=subscription">Playlists/,
  )
  const channels = renderNavigation('/subscriptions/channels', '')
  assert.match(
    channels,
    /aria-current="page" href="\/subscriptions\/channels">Channels/,
  )
  assert.doesNotMatch(channels, /aria-current="page" href="\/subscriptions">/)
  const jobs = renderNavigation('/jobs', 'mediaType=subscription&status=failed')
  assert.match(
    jobs,
    /aria-current="page" href="\/jobs\?mediaType=subscription&amp;status=failed">Jobs/,
  )
  const podcasts = renderNavigation('/imports/spotify-podcasts', '')
  assert.match(
    podcasts,
    /aria-current="page" href="\/imports\/youtube\?mediaType=subscription">Imports/,
  )
})

test('library selector lists Subscriptions and selects it on its pages', () => {
  function unexpectedNavigation() {
    throw new Error('Navigation forbidden during rendering')
  }
  for (const { path, search } of [
    { path: '/imports/youtube', search: '' },
    { path: '/subscriptions/channels', search: '' },
  ]) {
    const html = render(
      path,
      search,
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
    assert.match(
      html,
      /<option value="subscription" selected="">Subscriptions<\/option>/,
    )
    assert.doesNotMatch(html, /YouTube/)
  }
})

test('Subscriptions imports list the YouTube and Spotify podcast syncs only', () => {
  const html = render(
    '/imports/spotify-podcasts',
    'mediaType=subscription',
    <ImportsWorkspace>
      <span>Podcasts</span>
    </ImportsWorkspace>,
  )
  assert.match(html, /href="\/imports\/youtube\?mediaType=subscription"/)
  assert.match(
    html,
    /href="\/imports\/spotify-podcasts\?mediaType=subscription"/,
  )
  assert.doesNotMatch(html, /Recent imports|Spotify saved albums|Album CSV/)
})

test('Jobs has one heading and its tabs, with Subscriptions as a library filter', () => {
  const html = render(
    '/jobs',
    'mediaType=subscription',
    <JobsWorkspace>
      <JobsPageClient />
    </JobsWorkspace>,
  )
  assert.match(html, /<div class="ds-pagehead"><h1>Jobs<\/h1><\/div>/)
  assert.match(
    html,
    /<a class="ds-tab" aria-current="page" href="\/jobs\?mediaType=subscription">Activity<\/a>/,
  )
  // Subscriptions have no metadata; the tab opens the rail's library.
  assert.match(html, /href="\/jobs\/metadata\?mediaType=album">Metadata</)
  assert.match(
    html,
    /<option value="subscription" selected="">Subscriptions<\/option>/,
  )
  assert.doesNotMatch(html, /Subscription jobs/)
})

test('providers are listed by library: the server filters each library', () => {
  for (const library of ['subscription', 'album', 'film'])
    assert.match(
      render('/providers', `mediaType=${library}`, <ProvidersPageClient />),
      new RegExp(`<option value="${library}" selected="">`),
    )
  assert.match(
    render('/providers', '', <ProvidersPageClient />),
    /<option value="" selected="">All libraries<\/option>/,
  )
})

test('metadata table keeps search, count and columns above header filters and footer actions', () => {
  const html = render(
    '/jobs/metadata',
    'mediaType=album',
    <FilmSelectionTable mediaType="album" providers={[albumProvider]} />,
  )
  const toolbar = html.indexOf('class="ds-toolbar"')
  const search = html.indexOf('Search albums or add a filter')
  const filters = html.indexOf('aria-label="Filter Legacy import"')
  const count = html.indexOf('1 albums')
  const columns = html.indexOf('class="table-column-controls"')
  assert.ok(toolbar > -1)
  assert.ok(
    toolbar < search && search < count && count < columns && columns < filters,
  )
  assert.match(html, /aria-label="Record search"/)
  const header = html.match(/<thead>(.*?)<\/thead>/s)?.[1]
  assert.ok(header)
  assert.match(header, /aria-label="Filter Legacy import"/)
  assert.match(header, /aria-label="Filter Music metadata freshness"/)
  assert.match(header, /range/)
  assert.match(html, /data-sticky="edge"/)
  assert.doesNotMatch(
    html,
    /Clear selection|film-selection|secondary-table-footer/,
  )
})

test('the shared metadata toolbar places active chips above search and count', async () => {
  const { default: MetadataSelectionToolbar } =
    await import('./metadata-selection-toolbar')
  const html = render(
    '/jobs/metadata',
    'mediaType=album',
    <MetadataSelectionToolbar
      fields={albumBrowseFields}
      value={{
        q: 'Fixture',
        filters: [{ field: 'genre', value: 'Jazz', mode: 'required' }],
        ranges: [],
      }}
      providerFilters={[
        {
          key: 'fixture:never',
          label: 'Fixture provider · Never attempted',
          remove: () => {},
        },
      ]}
      onChange={() => {}}
      onClear={() => {}}
      search={<input type="search" aria-label="Search metadata" />}
      count="10 albums"
      columns={<button type="button">Columns</button>}
    />,
  )
  const chips = html.indexOf('aria-label="Active filters"')
  const freshness = html.indexOf(
    'aria-label="Remove Fixture provider · Never attempted filter"',
  )
  const toolbar = html.indexOf('class="ds-toolbar"')
  const search = html.indexOf('aria-label="Search metadata"')
  const count = html.indexOf('10 albums')
  assert.ok(chips > -1 && chips < freshness && freshness < toolbar)
  assert.ok(toolbar < search && search < count)
})

test('Mixes navigation has Browse, Shows, Playlists and Imports, then Jobs and Providers, and no Matches', () => {
  const html = renderNavigation('/mixes', 'q=late')
  assert.equal(navLinks(html).length, 6)
  assert.match(html, /aria-current="page" href="\/mixes\?q=late">Browse/)
  assert.match(
    html,
    /href="\/mixes\/shows">Shows.*href="\/playlists\?mediaType=mix">Playlists.*href="\/imports\/rinse\?mediaType=mix">Imports/,
  )
  assert.match(html, /href="\/jobs">Jobs/)
  assert.match(html, /href="\/providers">Providers/)
  assert.doesNotMatch(
    html,
    /Matches|Tags|Collections|Channels|href="\/(albums|films|subscriptions)/,
  )
  const shows = renderNavigation('/mixes/shows', '')
  assert.match(shows, /aria-current="page" href="\/mixes\/shows">Shows/)
  assert.doesNotMatch(shows, /aria-current="page" href="\/mixes">/)
  const station = renderNavigation('/imports/lotradio', '')
  assert.match(
    station,
    /aria-current="page" href="\/imports\/rinse\?mediaType=mix">Imports/,
  )
})

test('library selector lists Mixes and selects it on its pages', () => {
  function unexpectedNavigation() {
    throw new Error('Navigation forbidden during rendering')
  }
  for (const path of ['/mixes', '/mixes/shows', '/imports/nts']) {
    const html = render(
      path,
      '',
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
    assert.match(html, /<option value="mix" selected="">Mixes<\/option>/)
    assert.match(html, /<option value="subscription">Subscriptions<\/option>/)
  }
})

test('Mixes imports list one sync page per station only', () => {
  const html = render(
    '/imports/nts',
    'mediaType=mix',
    <ImportsWorkspace>
      <span>Station</span>
    </ImportsWorkspace>,
  )
  for (const [station, label] of [
    ['rinse', 'Rinse FM'],
    ['nts', 'NTS'],
    ['lotradio', 'The Lot Radio'],
  ])
    assert.match(
      html,
      new RegExp(`href="/imports/${station}\\?mediaType=mix">.*?${label}<`),
    )
  assert.doesNotMatch(
    html,
    /Recent imports|YouTube|Spotify podcasts|Spotify saved albums|Album CSV/,
  )
})

test('Jobs and Providers offer Mixes as a library filter', () => {
  const jobs = render(
    '/jobs',
    'mediaType=mix',
    <JobsWorkspace>
      <JobsPageClient />
    </JobsWorkspace>,
  )
  assert.match(
    jobs,
    /<a class="ds-tab" aria-current="page" href="\/jobs\?mediaType=mix">Activity<\/a>/,
  )
  assert.match(jobs, /<option value="mix" selected="">Mixes<\/option>/)
  assert.match(
    render('/providers', 'mediaType=mix', <ProvidersPageClient />),
    /<option value="mix" selected="">Mixes<\/option>/,
  )
})
