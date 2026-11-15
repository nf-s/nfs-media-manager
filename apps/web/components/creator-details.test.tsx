import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ArtistDetailSchema, PersonDetailSchema } from '@repo/schemas/creators'
import { AlbumListItemSchema, FilmListItemSchema } from '@repo/schemas/media'
import { SubscriptionSourceDetailSchema } from '@repo/schemas/subscriptions'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import {
  DetailInspectorProvider,
  InspectorEntryContext,
} from './detail-inspector-context'
import { ArtistDetail } from './artist-detail'
import { PersonDetail } from './person-detail'
import { ConfigContext } from './providers'
import { detailEntries, type DetailEntry } from '@/utils/detail-inspector'

// Node cannot load the subscription CSS module. The rendered class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in creator detail UI tests')
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

function render({
  pathname,
  search = '',
  children,
  cache,
}: {
  pathname: string
  search?: string
  children: ReactNode
  cache: [unknown[], unknown][]
}) {
  const client = new QueryClient()
  for (const [key, data] of cache) client.setQueryData(key, data)
  try {
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
  assert.match(html, /<dt>Tracks<\/dt><dd>2<\/dd>/)
  assert.ok(html.includes(spotifyProfile.profile.url))
  assert.doesNotMatch(html, /Refresh profile/)
  for (const [label, path] of Object.entries({
    'Filter albums': '/albums',
    'Filter tracks': '/tracks',
  })) {
    const target = destination(html, label)
    assert.equal(target.pathname, path)
    assert.equal(target.searchParams.get('creatorId'), artist.id)
    assert.equal(target.searchParams.has('filters'), false)
  }
  const tags = destination(html, 'Synth-pop')
  assert.deepEqual(JSON.parse(tags.searchParams.get('filters') ?? '[]'), [
    { field: 'artistTag', value: 'Synth-pop', mode: 'required' },
  ])
})

test('artist album rows append to the detail stack and show playback', () => {
  const entry: DetailEntry = {
    kind: 'artist',
    id: artist.id,
    view: 'tab=albums',
  }
  const html = render({
    pathname: '/artists',
    search: new URLSearchParams({
      inspect: JSON.stringify([entry]),
    }).toString(),
    cache: [
      [['artist', artist.id], artist],
      [
        ['artist', artist.id, 'albums', 'size=50&sortBy=title&direction=asc'],
        { pages: [page(album)], pageParams: [1] },
      ],
    ],
    children: (
      <DetailInspectorProvider>
        <InspectorEntryContext.Provider
          value={{ active: entry, replaceView: () => {} }}
        >
          <ArtistDetail id={artist.id} />
        </InspectorEntryContext.Provider>
      </DetailInspectorProvider>
    ),
  })
  assert.match(html, /aria-label="Play Synthetic album[^"]*"/)
  const target = destination(html, 'Synthetic album')
  assert.deepEqual(detailEntries(target.pathname, target.searchParams), [
    entry,
    { kind: 'album', id: album.id },
  ])
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
        ['history', artist.id, 'artist', 'spotify', 'snapshots'],
        {
          pages: [{ ...page(oldSnapshot), pageCount: 2, totalCount: 21 }],
          pageParams: [1],
        },
      ],
    ],
  })
  assert.match(html, /aria-label="Spotify history" aria-expanded="true"/)
  assert.match(html, /View snapshot/)
  assert.match(html, /Load more snapshots/)
  assert.doesNotMatch(html, /Stored response/)
  assert.equal(
    destination(html, 'View job').searchParams.get('jobId'),
    'artist-job',
  )
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
  assert.match(html, /aria-label="Select Spotify"/)
  assert.match(html, /aria-label="Edit Spotify identifier"/)
  assert.match(html, /Refresh all eligible/)
  assert.match(html, /aria-label="Sources"/)
})

test('person details open films and pass the selected credit role to Browse', () => {
  const html = render({
    pathname: `/people/${person.id}`,
    search: 'role=director',
    children: <PersonDetail id={person.id} />,
    cache: [
      [['person', person.id], person],
      [
        [
          'person',
          person.id,
          'films',
          'size=50&sortBy=title&direction=asc&role=director',
        ],
        { pages: [page(film)], pageParams: [1] },
      ],
    ],
  })
  assert.equal(destination(html, film.title).pathname, `/films/${film.id}`)
  assert.match(html, /Director, Actor/)
  for (const role of person.roles) {
    const target = destination(html, `Filter films as ${role}`)
    assert.equal(target.pathname, '/films')
    assert.equal(target.searchParams.get('creatorId'), person.id)
    assert.equal(target.searchParams.get('creatorRole'), role)
  }
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
  assert.doesNotMatch(html, /Refresh (all eligible|selected)/)
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
  assert.match(
    html,
    /aria-label="Remove director filter">Director: Synthetic person/,
  )
  assert.match(html, /Clear all/)
  assert.match(html, /No matches/)
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
  const html = render({
    pathname: `/channels/${id}`,
    children: <ChannelDetail id={id} />,
    cache: [
      [['subscriptions', 'source', id], data],
      [
        [
          'subscriptions',
          'source',
          id,
          'items',
          'size=50&sortBy=publishedAt&direction=desc',
        ],
        { pages: [data.items], pageParams: [1] },
      ],
    ],
  })
  assert.match(html, /Synthetic description\./)
  assert.match(html, /Reading history/)
  assert.match(html, /<time dateTime="2026-01-01T00:00:00.000Z">2026<\/time>/)
  assert.equal(
    destination(html, 'Synthetic episode').pathname,
    `/subscriptions/${episodeId}`,
  )
  assert.equal(
    destination(html, 'Filter subscriptions').searchParams.get('sourceId'),
    id,
  )
  const sources = render({
    pathname: `/channels/${id}`,
    search: 'tab=sources',
    children: <ChannelDetail id={id} />,
    cache: [[['subscriptions', 'source', id], data]],
  })
  const table = sources.slice(sources.indexOf('<table'))
  assert.match(table, /aria-label="Sources"/)
  assert.match(table, /title="Sort by Provider"/)
  assert.match(table, /title="Sort by Identifier"/)
  assert.ok(table.includes(data.source.url))
  assert.ok(table.includes(id))
  assert.doesNotMatch(table, /Refresh (all eligible|selected)/)
})
