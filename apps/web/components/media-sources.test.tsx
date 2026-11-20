import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
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
import { AlbumListeningSchema } from '@repo/schemas/lastfm'
import { MediaProvenanceSchema } from '@repo/schemas/provenance'
import { InspectorEntryContext } from './detail-inspector-context'
import MediaSources from './media-sources'
import { ConfigContext } from './providers'

// The detail page imports a CSS module, which Node cannot load; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}
let MediaDetail: typeof import('./media-detail').default
before(async () => {
  MediaDetail = (await import('./media-detail')).default
})

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

const albumWithCollections = AlbumDetailSchema.parse({
  ...item,
  id: 'album-with-collections',
  mediaType: 'album',
  title: 'Fixture album',
  dateAdded: null,
  durationSec: null,
  spotifyUrl: null,
  providerReferences: [],
  trackCount: 0,
  tracks: [],
  playlists: [
    {
      id: 'fixture-collection',
      name: 'Fixture collection',
      kind: 'collection',
      position: 0,
    },
    { name: 'Collection without a link', kind: 'collection', position: 1 },
    { name: 'Fixture playlist', kind: 'playlist', position: 0 },
  ],
  collectionSources: [
    {
      provider: 'collections-fixture',
      providerLabel: 'Collection source fixture',
      name: 'Fixture collection',
      url: 'https://example.test/collections/fixture',
    },
  ],
})

function renderSources(
  source = provider,
  worker?: ProviderLocalWorkerStatus,
  media: AlbumDetail | FilmDetail = item,
  view = '',
  seed: Array<[unknown[], unknown]> = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  for (const [key, value] of seed) client.setQueryData(key, value)
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
          <InspectorEntryContext.Provider
            value={{
              active: { kind: media.mediaType, id: media.id, view },
              replaceView: () => {},
            }}
          >
            <MediaSources item={media} onSaved={async () => {}} />
          </InspectorEntryContext.Provider>
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
  // A provider without a logo shows a globe.
  assert.match(
    html,
    /<span class="ds-logo" data-none="" aria-hidden="true"><svg/,
  )
  assert.doesNotMatch(html, /<details class="ds-source" open/)
  assert.match(html, /tt1234567/)
  assert.match(html, /aria-label="Edit Example provider identifier"/)
  assert.match(html, /aria-label="Refresh Example provider"/)
  assert.match(html, /href="\/providers\/example"/)
  assert.match(html, /<button[^>]*>.*Refresh all<\/button>/)
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
  /disabled=""[^>]*aria-label="Refresh Example provider"/

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

test('album Overview links collection memberships to album collection details', () => {
  const client = new QueryClient()
  client.setQueryData(['album', albumWithCollections.id], albumWithCollections)
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <MediaDetail mediaType="album" id={albumWithCollections.id} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(html, />Collections<\/h3>/)
    assert.match(
      html,
      /href="\/collections\/fixture-collection\?mediaType=album"/,
    )
    assert.match(html, />Collection without a link<\/span>/)
    assert.doesNotMatch(
      html,
      /Fixture playlist|https:\/\/example\.test\/collections\/fixture/,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
})

test('album Overview ratings open the page that supplied the score', () => {
  const album = AlbumDetailSchema.parse({
    ...albumWithCollections,
    id: 'album-with-ratings',
    metadata: {
      browse: {
        ratingRymValue: 3.71,
        ratingRymVotes: 420,
        ratingDiscogsValue: 4.4,
        ratingMetacriticValue: 81,
      },
    },
    links: [
      {
        provider: 'rym',
        label: 'RYM',
        url: 'https://rateyourmusic.com/release/album/fixture/',
      },
      {
        provider: 'metacritic',
        label: 'Metacritic',
        url: 'https://www.metacritic.com/music/fixture',
      },
    ],
  })
  const client = new QueryClient()
  client.setQueryData(['album', album.id], album)
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <MediaDetail mediaType="album" id={album.id} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(
      html,
      /<a class="ds-stat" href="https:\/\/rateyourmusic\.com\/release\/album\/fixture\/" target="_blank" rel="noopener noreferrer" title="RYM rating: 3\.71 out of 5\. 420 votes\." aria-label="RYM rating: 3\.71 out of 5\. 420 votes\. Opens in a new tab\."><span class="ds-stat-value">3\.71<\/span><span class="ds-stat-label">RYM<\/span><\/a>/,
    )
    // No Discogs page is stored, so its score is not a link.
    assert.match(
      html,
      /<div class="ds-stat" title="Discogs rating: 4\.4 out of 5\. Vote count unavailable\."><span class="ds-stat-value">4\.4<\/span><span class="ds-stat-label">Discogs<\/span><\/div>/,
    )
    // Metacritic is not among the headline figures, so its page stays in the header.
    assert.doesNotMatch(html, /<span class="ds-stat-value">81</)
    assert.match(
      html,
      /<a[^>]*href="https:\/\/www\.metacritic\.com\/music\/fixture"/,
    )
    assert.equal(html.match(/rateyourmusic\.com/g)?.length, 1)
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
})

test('album tags show in one letter case and each offers its sources for that album', () => {
  const album = AlbumDetailSchema.parse({
    ...albumWithCollections,
    id: 'album-with-tags',
    tags: [{ name: 'dream pop', kind: 'genre' }],
    artistTags: ['shoegaze'],
  })
  const client = new QueryClient()
  client.setQueryData(['album', album.id], album)
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <MediaDetail mediaType="album" id={album.id} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(
      html,
      /<span class="ds-pill browse-filter-pill" data-size="md"><button type="button"[^>]*class="browse-pill-action"><span class="ds-pill-label">Dream Pop<\/span><\/button><button type="button"[^>]*aria-label="Sources for Dream Pop"[^>]*class="browse-pill-action">/,
    )
    // Inherited tags expose the credited artist as a source.
    assert.match(html, /<span class="ds-pill-label">Shoegaze<\/span>/)
    assert.match(html, /aria-label="Sources for Shoegaze"/)
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
})

test('album Sources show stored collection links under their provider', () => {
  const html = renderSources(
    { ...provider, mediaTypes: ['album'] },
    undefined,
    albumWithCollections,
    'sourceProvider=collections-fixture',
  )
  assert.match(html, /Collection source fixture/)
  assert.match(html, /<h4>Collections<\/h4>/)
  assert.match(
    html,
    /href="https:\/\/example\.test\/collections\/fixture" target="_blank" rel="noopener noreferrer"[^>]*>Fixture collection<\/a>/,
  )
  assert.doesNotMatch(html, /Collection without a link|Fixture playlist/)
})

test('album Sources show provider relationships and open only verified library items', () => {
  const album = AlbumDetailSchema.parse({
    ...albumWithCollections,
    relationshipSources: [
      {
        provider: 'relationship-fixture',
        snapshotId: 'fixture-snapshot',
        jobId: null,
        createdAt,
        relationships: [
          {
            kind: 'related',
            targetType: 'album',
            name: 'Resolved fixture album',
            targetId: 'related-fixture-album',
          },
          {
            kind: 'related',
            targetType: 'album',
            name: 'Unresolved fixture album',
            externalId: 'external-album-1',
            url: 'https://example.test/albums/fixture',
          },
          {
            kind: 'influence',
            targetType: 'artist',
            name: 'Resolved fixture artist',
            targetId: 'related-fixture-artist',
          },
        ],
      },
    ],
  })
  const html = renderSources(
    { ...provider, mediaTypes: ['album'] },
    undefined,
    album,
    'sourceProvider=relationship-fixture',
  )
  assert.match(html, /aria-label="Related albums"/)
  assert.match(html, /aria-label="Related artists"/)
  assert.match(
    html,
    /href="\/albums\/related-fixture-album"[^>]*><span class="ds-pill-label">Resolved fixture album/,
  )
  assert.match(
    html,
    /href="\/artists\/related-fixture-artist"[^>]*><span class="ds-pill-label">Resolved fixture artist/,
  )
  assert.match(
    html,
    /<span class="ds-pill" data-size="md"><span class="ds-pill-label">Unresolved fixture album/,
  )
  assert.doesNotMatch(html, /href="https:\/\/example.test\/albums\/fixture"/)
  const closed = renderSources(
    { ...provider, mediaTypes: ['album'] },
    undefined,
    album,
  )
  assert.match(closed, /relationship-fixture/)
  assert.doesNotMatch(closed, /Resolved fixture album|Unresolved fixture album/)
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

test('the Last.fm row of an album holds its scrobble names and each row lists what it supplies', () => {
  const album = AlbumDetailSchema.parse({
    ...item,
    mediaType: 'album',
    id: 'album-1',
    dateAdded: null,
    durationSec: null,
    spotifyUrl: null,
    trackCount: 0,
    tracks: [],
    providerReferences: [],
  })
  const albumProvider = ProviderSummarySchema.parse({
    ...provider,
    mediaTypes: ['album'],
  })
  const listening = AlbumListeningSchema.parse({
    total: 4,
    firstListenedAt: createdAt,
    lastListenedAt: createdAt,
    months: [{ month: '2026-01', count: 4 }],
    tracks: [],
    sources: [
      { artistName: 'Artist fixture', albumName: 'Album fixture', count: 4 },
    ],
    similarUnlinked: [
      {
        artistName: 'Artist fixture',
        albumName: 'Album fixture (Live)',
        count: 1,
      },
    ],
  })
  const provenance = MediaProvenanceSchema.parse({
    mediaItemId: 'album-1',
    mediaType: 'album',
    fields: [
      {
        key: 'title',
        label: 'Title',
        value: 'Fixture film',
        override: null,
        sources: [
          {
            provider: 'example',
            scrapedAt: createdAt,
            snapshotId: 'snap-1',
            snapshotSource: 'scrape-job',
            jobId: 'job-1',
            value: 'Fixture film',
            matchesCurrent: true,
          },
        ],
      },
    ],
  })
  const seed: Array<[unknown[], unknown]> = [
    [['album-listening', 'album-1', ''], listening],
    [['history', 'album-1', 'provenance'], provenance],
  ]
  const closed = renderSources(albumProvider, undefined, album, '', seed)
  assert.match(
    closed,
    /<span class="ds-logo" style="--ds-logo:url\(&quot;\/icons\/logos\/lastfm.png&quot;\)" aria-hidden="true"><\/span>/,
  )
  assert.match(closed, /1 name linked · 1 similar name not linked/)
  assert.match(closed, /data-status="done">Matched by name</)
  const lastfm = renderSources(
    albumProvider,
    undefined,
    album,
    'sourceProvider=lastfm',
    seed,
  )
  assert.match(lastfm, /<h4>Scrobble names<\/h4>/)
  assert.match(lastfm, /aria-label="Unlink Artist fixture — Album fixture"/)
  assert.match(
    lastfm,
    /aria-label="Link Artist fixture — Album fixture \(Live\)"/,
  )
  const example = renderSources(
    albumProvider,
    undefined,
    album,
    'sourceProvider=example',
    seed,
  )
  assert.match(example, /<h4>Provides<\/h4>/)
  assert.match(example, />Title</)
  assert.match(example, /<h4>History<\/h4>/)
})

test('a provider with match search offers Find match from its open row and searches in place', () => {
  const searchable = ProviderSummarySchema.parse({
    ...provider,
    supportsMatchSearch: true,
  })
  assert.doesNotMatch(
    renderSources(provider, undefined, item, 'sourceProvider=example'),
    />Find match</,
  )
  assert.match(
    renderSources(searchable, undefined, item, 'sourceProvider=example'),
    /<h4>Identifier<\/h4><div class="data-stack">[\s\S]*>Find match<\/button>/,
  )
  const searching = renderSources(
    searchable,
    undefined,
    item,
    'sourceProvider=example&sourceMode=match',
    [
      [
        ['jobs', 'find-match-unresolved', item.mediaType, item.id],
        { query: null, items: [] },
      ],
    ],
  )
  assert.match(searching, /<h4>Find match<\/h4>/)
  assert.match(searching, />Search Example provider<\/label>/)
  assert.match(searching, /<button[^>]*type="submit"[^>]*disabled=""/)
  assert.match(searching, />Cancel</)
  assert.doesNotMatch(searching, /<h4>History<\/h4>/)
})
