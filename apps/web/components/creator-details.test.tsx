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
import { ArtistIdentifierSourceRow } from './artist-identifier-sources'
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
        `aria-label="${label} view" aria-pressed="${label === active}"`,
      ),
    )
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

test('copied artist album Grid preserves the parent detail and playback controls', () => {
  const entry: DetailEntry = {
    kind: 'artist',
    id: artist.id,
    view: 'tab=albums&view=grid',
  }
  const html = render({
    pathname: '/artists',
    search: new URLSearchParams({
      inspect: JSON.stringify([entry]),
    }).toString(),
    cache: [
      [['artist', artist.id], artist],
      [
        [
          'artist',
          artist.id,
          'albums',
          'size=50&sortBy=title&direction=asc',
          1,
        ],
        page(album),
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
  assertNestedViewControls(html, 'Grid')
  assert.match(html, /data-view="grid" data-media-type="album"/)
  const target = destination(html, 'Synthetic album')
  assert.deepEqual(detailEntries(target.pathname, target.searchParams), [
    entry,
    { kind: 'album', id: album.id },
  ])
})

test('artist tracks and playlists offer layout controls on their own result pages', () => {
  for (const { tab, sortBy } of [
    { tab: 'tracks', sortBy: 'title' },
    { tab: 'playlists', sortBy: 'name' },
  ]) {
    const html = render({
      pathname: `/artists/${artist.id}`,
      search: `tab=${tab}`,
      children: <ArtistDetail id={artist.id} />,
      cache: [
        [['artist', artist.id], artist],
        [
          [
            'artist',
            artist.id,
            tab,
            `size=50&sortBy=${sortBy}&direction=asc`,
            1,
          ],
          page(),
        ],
      ],
    })
    assertNestedViewControls(html)
    assert.ok(html.includes(`No ${tab} stored.`))
  }
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
        ['history', artist.id, 'artist', 'spotify', 'snapshots', 1],
        { ...page(oldSnapshot), size: 20, pageCount: 2, totalCount: 21 },
      ],
    ],
  })
  assert.match(html, /aria-label="Spotify history" aria-expanded="true"/)
  assert.match(html, /View snapshot/)
  assert.match(html, /aria-rowcount="22"/)
  assert.match(html, /virtual-browse-placeholder/)
  assert.doesNotMatch(html, /Load more snapshots/)
  assert.doesNotMatch(html, /Stored response/)
  assert.equal(destination(html, 'View job').pathname, '/jobs/artist-job')
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
  assert.match(html, new RegExp(`>${spotifyArtistId}</div>`))
  assert.match(html, /aria-label="Sources for Spotify identifier"/)
  assert.match(html, /aria-label="Sources for Discogs identifier"/)
  assert.match(html, /Conflicting IDs/)
  assert.match(html, /lucide-eye/)
  assert.match(
    html,
    new RegExp(`href="https://open.spotify.com/artist/${spotifyArtistId}"`),
  )
  assert.doesNotMatch(html, /From stored sources|No stored identifier sources/)
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
          1,
        ],
        page(film),
      ],
    ],
  })
  assert.equal(destination(html, film.title).pathname, `/films/${film.id}`)
  assert.match(html, /Director, Actor/)
  assertNestedViewControls(html)
  for (const role of person.roles) {
    const target = destination(html, `Filter films as ${role}`)
    assert.equal(target.pathname, '/films')
    assert.equal(target.searchParams.get('creatorId'), person.id)
    assert.equal(target.searchParams.get('creatorRole'), role)
  }
})

test('copied person film List keeps the stored paging and role filter', () => {
  const html = render({
    pathname: `/people/${person.id}`,
    search: 'view=list&role=director&sortBy=runtimeMinutes&direction=desc',
    children: <PersonDetail id={person.id} />,
    cache: [
      [['person', person.id], person],
      [
        [
          'person',
          person.id,
          'films',
          'size=50&sortBy=runtimeMinutes&direction=desc&role=director',
          1,
        ],
        page(film),
      ],
    ],
  })
  assertNestedViewControls(html, 'List')
  assert.match(html, /data-view="list" data-media-type="film"/)
  assert.match(html, /aria-label="Sort by"/)
  assert.match(html, / Filters<span class="filter-panel-count">1<\/span>/)
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
    search: 'view=grid',
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
          1,
        ],
        data.items,
      ],
    ],
  })
  assert.match(html, /Synthetic description\./)
  assert.match(html, /Reading history/)
  assertNestedViewControls(html, 'Grid')
  assert.match(html, /data-view="grid" data-media-type="subscription"/)
  assert.match(html, /class="nested-media-line">2026<\/div>/)
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
