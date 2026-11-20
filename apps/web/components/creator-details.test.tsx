import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ArtistDetailSchema, PersonDetailSchema } from '@repo/schemas/creators'
import { AlbumListItemSchema, FilmListItemSchema } from '@repo/schemas/media'
import {
  SubscriptionSourceDetailSchema,
  mixBrowseFields,
  subscriptionBrowseFields,
} from '@repo/schemas/subscriptions'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import {
  DetailInspectorProvider,
  InspectorEntryContext,
} from './detail-inspector-context'
import type { ArtistDetail as ArtistDetailComponent } from './artist-detail'
import { ArtistIdentifierSourceRow } from './artist-identifier-sources'
import type { PersonDetail as PersonDetailComponent } from './person-detail'
import { ConfigContext } from './providers'
import { detailEntries, type DetailEntry } from '@/utils/detail-inspector'
import { embeddedScrollClass } from '@/utils/embedded-browse'

// Node cannot load the Browse CSS modules. The rendered class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

async function forbidden(): Promise<Response> {
  throw new Error('Network forbidden in creator detail UI tests')
}
const network = mock.method(globalThis, 'fetch', forbidden)

// The details load after the CSS hook, since their Browse lists import CSS modules.
let ArtistDetail: typeof ArtistDetailComponent
let PersonDetail: typeof PersonDetailComponent
before(async () => {
  ArtistDetail = (await import('./artist-detail')).ArtistDetail
  PersonDetail = (await import('./person-detail')).PersonDetail
})

const timestamp = '2026-01-01T00:00:00.000Z'
const spotifyArtistId = 's'.repeat(22)
const spotifyAlbumId = 'a'.repeat(22)
const spotifyProfile = {
  id: 'artist-profile',
  provider: 'spotify',
  profile: {
    artworkUrl: 'https://images.example.test/artist.jpg',
    url: `https://open.spotify.com/artist/${spotifyArtistId}`,
    externalId: spotifyArtistId,
    summary: 'Synthetic biography.',
    tags: ['Synth-pop'],
  },
  scrapeJobId: 'artist-job',
  createdAt: timestamp,
}
const artist = ArtistDetailSchema.parse({
  id: 'artist-fixture',
  name: 'Synthetic artist',
  sortName: null,
  artworkUrl: null,
  profile: spotifyProfile.profile,
  providers: [spotifyProfile],
  identifiers: [],
  history: [spotifyProfile],
  createdAt: timestamp,
  albumCount: 1,
  trackCount: 2,
  playlistCount: 1,
})

const person = PersonDetailSchema.parse({
  id: 'person-fixture',
  name: 'Synthetic person',
  sortName: null,
  createdAt: timestamp,
  filmCount: 1,
  directorCount: 1,
  actorCount: 1,
  roles: ['director', 'actor'],
})

const commonItem = {
  artworkUrl: null,
  originalTitle: null,
  summary: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: timestamp,
  updatedAt: timestamp,
}
const album = AlbumListItemSchema.parse({
  ...commonItem,
  id: 'album-fixture',
  mediaType: 'album',
  slug: 'synthetic-album',
  title: 'Synthetic album',
  credits: [
    { id: artist.id, name: artist.name, role: 'artist', billingOrder: 0 },
  ],
  dateAdded: null,
  durationSec: null,
  spotifyUrl: `https://open.spotify.com/album/${spotifyAlbumId}`,
  trackCount: 5,
})

const film = FilmListItemSchema.parse({
  ...commonItem,
  id: 'film-fixture',
  mediaType: 'film',
  slug: 'synthetic-film',
  title: 'Synthetic film',
  credits: person.roles.map((role) => ({
    id: person.id,
    name: person.name,
    role,
    billingOrder: 0,
  })),
  runtimeMinutes: 90,
  watched: true,
  sourceKind: null,
  budget: null,
  boxOffice: null,
})

function page<T>(...items: T[]) {
  return {
    page: 1,
    size: 50,
    pageCount: items.length ? 1 : 0,
    totalCount: items.length,
    items,
  }
}

function assertNestedViewControls(
  html: string,
  active: 'Grid' | 'List' | 'Table' = 'Table',
) {
  for (const label of ['Grid', 'List', 'Table'])
    assert.match(
      html,
      new RegExp(
        `aria-pressed="${label === active}" aria-label="${label} view"|aria-label="${label} view" aria-pressed="${label === active}"`,
      ),
    )
}

type RenderOptions = {
  pathname: string
  search?: string
  children: ReactNode
  cache: [readonly unknown[], unknown][]
}

function markup(
  client: QueryClient,
  { pathname, search = '', children }: RenderOptions,
) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{
          appUrl: 'http://localhost:3001',
          apiBaseUrl: 'http://localhost:4001',
        }}
      >
        <PathnameContext.Provider value={pathname}>
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            {children}
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
}

function seededClient(cache: RenderOptions['cache']) {
  const client = new QueryClient()
  for (const [key, data] of cache) client.setQueryData(key, data)
  return client
}

/**
 * Renders a detail whose Browse list answers from fixtures. The first pass
 * names the list's queries and records the requests they would make; the
 * second shows the items.
 */
async function renderBrowse(options: RenderOptions, items: unknown[] = []) {
  const first = seededClient(options.cache)
  const requests: URL[] = []
  const answers: [readonly unknown[], unknown][] = []
  try {
    markup(first, options)
    const queries = first
      .getQueryCache()
      .getAll()
      .filter(
        ({ queryKey }) =>
          queryKey[1] === 'browse' || queryKey[1] === 'browse-count',
      )
    for (const { queryKey } of queries)
      answers.push([
        queryKey,
        queryKey[1] === 'browse'
          ? {
              items,
              page: 1,
              size: 100,
              hasMore: false,
              totalCount: items.length,
            }
          : { totalCount: items.length, unfilteredCount: items.length },
      ])
    network.mock.mockImplementation(async (input) => {
      requests.push(
        new URL(input instanceof Request ? input.url : String(input)),
      )
      return Response.json(
        { statusCode: 500, message: 'Fixture' },
        {
          status: 500,
        },
      )
    })
    await Promise.allSettled(queries.map((query) => query.fetch()))
  } finally {
    network.mock.mockImplementation(forbidden)
    network.mock.resetCalls()
    first.clear()
  }
  const html = render({ ...options, cache: [...options.cache, ...answers] })
  return { html, requests }
}

/** The one request made to a Browse endpoint. */
function request(requests: URL[], pathname: string) {
  const matching = requests.filter((url) => url.pathname === pathname)
  assert.equal(matching.length, 1, `Expected one request to ${pathname}`)
  const [url] = matching
  assert.ok(url)
  return url.searchParams
}

function render(options: RenderOptions) {
  const client = seededClient(options.cache)
  try {
    return markup(client, options)
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function destination(html: string, label: string) {
  const link = html.match(new RegExp(`href="([^"]+)"[^>]*>${label}</a>`))?.[1]
  assert.ok(link, `Expected link ${label}`)
  return new URL(link.replaceAll('&amp;', '&'), 'http://localhost')
}

test('artist overview displays profile evidence and independent music filters without queueing work', () => {
  const html = render({
    pathname: `/artists/${artist.id}`,
    children: <ArtistDetail id={artist.id} />,
    cache: [[['artist', artist.id], artist]],
  })
  assert.match(html, /Synthetic biography\./)
  assert.deepEqual(
    [...html.matchAll(/<span class="ds-stat-label">([^<]+)</g)].map(
      (match) => match[1],
    ),
    ['scrobbles', 'last played', 'playlists', 'added'],
  )
  assert.match(
    html,
    /<span class="ds-stat-value">1<\/span><span class="ds-stat-label">playlists</,
  )
  assert.match(html, /1 album<\/span>.*2 tracks<\/span>/)
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
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
  assert.ok(html.includes(spotifyProfile.profile.url))
  assert.doesNotMatch(html, /Refresh profile/)
  for (const [label, path] of Object.entries({
    'Show in Albums': '/albums',
    'Show in Tracks': '/tracks',
  })) {
    const target = destination(html, label)
    assert.equal(target.pathname, path)
    assert.equal(target.searchParams.get('creatorId'), artist.id)
    assert.equal(target.searchParams.has('filters'), false)
  }
  const tags = destination(html, '<span class="ds-pill-label">Synth-Pop</span>')
  assert.deepEqual(JSON.parse(tags.searchParams.get('filters') ?? '[]'), [
    { field: 'artistTag', value: 'Synth-pop', mode: 'required' },
  ])
})

test('copied artist album Grid preserves the parent detail and playback controls', async () => {
  const entry: DetailEntry = {
    kind: 'artist',
    id: artist.id,
    view: 'tab=albums&view=grid',
  }
  const { html } = await renderBrowse(
    {
      pathname: '/artists',
      search: new URLSearchParams({
        inspect: JSON.stringify([entry]),
      }).toString(),
      cache: [[['artist', artist.id], artist]],
      children: (
        <DetailInspectorProvider>
          <InspectorEntryContext.Provider
            value={{ active: entry, replaceView: () => {} }}
          >
            <ArtistDetail id={artist.id} />
          </InspectorEntryContext.Provider>
        </DetailInspectorProvider>
      ),
    },
    [album],
  )
  assert.match(html, /aria-label="Play Synthetic album[^"]*"/)
  assertNestedViewControls(html, 'Grid')
  assert.match(
    html,
    /<article class="ds-card" data-item-index="0"[^>]*><span class="ds-art">/,
  )
  const target = destination(html, 'Synthetic album')
  assert.deepEqual(detailEntries(target.pathname, target.searchParams), [
    entry,
    { kind: 'album', id: album.id },
  ])
})

test('the artist Albums tab is the Albums browser held to the artist', async () => {
  const { html, requests } = await renderBrowse(
    {
      pathname: `/artists/${artist.id}`,
      search: 'tab=albums',
      children: <ArtistDetail id={artist.id} />,
      cache: [[['artist', artist.id], artist]],
    },
    [album],
  )
  for (const endpoint of ['browse-page', 'browse-count']) {
    const params = request(requests, `/api/v1/albums/${endpoint}`)
    assert.equal(params.get('creatorId'), artist.id)
  }
  const page = request(requests, '/api/v1/albums/browse-page')
  assert.equal(page.get('sortBy'), 'title')
  assert.equal(page.get('direction'), 'asc')
  assertNestedViewControls(html, 'Grid')
  assert.match(html, /aria-label="Search albums"|placeholder="Search albums"/)
  assert.match(html, /role="status">1 album<\/span>/)
  // The artist holds the list; it is not a filter to remove.
  assert.match(
    html,
    /data-filters="short"[^>]*>.*?<span>Filters<\/span><\/button>/,
  )
  assert.doesNotMatch(html, /Remove artist filter|Clear all/)
  // The count and the link to Browse share the line under the toolbar.
  assert.match(
    html,
    /<div class="ds-filterline"><span class="ds-toolbar-count" role="status">1 album<\/span><a [^>]*>Show in Albums<\/a><\/div>/,
  )
  // No page rail, drawer or page actions inside the detail.
  assert.doesNotMatch(html, /class="browse-page"|ds-rail-label|>Add album</)
  assert.ok(html.includes(embeddedScrollClass))
  assert.match(html, /data-inspector-scroll=""/)
  const browse = destination(html, 'Show in Albums')
  assert.equal(browse.pathname, '/albums')
  assert.deepEqual(Object.fromEntries(browse.searchParams), {
    creatorId: artist.id,
    sortBy: 'title',
    direction: 'asc',
    view: 'grid',
    density: 'standard',
  })
})

test('artist album settings cannot remove or change the artist', async () => {
  const { html, requests } = await renderBrowse({
    pathname: `/artists/${artist.id}`,
    search: new URLSearchParams({
      tab: 'albums',
      q: 'Synthetic',
      creatorId: 'other-artist',
      sortBy: 'releaseDate',
      direction: 'desc',
      view: 'table',
    }).toString(),
    children: <ArtistDetail id={artist.id} />,
    cache: [[['artist', artist.id], artist]],
  })
  for (const endpoint of ['browse-page', 'browse-count']) {
    const params = request(requests, `/api/v1/albums/${endpoint}`)
    assert.equal(params.get('creatorId'), artist.id)
    assert.equal(params.get('q'), 'Synthetic')
  }
  assertNestedViewControls(html, 'Table')
  // Only the search counts as a filter, and clearing filters leaves the artist.
  assert.match(
    html,
    /<span>Filters · 1<\/span><span class="ds-count">1<\/span><\/button>/,
  )
  // The search is a pill on the line under the toolbar, before the count.
  assert.match(
    html,
    /<div class="ds-filterline">.*?Search: Synthetic.*?>Clear all<\/button><span class="ds-toolbar-count"/,
  )
  assert.doesNotMatch(html, /Remove artist filter/)
  assert.match(html, /<strong>No albums match<\/strong>/)
  const browse = destination(html, 'Show in Albums')
  assert.equal(browse.searchParams.get('creatorId'), artist.id)
  assert.equal(browse.searchParams.get('q'), 'Synthetic')
  assert.equal(browse.searchParams.get('sortBy'), 'releaseDate')
  assert.equal(browse.searchParams.get('direction'), 'desc')
  assert.equal(browse.searchParams.get('view'), 'table')
})

test('artist albums start in Grid and tracks in Table, each held to the artist', async () => {
  for (const { tab, collection, active } of [
    { tab: 'albums', collection: 'Albums', active: 'Grid' },
    { tab: 'tracks', collection: 'Tracks', active: 'Table' },
  ] satisfies {
    tab: string
    collection: string
    active: 'Grid' | 'Table'
  }[]) {
    const { html, requests } = await renderBrowse({
      pathname: `/artists/${artist.id}`,
      search: `tab=${tab}`,
      children: <ArtistDetail id={artist.id} />,
      cache: [[['artist', artist.id], artist]],
    })
    for (const endpoint of ['browse-page', 'browse-count'])
      assert.equal(
        request(requests, `/api/v1/${tab}/${endpoint}`).get('creatorId'),
        artist.id,
      )
    assertNestedViewControls(html, active)
    // Grid size is in the Filters drawer, not on the toolbar.
    assert.doesNotMatch(html, /aria-label="Grid size"/)
    const browse = destination(html, `Show in ${collection}`)
    assert.equal(browse.pathname, `/${tab}`)
    assert.equal(browse.searchParams.get('creatorId'), artist.id)
    assert.equal(browse.searchParams.get('sortBy'), 'title')
    assert.equal(browse.searchParams.get('direction'), 'asc')
  }
})

test('an old artist Playlists link opens the Overview with the playlists', () => {
  const html = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=playlists',
    children: <ArtistDetail id={artist.id} />,
    cache: [[['artist', artist.id], artist]],
  })
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Overview/)
  assert.match(html, /<h3>Playlists<\/h3>/)
})

test('legacy artist History links reopen the provider in Sources and list summary records', () => {
  const oldSnapshot = {
    id: 'older-profile',
    provider: 'spotify',
    source: null,
    jobId: 'artist-job',
    createdAt: timestamp,
  }
  const html = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=history&provider=spotify',
    children: <ArtistDetail id={artist.id} />,
    cache: [
      [['artist', artist.id], artist],
      [
        ['history', artist.id, 'artist', 'spotify', 'snapshot-list'],
        {
          pages: [
            { ...page(oldSnapshot), size: 10, pageCount: 3, totalCount: 21 },
          ],
          pageParams: [1],
        },
      ],
      [
        ['jobs', 'source-history', 'artist', artist.id, 'spotify'],
        { pages: [page()], pageParams: [1] },
      ],
    ],
  })
  assert.match(html, /<details class="ds-source" open="">/)
  assert.match(html, /aria-label="Spotify history"/)
  assert.match(html, /class="ds-timeline"/)
  assert.match(html, />Show older</)
  assert.doesNotMatch(html, /Stored response/)
  assert.equal(destination(html, 'Job').pathname, '/jobs/artist-job')
})

test('artist Sources offers selectable eligible providers and explicit refresh', () => {
  const spotify = ProviderSummarySchema.parse({
    id: 'spotify',
    displayName: 'Spotify',
    description: '',
    surface: 'provider',
    mediaTypes: ['album'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    supportsScrape: true,
    supportsLegacyImport: false,
    secrets: [],
    pluginPath: null,
  })
  const html = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=sources',
    children: <ArtistDetail id={artist.id} />,
    cache: [
      [['artist', artist.id], artist],
      [['providers'], [spotify]],
      [
        ['jobs', 'source-refresh-active', { kind: 'artist', id: artist.id }],
        page(),
      ],
    ],
  })
  assert.match(html, /aria-label="Refresh Spotify"/)
  assert.match(html, /aria-label="Edit Spotify identifier"/)
  assert.match(html, />Refresh all</)
  assert.match(html, /aria-label="Sources"/)
})

test('configured artist source exposes stored evidence and only opens resolved related artists', () => {
  const provider = ProviderSummarySchema.parse({
    id: 'fixture-provider',
    displayName: 'Fixture provider',
    description: '',
    surface: 'provider',
    mediaTypes: ['album'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    supportsScrape: true,
    supportsArtistEnrichment: true,
    supportsLegacyImport: false,
    secrets: [],
    pluginPath: null,
  })
  const legacy = {
    similarArtists: [
      { name: 'Resolved artist', artistId: 'similar-artist' },
      { name: 'Unresolved artist', externalId: 'different-fixture-id' },
    ],
  }
  const related = {
    relationships: [
      {
        kind: 'similar',
        targetType: 'artist',
        name: 'Resolved artist',
        targetId: 'similar-artist',
      },
      {
        kind: 'similar',
        targetType: 'artist',
        name: 'Unresolved artist',
        externalId: 'different-fixture-id',
      },
      {
        kind: 'related',
        targetType: 'album',
        name: 'Referenced album',
        targetId: 'referenced-album',
      },
    ],
  }
  function profile(relationships: typeof legacy | typeof related) {
    return ArtistDetailSchema.parse({
      ...artist,
      providers: [
        ...artist.providers,
        {
          id: 'fixture-profile',
          provider: provider.id,
          profile: {
            externalId: 'fixture-id',
            summary: 'Fixture profile biography.',
            url: 'https://example.test/artists/fixture',
            tags: ['Fixture tag'],
            ...relationships,
          },
          scrapeJobId: null,
          createdAt: timestamp,
        },
      ],
      identifiers: [
        {
          provider: provider.id,
          externalId: 'fixture-id',
          status: 'confirmed',
          url: 'https://example.test/artists/fixture',
        },
      ],
    })
  }
  const entry: DetailEntry = {
    kind: 'artist',
    id: artist.id,
    view: `tab=sources&provider=${provider.id}`,
  }
  for (const relationships of [legacy, related]) {
    const html = render({
      pathname: '/artists',
      search: new URLSearchParams({
        inspect: JSON.stringify([entry]),
      }).toString(),
      children: (
        <DetailInspectorProvider>
          <InspectorEntryContext.Provider
            value={{ active: entry, replaceView() {} }}
          >
            <ArtistDetail id={artist.id} />
          </InspectorEntryContext.Provider>
        </DetailInspectorProvider>
      ),
      cache: [
        [['artist', artist.id], profile(relationships)],
        [['providers'], [provider]],
      ],
    })
    assert.match(html, /aria-label="Refresh Fixture provider"/)
    assert.match(html, /aria-label="Edit Fixture provider identifier"/)
    assert.match(html, /Fixture profile biography/)
    assert.match(html, /Fixture tag/)
    assert.match(html, /href="https:\/\/example.test\/artists\/fixture"/)
    assert.match(html, /aria-label="Similar artists"/)
    assert.match(html, /Unresolved artist/)
    assert.doesNotMatch(html, />Unresolved artist<\/a>|>Find match</)
    const href =
      /href="([^"]+)"[^>]*><span class="ds-pill-label">Resolved artist<\//.exec(
        html,
      )?.[1]
    assert.ok(href)
    const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost')
    assert.deepEqual(detailEntries(url.pathname, url.searchParams), [
      entry,
      { kind: 'artist', id: 'similar-artist' },
    ])
    if ('relationships' in relationships) {
      assert.match(html, /aria-label="Related albums"/)
      const albumHref =
        /href="([^"]+)"[^>]*><span class="ds-pill-label">Referenced album<\//.exec(
          html,
        )?.[1]
      assert.ok(albumHref)
      const albumUrl = new URL(
        albumHref.replaceAll('&amp;', '&'),
        'http://localhost',
      )
      assert.deepEqual(
        detailEntries(albumUrl.pathname, albumUrl.searchParams),
        [entry, { kind: 'album', id: 'referenced-album' }],
      )
    } else assert.doesNotMatch(html, /aria-label="Related albums"/)
  }
})

test('artist Sources shows stored IDs and provenance controls before any artist enrichment', () => {
  const known = {
    ...artist,
    providers: [],
    history: [],
    identifiers: [
      {
        provider: 'spotify',
        externalId: spotifyArtistId,
        status: 'inferred',
        url: `https://open.spotify.com/artist/${spotifyArtistId}`,
      },
      {
        provider: 'discogs',
        externalId: null,
        status: 'conflict',
        url: null,
      },
    ],
  }
  const html = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=sources',
    children: <ArtistDetail id={artist.id} />,
    cache: [[['artist', artist.id], ArtistDetailSchema.parse(known)]],
  })
  assert.match(
    html,
    new RegExp(`class="ds-source-id">${spotifyArtistId}</span>`),
  )
  assert.match(html, /data-status="attention">Conflicting IDs</)
  assert.match(
    html,
    new RegExp(`href="https://open.spotify.com/artist/${spotifyArtistId}"`),
  )
  // Identifier provenance loads only when its row is opened.
  assert.doesNotMatch(html, /From stored sources|No stored identifier sources/)
  const opened = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=sources&sourceProvider=spotify',
    children: <ArtistDetail id={artist.id} />,
    cache: [[['artist', artist.id], ArtistDetailSchema.parse(known)]],
  })
  assert.match(opened, /<h4>Identifier sources<\/h4>/)
  assert.match(opened, /aria-label="Sources for Spotify identifier"/)
  assert.match(opened, /From stored sources/)
})

test('identifier provenance names and links the actual album, provider and job', () => {
  const html = renderToStaticMarkup(
    <table>
      <tbody>
        <ArtistIdentifierSourceRow
          index={0}
          source={{
            externalId: spotifyArtistId,
            provider: 'spotify',
            kind: 'album',
            id: 'source-album',
            title: 'Synthetic source album',
            snapshotId: 'source-snapshot',
            jobId: 'source-job',
            createdAt: timestamp,
          }}
        />
      </tbody>
    </table>,
  )
  assert.match(html, /Album: Synthetic source album/)
  assert.equal(
    destination(html, 'Synthetic source album').pathname,
    '/albums/source-album',
  )
  assert.equal(
    destination(html, 'Synthetic source album').searchParams.get('tab'),
    'sources',
  )
  assert.equal(destination(html, 'Spotify').pathname, '/jobs/source-job')
  assert.ok(html.includes(spotifyArtistId))
})

test('person films are the Films browser held to the person and the chosen role', async () => {
  const { html, requests } = await renderBrowse(
    {
      pathname: `/people/${person.id}`,
      search: 'role=director',
      children: <PersonDetail id={person.id} />,
      cache: [[['person', person.id], person]],
    },
    [film],
  )
  for (const endpoint of ['browse-page', 'browse-count']) {
    const params = request(requests, `/api/v1/films/${endpoint}`)
    assert.equal(params.get('creatorId'), person.id)
    assert.equal(params.get('creatorRole'), 'director')
  }
  const page = request(requests, '/api/v1/films/browse-page')
  assert.equal(page.get('sortBy'), 'title')
  assert.equal(page.get('direction'), 'asc')
  assert.equal(destination(html, film.title).pathname, `/films/${film.id}`)
  assertNestedViewControls(html, 'Grid')
  assert.match(
    html,
    /<article class="ds-card" data-item-index="0"[^>]*><span class="ds-art" data-ratio="poster">/,
  )
  // The role control counts; the person is not a removable filter.
  assert.match(html, /<span>Filters · 1<\/span>/)
  assert.doesNotMatch(html, /Remove director filter/)
  const browse = destination(html, 'Show in Films')
  assert.equal(browse.pathname, '/films')
  assert.equal(browse.searchParams.get('creatorId'), person.id)
  assert.equal(browse.searchParams.get('creatorRole'), 'director')
  assert.equal(browse.searchParams.get('sortBy'), 'title')
  assert.equal(browse.searchParams.get('direction'), 'asc')
  assert.equal(browse.searchParams.get('view'), 'grid')
})

test('person films without a chosen role include every credit', async () => {
  const { html, requests } = await renderBrowse({
    pathname: `/people/${person.id}`,
    children: <PersonDetail id={person.id} />,
    cache: [[['person', person.id], person]],
  })
  for (const endpoint of ['browse-page', 'browse-count']) {
    const params = request(requests, `/api/v1/films/${endpoint}`)
    assert.equal(params.get('creatorId'), person.id)
    assert.equal(params.has('creatorRole'), false)
  }
  assert.match(html, /<span>Filters<\/span><\/button>/)
  assert.match(html, /<strong>No films yet<\/strong>/)
  assert.doesNotMatch(html, />Add film</)
  assert.equal(
    destination(html, 'Show in Films').searchParams.has('creatorRole'),
    false,
  )
})

test('copied person film List keeps its sort and role', async () => {
  const { html, requests } = await renderBrowse(
    {
      pathname: `/people/${person.id}`,
      search: 'view=list&role=director&sortBy=runtimeMinutes&direction=desc',
      children: <PersonDetail id={person.id} />,
      cache: [[['person', person.id], person]],
    },
    [film],
  )
  const page = request(requests, '/api/v1/films/browse-page')
  assert.equal(page.get('sortBy'), 'runtimeMinutes')
  assert.equal(page.get('direction'), 'desc')
  assert.equal(page.get('creatorRole'), 'director')
  assertNestedViewControls(html, 'List')
  assert.match(html, /class="ds-thumb" data-ratio="poster"/)
  assert.match(html, /aria-label="Sort by: Runtime"/)
  assert.match(html, /<span>Filters · 1<\/span>/)
  assert.equal(destination(html, film.title).pathname, `/films/${film.id}`)
})

test('person Sources reports the absence of a provider record', () => {
  const html = render({
    pathname: `/people/${person.id}`,
    search: 'tab=sources',
    children: <PersonDetail id={person.id} />,
    cache: [[['person', person.id], person]],
  })
  assert.match(html, /aria-label="Sources"/)
  assert.match(html, /No provider sources are stored for this person\./)
  assert.doesNotMatch(html, /Refresh all/)
})

test('film Browse uses the creator scope for its query and names the removable role filter', async () => {
  const { default: MediaBrowser } = await import('./media-browser')
  const scope = { creatorId: person.id, creatorRole: 'director' }
  const identity = JSON.stringify({
    q: '',
    filters: [],
    ranges: [],
    sortBy: 'releaseDate',
    direction: 'desc',
    includeArchived: false,
    limitResults: null,
    ...scope,
  })
  const html = render({
    pathname: '/films',
    search: new URLSearchParams(scope).toString(),
    children: <MediaBrowser mediaType="film" />,
    cache: [
      [['person', person.id], person],
      [['films', 'browse', identity, 1], page()],
    ],
  })
  assert.match(html, /Director: Synthetic person/)
  assert.match(html, /aria-label="Remove director filter"/)
  assert.match(html, /Clear all/)
  assert.match(html, /No films match/)
  // The page keeps its own frame and actions, and has no link to itself.
  assert.match(html, /<section class="browse-page" aria-label="films">/)
  assert.match(html, />Add film</)
  assert.doesNotMatch(html, /Show in Films|data-inspector-scroll/)
})

test('channel details show saved podcast episodes and scope Browse to the exact channel ID', async () => {
  const { ChannelDetail } = await import('./channel-detail')
  const id = 'c'.repeat(22)
  const episodeId = 'e'.repeat(22)
  const data = SubscriptionSourceDetailSchema.parse({
    source: {
      type: 'spotify',
      id,
      title: 'Synthetic podcast',
      description: 'Synthetic description.',
      thumbnailUrl: null,
      url: `https://open.spotify.com/show/${id}`,
      storedItems: 1,
      latestItemAt: timestamp,
      historyComplete: false,
      itemTotal: 10,
    },
    items: page({
      type: 'spotify',
      id: episodeId,
      sourceId: id,
      sourceTitle: 'Synthetic podcast',
      sourceThumbnailUrl: null,
      title: 'Synthetic episode',
      description: '',
      tags: [],
      publishedAt: timestamp,
      publishedPrecision: 'year',
      durationSec: 120,
      url: `https://open.spotify.com/episode/${episodeId}`,
      artworkUrl: null,
    }),
  })
  const { html, requests } = await renderBrowse(
    {
      pathname: `/channels/${id}`,
      search: 'view=grid',
      children: <ChannelDetail id={id} />,
      cache: [
        [['subscriptions', 'source', id], data],
        [['subscriptions', 'fields'], subscriptionBrowseFields],
      ],
    },
    data.items.items,
  )
  const list = request(requests, '/api/v1/subscriptions/browse-page')
  assert.equal(list.get('sourceId'), id)
  assert.equal(list.get('sortBy'), 'publishedAt')
  assert.equal(list.get('direction'), 'desc')
  assert.match(html, /Synthetic description\./)
  assert.match(html, /Reading history/)
  assert.match(html, /<h3>Episodes<\/h3>/)
  assert.match(html, /placeholder="Search titles, channels, podcasts, tags..."/)
  assertNestedViewControls(html, 'Grid')
  assert.match(
    html,
    /<article class="ds-card" data-item-index="0"><span class="ds-art" data-ratio="video">/,
  )
  // The channel is not a removable filter.
  assert.doesNotMatch(html, /Remove channel filter/)
  const browse = destination(html, 'Show in Subscriptions')
  assert.equal(browse.pathname, '/subscriptions')
  assert.equal(browse.searchParams.get('sourceId'), id)
  assert.equal(browse.searchParams.get('sortBy'), 'publishedAt')
  assert.equal(browse.searchParams.get('direction'), 'desc')
  assert.equal(browse.searchParams.get('view'), 'grid')
  assert.equal(
    destination(html, 'Synthetic episode').pathname,
    `/subscriptions/${episodeId}`,
  )
  assert.equal(
    destination(html, 'Filter subscriptions').searchParams.get('sourceId'),
    id,
  )
  assert.match(
    html,
    /<button[^>]*aria-pressed="true" aria-describedby="[^"]+" title="Follows the connected Spotify account\. Change it there\.">.*?Subscribed<\/button>/,
  )
  assert.match(html, /role="menuitem"[^>]*>Filter subscriptions</)
  const sources = render({
    pathname: `/channels/${id}`,
    search: 'tab=sources',
    children: <ChannelDetail id={id} />,
    cache: [[['subscriptions', 'source', id], data]],
  })
  const table = sources.slice(sources.indexOf('aria-label="Sources"'))
  assert.match(table, /class="ds-source"/)
  assert.ok(table.includes(data.source.url))
  assert.ok(table.includes(id))
  assert.doesNotMatch(table, /Refresh/)
})

const showId = 'lotradio.example-morning-show'
const mixItem = {
  type: 'lotradio',
  id: 'lotradio.example-morning-show-2026-04-02',
  sourceId: showId,
  sourceTitle: 'Example Morning Show',
  sourceThumbnailUrl: null,
  title: 'Example Morning Show 2026-04-02',
  description: 'Opening Track - Synthetic artist\nClosing Track - Another Name',
  tags: ['house'],
  publishedAt: '2026-04-02T09:00:00.000Z',
  publishedPrecision: 'day',
  durationSec: 3600,
  url: 'https://www.thelotradio.com/shows/example-morning-show/2026-04-02',
  artworkUrl: null,
  artists: ['Synthetic artist'],
  audioUrl: null,
}

test('show details list stored mixes square and filter Mixes by the exact show ID', async () => {
  const { ChannelDetail } = await import('./channel-detail')
  const data = SubscriptionSourceDetailSchema.parse({
    source: {
      type: 'lotradio',
      id: showId,
      title: 'Example Morning Show',
      description: null,
      thumbnailUrl: null,
      url: 'https://www.thelotradio.com/shows/example-morning-show',
      storedItems: 1,
      latestItemAt: mixItem.publishedAt,
      historyComplete: true,
      itemTotal: null,
    },
    items: page(mixItem),
  })
  const { html, requests } = await renderBrowse(
    {
      pathname: `/mixes/shows/${showId}`,
      search: 'view=grid',
      children: <ChannelDetail id={showId} library="mixes" />,
      cache: [
        [['mixes', 'source', showId], data],
        [['mixes', 'fields'], mixBrowseFields],
      ],
    },
    data.items.items,
  )
  const list = request(requests, '/api/v1/subscriptions/browse-page')
  assert.equal(list.get('sourceId'), showId)
  assert.equal(list.get('library'), 'mixes')
  assert.match(html, /<div class="ds-kicker">Show<\/div>/)
  assert.doesNotMatch(html, /Subscribed/)
  assert.match(html, /<h3>Mixes<\/h3>/)
  assert.match(html, /placeholder="Search titles, shows, artists, tags..."/)
  assert.match(
    html,
    /<article class="ds-card" data-item-index="0"><span class="ds-art">/,
  )
  // The show is not a removable filter.
  assert.doesNotMatch(html, /Remove show filter/)
  const browse = destination(html, 'Show in Mixes')
  assert.equal(browse.pathname, '/mixes')
  assert.equal(browse.searchParams.get('sourceId'), showId)
  assert.equal(browse.searchParams.get('sortBy'), 'publishedAt')
  assert.equal(browse.searchParams.get('direction'), 'desc')
  assert.equal(browse.searchParams.get('view'), 'grid')
  assert.equal(
    destination(html, 'Example Morning Show 2026-04-02').pathname,
    `/mixes/${mixItem.id}`,
  )
  assert.equal(
    destination(html, 'Filter mixes').searchParams.get('sourceId'),
    showId,
  )
  assert.equal(destination(html, 'Filter mixes').pathname, '/mixes')
  assert.match(
    html,
    /<div class="ds-detail-links"><span class="service-links"[^>]*><a [^>]*aria-label="Open on The Lot Radio: [^"]+ \(opens in a new tab\)"/,
  )
})

test('an artist with mixes has a Mixes tab and a latest mixes list that open mix and show details', () => {
  const withMixes = ArtistDetailSchema.parse({ ...artist, mixCount: 1 })
  const path = `/api/v1/artists/${artist.id}`
  const overview = render({
    pathname: `/artists/${artist.id}`,
    children: <ArtistDetail id={artist.id} />,
    cache: [
      [['artist', artist.id], withMixes],
      [
        [
          'artist-overview',
          path,
          'mixes',
          'page=1&size=5&sortBy=publishedAt&direction=desc',
        ],
        page(mixItem),
      ],
    ],
  })
  const tabs = [...overview.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(tabs, [
    'Overview',
    'Albums',
    'Tracks',
    'Mixes',
    'Listening',
    'Coverage',
    'Sources',
  ])
  assert.match(overview, /aria-label="Latest mixes"/)
  assert.equal(
    destination(overview, 'Example Morning Show 2026-04-02').pathname,
    `/mixes/${mixItem.id}`,
  )
  assert.equal(
    destination(overview, 'Example Morning Show').pathname,
    `/mixes/shows/${showId}`,
  )
  const tab = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=mixes',
    children: <ArtistDetail id={artist.id} />,
    cache: [
      [['artist', artist.id], withMixes],
      [
        [
          'artist',
          artist.id,
          'mixes',
          'size=50&sortBy=publishedAt&direction=desc',
          1,
        ],
        page(mixItem),
      ],
    ],
  })
  assert.match(tab, /role="tab" aria-selected="true"[^>]*>Mixes/)
  assertNestedViewControls(tab)
  assert.match(tab, /<table class="ds-table" aria-label="mixes"/)
  assert.equal(
    destination(tab, 'Example Morning Show 2026-04-02').pathname,
    `/mixes/${mixItem.id}`,
  )
})

test('an artist without mixes has no Mixes tab or list', () => {
  const html = render({
    pathname: `/artists/${artist.id}`,
    search: 'tab=mixes',
    children: <ArtistDetail id={artist.id} />,
    cache: [[['artist', artist.id], artist]],
  })
  assert.doesNotMatch(html, />Mixes</)
  assert.doesNotMatch(html, /Latest mixes/)
  // An old Mixes link opens the Overview instead of an empty tab.
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Overview/)
})
