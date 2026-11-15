import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  MediaSourcesSchema,
  type AlbumDetail,
  type FilmDetail,
} from '@repo/schemas/media'
import {
  ProviderLocalWorkerStatusSchema,
  ProviderSummarySchema,
  type ProviderLocalWorkerStatus,
} from '@repo/schemas/provider'
import MediaSources from './media-sources'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in media Sources UI tests')
})

const createdAt = '2026-01-01T00:00:00.000Z'
const item = FilmDetailSchema.parse({
  id: 'film-1',
  mediaType: 'film',
  slug: 'fixture-film',
  title: 'Fixture film',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [],
  links: [
    {
      provider: 'youtube-trailer',
      label: 'Fixture trailer',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
  ],
  playlists: [],
  providerReferences: [
    {
      provider: 'imdb',
      referenceType: 'imdb',
      externalId: 'tt1234567',
      isPrimary: true,
      metadata: null,
    },
  ],
  runtimeMinutes: null,
  sourceKind: null,
  watched: false,
  budget: null,
  boxOffice: null,
  createdAt,
  updatedAt: createdAt,
})
const provider = ProviderSummarySchema.parse({
  id: 'example',
  displayName: 'Example provider',
  description: '',
  surface: 'provider',
  mediaTypes: ['film'],
  rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
  identifierTypes: ['imdb'],
  supportsScrape: true,
  supportsLegacyImport: false,
  secrets: [],
  pluginPath: null,
})

function renderSources(
  source = provider,
  worker?: ProviderLocalWorkerStatus,
  media: AlbumDetail | FilmDetail = item,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['history', media.id, 'sources'],
    MediaSourcesSchema.parse({
      providers: [
        {
          id: 'google-custom-search',
          latestSnapshot: {
            id: 'legacy-snapshot',
            provider: 'google-custom-search',
            source: 'legacy-import',
            jobId: null,
            createdAt,
          },
        },
      ],
      changes: [],
    }),
  )
  client.setQueryData(['providers'], [source])
  if (worker)
    client.setQueryData(['providers', 'local-worker', source.id], worker)
  client.setQueryData(
    ['jobs', 'source-refresh-active', { kind: media.mediaType, id: media.id }],
    { page: 1, size: 100, items: [], totalCount: 0, pageCount: 0 },
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <MediaSources item={media} onSaved={async () => {}} />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Sources keeps archived snapshots and shared film identifiers accessible with refresh restricted to eligible rows', () => {
  const html = renderSources()
  assert.match(html, /Google Custom Search \(legacy\)/)
  assert.match(
    html,
    /aria-label="Google Custom Search \(legacy\) history" aria-expanded="false"/,
  )
  assert.match(html, /tt1234567/)
  assert.match(html, /aria-label="Edit Example provider identifier"/)
  assert.match(html, /aria-label="Select Example provider"/)
  assert.match(html, /<button[^>]*>Refresh all eligible<\/button>/)
  assert.doesNotMatch(
    html,
    /Stored response|View snapshot|youtube-trailer|Fixture trailer/,
  )
})

const readyWorker = ProviderLocalWorkerStatusSchema.parse({
  mode: 'local',
  supportsModeSwitch: true,
  configured: true,
  paired: true,
  online: true,
  blocked: false,
  active: false,
  lastSeenAt: 1,
})
const workerProvider = ProviderSummarySchema.parse({
  ...provider,
  supportsLocalWorker: true,
  secrets: [
    {
      key: 'fixture',
      label: 'Fixture credential',
      required: true,
      configured: false,
      helpText: null,
      placeholder: null,
    },
  ],
})
const selectedProviderDisabled =
  /aria-label="Select Example provider" disabled=""/

test('Sources requires a configured, paired, online and unblocked local worker', () => {
  assert.doesNotMatch(
    renderSources(workerProvider, readyWorker),
    selectedProviderDisabled,
  )
  for (const [change, feedback] of [
    [{ configured: false }, /Local worker not configured/],
    [{ paired: false }, /Local worker not paired/],
    [{ online: false }, /Local worker offline/],
    [{ blocked: true }, /Local worker needs review/],
  ] satisfies [Partial<ProviderLocalWorkerStatus>, RegExp][]) {
    const html = renderSources(workerProvider, { ...readyWorker, ...change })
    assert.match(html, selectedProviderDisabled)
    assert.match(html, feedback)
  }
  assert.match(renderSources(workerProvider), selectedProviderDisabled)
})

test('Cloudflare mode uses server credentials even when a local worker is supported', () => {
  const cloudWorker = {
    ...readyWorker,
    mode: 'cloud',
  } satisfies ProviderLocalWorkerStatus
  const unavailable = renderSources(workerProvider, cloudWorker)
  assert.match(unavailable, selectedProviderDisabled)
  assert.match(unavailable, /Credentials required/)
  const configured = {
    ...workerProvider,
    secrets: workerProvider.secrets.map((secret) => ({
      ...secret,
      configured: true,
    })),
  }
  assert.doesNotMatch(
    renderSources(configured, {
      ...cloudWorker,
      configured: false,
      paired: false,
      online: false,
    }),
    selectedProviderDisabled,
  )
  assert.match(
    renderSources(configured, { ...cloudWorker, blocked: true }),
    selectedProviderDisabled,
  )
})

test('Sources can refresh an album by a barcode supplied by another provider', () => {
  const album = AlbumDetailSchema.parse({
    ...item,
    mediaType: 'album',
    id: 'album-1',
    dateAdded: null,
    durationSec: null,
    spotifyUrl: null,
    trackCount: 0,
    tracks: [],
    providerReferences: [
      {
        provider: 'fixture-import',
        referenceType: 'upc',
        externalId: '012345678905',
        isPrimary: true,
        metadata: null,
      },
    ],
  })
  const html = renderSources(
    { ...provider, mediaTypes: ['album'], identifierTypes: ['upc'] },
    undefined,
    album,
  )
  assert.doesNotMatch(html, selectedProviderDisabled)
  assert.doesNotMatch(html, /Identifier required/)
})
