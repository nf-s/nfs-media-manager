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
import {
  MixSubscriptionItemSchema,
  SpotifySubscriptionItemSchema,
  SubscriptionSourceSchema,
  YoutubeSubscriptionItemSchema,
  mixBrowseFields,
  subscriptionBrowseFields,
} from '@repo/schemas/subscriptions'
import { ConfigContext } from './providers'
import {
  parseSubscriptionBrowseState,
  subscriptionBrowseQuery,
} from '@/utils/subscriptions'

// The components import a CSS module, which Node cannot load; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const WATCHED_AT = '2026-09-21T10:00:00.000Z'
const channelId = `UC${'c'.repeat(22)}`
const showId = 's'.repeat(22)

const video = YoutubeSubscriptionItemSchema.parse({
  type: 'youtube',
  id: 'abcdefghijk',
  sourceId: channelId,
  sourceTitle: 'Example Cooking',
  sourceThumbnailUrl: null,
  title: 'Bread basics',
  description: 'Flour and water.',
  tags: ['baking'],
  publishedAt: '2026-03-04T12:00:00.000Z',
  publishedPrecision: 'time',
  durationSec: 754,
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  viewCount: 1200,
  likeCount: null,
  commentCount: 4,
  live: 'none',
})

const episode = SpotifySubscriptionItemSchema.parse({
  type: 'spotify',
  id: 'e'.repeat(22),
  sourceId: showId,
  sourceTitle: 'Example Science Hour',
  sourceThumbnailUrl: null,
  title: 'Orbits',
  description: '',
  tags: [],
  publishedAt: '2024-03-01T00:00:00.000Z',
  publishedPrecision: 'year',
  durationSec: null,
  url: `https://open.spotify.com/episode/${'e'.repeat(22)}`,
  artworkUrl: null,
})

function render(
  children: ReactNode,
  data: Array<[unknown[], unknown]>,
  search = '',
  pathname = '/subscriptions',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  for (const [key, value] of data) client.setQueryData(key, value)
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

function browseData(search: string, total: number) {
  const { identity } = subscriptionBrowseQuery(
    parseSubscriptionBrowseState(new URLSearchParams(search)),
  )
  return [
    [['ai-status'], { available: true, reason: null }],
    [['subscriptions', 'fields'], subscriptionBrowseFields],
    [
      ['subscriptions', 'browse', identity, 1],
      {
        page: 1,
        size: 100,
        totalCount: total,
        pageCount: Math.ceil(total / 100),
        items: total ? [video, episode] : [],
      },
    ],
  ] satisfies Array<[unknown[], unknown]>
}

test('the table view uses the one table with a pinned title, right-aligned numbers and ISO dates', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=table&columns=title,source,type,publishedAt,durationSec'
  const html = render(<SubscriptionBrowser />, browseData(search, 250), search)
  assert.match(
    html,
    /class="ds-table-wrap table-scroll browse-scroll bi-scroll" data-view="table"/,
  )
  assert.match(
    html,
    /<table class="ds-table" data-layout="fixed" aria-label="Subscriptions"/,
  )
  assert.equal((html.match(/<table/g) ?? []).length, 1)
  assert.match(
    html,
    /<th scope="col" aria-sort="descending"><button type="button" class="ds-th-sort" title="Sort by Published">Published<svg/,
  )
  // Type is not a sort key, so its header is plain text.
  assert.match(html, /<th scope="col">Type<span class="ds-th-resizer"/)
  assert.match(html, /<th scope="col" data-align="end"><button[^>]*>Duration/)
  assert.doesNotMatch(html, /[↑↓]/)
  // Two loaded rows; the rest of the visible window waits for its page.
  assert.equal((html.match(/data-item-index=/g) ?? []).length, 2)
  assert.ok((html.match(/data-placeholder=""/g) ?? []).length > 10)
  assert.match(html, /250 items/)
  assert.match(html, /placeholder="Search titles, channels, podcasts, tags..."/)
  assert.match(html, /aria-label="Record search"/)
  assert.match(
    html,
    /<td data-sticky="edge" style="--ds-sticky-left:0px" title="Bread basics"><span class="ds-cell-id">/,
  )
  assert.match(html, /title="Filter Type: YouTube"/)
  assert.match(html, /title="Filter Type: Podcast"/)
  assert.match(
    html,
    new RegExp(`href="/channels/${showId}">Example Science Hour</a>`),
  )
  assert.match(html, /<td data-align="end" title="12:34">12:34<\/td>/)
  // A year-precision episode shows only the year.
  assert.match(html, /<td title="2024">2024<\/td>/)
  assert.match(html, /<td data-align="end" title="–">–<\/td>/)
  assert.match(html, /aria-label="Open details for Orbits"/)
  assert.doesNotMatch(html, /onDoubleClick|Open on Spotify|Open on YouTube/)
})

test('the default columns are Title, Channel, Published, Duration and Watched', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=table'
  const html = render(<SubscriptionBrowser />, browseData(search, 250), search)
  const heads = [...html.matchAll(/aria-label="Resize ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, [
    'Title',
    'Channel',
    'Published',
    'Duration',
    'Watched',
  ])
})

test('the Watched column shows the ISO date or the empty value and sorts', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=table&sortBy=watchedAt'
  const { identity } = subscriptionBrowseQuery(
    parseSubscriptionBrowseState(new URLSearchParams(search)),
  )
  const html = render(
    <SubscriptionBrowser />,
    [
      ...browseData(search, 2),
      [
        ['subscriptions', 'browse', identity, 1],
        {
          page: 1,
          size: 100,
          totalCount: 2,
          pageCount: 1,
          items: [{ ...video, watchedAt: WATCHED_AT }, episode],
        },
      ],
    ],
    search,
  )
  assert.match(
    html,
    /<th scope="col" aria-sort="descending"><button type="button" class="ds-th-sort" title="Sort by Watched">Watched<svg/,
  )
  assert.match(html, /<td title="2026-09-21">2026-09-21<\/td>/)
  assert.match(html, /<td title="–">–<\/td>/)
  // Yes/No is a filter, not a second Watched column.
  assert.equal((html.match(/aria-label="Resize Watched"/g) ?? []).length, 1)
})

test('the item header leads with a Watched toggle and shows the watched date', async () => {
  const { SubscriptionItemDetails } =
    await import('./subscription-item-details')
  const noNavigation = () => {
    throw new Error('Unexpected navigation')
  }
  const router = {
    back: noNavigation,
    forward: noNavigation,
    refresh: noNavigation,
    hmrRefresh: noNavigation,
    push: noNavigation,
    replace: noNavigation,
    prefetch: noNavigation,
  }
  const unwatched = render(
    <AppRouterContext.Provider value={router}>
      <SubscriptionItemDetails id={video.id} initialItem={video} />
    </AppRouterContext.Provider>,
    [],
    '',
    `/subscriptions/${video.id}`,
  )
  assert.match(
    unwatched,
    /<button[^>]*aria-pressed="false"[^>]*>Watched<\/button>/,
  )
  assert.doesNotMatch(unwatched, /Watched 20/)
  const watched = render(
    <AppRouterContext.Provider value={router}>
      <SubscriptionItemDetails
        id={episode.id}
        initialItem={{ ...episode, watchedAt: WATCHED_AT }}
      />
    </AppRouterContext.Provider>,
    [],
    '',
    `/subscriptions/${episode.id}`,
  )
  assert.match(
    watched,
    /<button[^>]*aria-pressed="true"[^>]*><svg[^>]*class="lucide lucide-check[^"]*ds-i"[^>]*>.*?<\/svg>Watched<\/button>/,
  )
  assert.match(watched, /Watched 2026-09-21/)
  // Watched leads the actions and More stays last.
  const actions = watched.slice(
    watched.indexOf('aria-pressed="true"'),
    watched.indexOf('role="tablist"'),
  )
  const open = actions.indexOf('aria-label="Open at Spotify')
  const more = actions.indexOf('aria-label="More actions"')
  assert.ok(open > 0 && more > open)
  assert.doesNotMatch(actions.slice(more), /aria-pressed|Open at/)
})

test('the table follows the chosen column order and a filtered count reads N of M', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search =
    'view=table&q=bread&columns=title,source,durationSec&columnOrder=durationSec,source'
  const { params } = subscriptionBrowseQuery(
    parseSubscriptionBrowseState(new URLSearchParams(search)),
  )
  const countParams = new URLSearchParams(params)
  for (const key of ['sortBy', 'direction']) countParams.delete(key)
  countParams.sort()
  const html = render(
    <SubscriptionBrowser />,
    [
      ...browseData(search, 2),
      [
        ['subscriptions', 'browse-count', countParams.toString()],
        { totalCount: 2, unfilteredCount: 64 },
      ],
    ],
    search,
  )
  const heads = [...html.matchAll(/aria-label="Resize ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, ['Title', 'Duration', 'Channel'])
  assert.match(html, /role="status">2 of 64 items<\/span>/)
})

test('the list view shows 48px rows with video thumbnails and all three view controls', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=list'
  const html = render(<SubscriptionBrowser />, browseData(search, 250), search)
  assert.match(html, /data-view="list"/)
  assert.doesNotMatch(html, /<table/)
  assert.equal(
    (html.match(/<div class="ds-row" data-item-index/g) ?? []).length,
    2,
  )
  for (const view of ['Grid', 'Table'])
    assert.match(
      html,
      new RegExp(`aria-pressed="false" aria-label="${view} view"`),
    )
  assert.match(html, /aria-pressed="true" aria-label="List view"/)
  assert.match(html, /<span class="ds-thumb" data-ratio="video">/)
  assert.match(
    html,
    /<a class="ds-row-title" title="Bread basics" href="\/subscriptions\/abcdefghijk">Bread basics<\/a>/,
  )
  assert.match(
    html,
    new RegExp(`href="/channels/${channelId}">Example Cooking</a>`),
  )
  assert.match(
    html,
    /<span class="ds-w-date">2026-03-0[45]<\/span><span class="ds-w-num">12:34<\/span><span class="ds-w-num">1,200<\/span>/,
  )
  assert.match(html, /data-fit="contain" aria-label="Open details for Orbits"/)
})

test('the grid view shows clean video cards with a duration badge, meta line and tags', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const html = render(<SubscriptionBrowser />, browseData('', 120))
  assert.match(html, /data-view="grid"/)
  assert.doesNotMatch(html, /<table/)
  // Grid size is in the Filters drawer, not on the toolbar.
  assert.doesNotMatch(html, /aria-label="Grid size"/)
  assert.match(html, /<span class="ds-art" data-ratio="video">/)
  assert.match(html, /<span class="ds-art-badge">12:34<\/span>/)
  assert.equal((html.match(/ds-art-badge/g) ?? []).length, 1)
  assert.match(
    html,
    new RegExp(`href="/channels/${channelId}">Example Cooking</a>`),
  )
  assert.match(html, /<span>1.2K views<\/span>/)
  assert.match(html, /<span>2024<\/span><span>Podcast<\/span>/)
  assert.match(html, /title="Tag: baking"/)
  assert.ok((html.match(/data-placeholder=""/g) ?? []).length > 0)
  assert.doesNotMatch(html, /ds-play/)
})

test('an empty library points to Imports and a search without results offers to clear it', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const empty = render(<SubscriptionBrowser />, browseData('', 0))
  assert.match(empty, /<strong>No subscriptions yet<\/strong>/)
  assert.match(empty, /href="\/imports\/youtube\?mediaType=subscription"/)
  const noMatches = render(
    <SubscriptionBrowser />,
    browseData('q=nothing', 0),
    'q=nothing',
  )
  assert.match(noMatches, /No subscriptions match/)
  assert.match(noMatches, /Search: nothing/)
  assert.doesNotMatch(noMatches, /No subscriptions yet/)
})

test('subscription Sources uses the stored provider ID and destination', async () => {
  const { SubscriptionItemDetails } =
    await import('./subscription-item-details')
  const noNavigation = () => {
    throw new Error('Unexpected navigation')
  }
  const router = {
    back: noNavigation,
    forward: noNavigation,
    refresh: noNavigation,
    hmrRefresh: noNavigation,
    push: noNavigation,
    replace: noNavigation,
    prefetch: noNavigation,
  }
  for (const item of [video, episode]) {
    const html = render(
      <AppRouterContext.Provider value={router}>
        <SubscriptionItemDetails id={item.id} initialItem={item} />
      </AppRouterContext.Provider>,
      [],
      'tab=sources',
      `/subscriptions/${item.id}`,
    )
    assert.match(html, /role="tab" aria-selected="true"[^>]*>Sources/)
    const table = html.slice(html.indexOf('aria-label="Sources"'))
    assert.ok(html.includes('aria-label="Sources"'))
    assert.ok(table.includes(item.id))
    assert.ok(table.includes(item.url))
    assert.doesNotMatch(table, /Refresh/)
  }
})

test('the channels list links names to details and counts to filtered Browse', async () => {
  const { default: SubscriptionChannels } =
    await import('./subscription-channels')
  const sources = {
    items: [
      SubscriptionSourceSchema.parse({
        type: 'youtube',
        id: channelId,
        title: 'Example Cooking',
        description: null,
        thumbnailUrl: null,
        url: `https://www.youtube.com/channel/${channelId}`,
        storedItems: 40,
        latestItemAt: '2026-03-04T12:00:00.000Z',
        historyComplete: true,
        handle: '@examplecooking',
        subscriberCount: 12000,
      }),
      SubscriptionSourceSchema.parse({
        type: 'spotify',
        id: showId,
        title: 'Example Science Hour',
        description: null,
        thumbnailUrl: null,
        url: `https://open.spotify.com/show/${showId}`,
        storedItems: 12,
        latestItemAt: null,
        historyComplete: false,
        itemTotal: 240,
      }),
    ],
  }
  const html = render(
    <SubscriptionChannels />,
    [[['subscriptions', 'sources'], sources]],
    '',
    '/subscriptions/channels',
  )
  assert.match(html, /<h1>Channels<\/h1>/)
  assert.match(html, /<table class="ds-table"/)
  assert.match(
    html,
    /aria-sort="ascending"><div class="secondary-table-heading"><button[^>]*title="Sort by Name">Name<svg/,
  )
  assert.match(
    html,
    /<td data-sticky="edge" style="--ds-sticky-left:0px"><span class="ds-cell-id">/,
  )
  assert.match(html, /<td>YouTube<\/td>/)
  assert.match(html, /<td>Podcast<\/td>/)
  assert.match(html, /2 channels/)
  assert.match(html, /<td data-align="end">12,000 subscribers<\/td>/)
  assert.match(html, /240 episodes/)
  assert.match(html, /2026-03-0[45]/)
  assert.match(html, /History for Example Science Hour/)
  assert.doesNotMatch(html, /Loading channels/)
  assert.ok(html.includes(`href="/channels/${channelId}"`))
  assert.ok(html.includes(`href="/channels/${showId}"`))
  assert.ok(html.includes(`href="/subscriptions?sourceId=${channelId}"`))
  assert.ok(html.includes(`href="/subscriptions?sourceId=${showId}"`))
})

test('source-scoped Browse shows a removable exact channel filter even with no matching items', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = new URLSearchParams({ sourceId: channelId }).toString()
  const source = SubscriptionSourceSchema.parse({
    type: 'youtube',
    id: channelId,
    title: 'Example Cooking',
    description: null,
    thumbnailUrl: null,
    url: `https://www.youtube.com/channel/${channelId}`,
    storedItems: 0,
    latestItemAt: null,
    historyComplete: true,
    handle: null,
    subscriberCount: null,
  })
  const html = render(
    <SubscriptionBrowser />,
    [
      ...browseData(search, 0),
      [['subscriptions', 'source', channelId], { source }],
    ],
    search,
  )
  assert.match(html, /Channel: Example Cooking/)
  assert.match(html, /aria-label="Remove channel filter"/)
  assert.match(html, /data-mode="required"/)
  assert.match(html, /No subscriptions match/)
  assert.doesNotMatch(html, /No subscriptions yet/)
})

const mixShowId = 'rinse.example-breakfast'
const mix = MixSubscriptionItemSchema.parse({
  type: 'rinse',
  id: 'rinse.example-breakfast-2026-06-01',
  sourceId: mixShowId,
  sourceTitle: 'Example Breakfast',
  sourceThumbnailUrl: null,
  title: 'Example Breakfast with Guest Selector',
  description: 'First Track - Guest Selector\nSecond Track - Library Artist',
  tags: ['garage'],
  publishedAt: '2026-06-01T00:00:00.000Z',
  publishedPrecision: 'day',
  durationSec: 3600,
  url: 'https://www.rinse.fm/episodes/example-breakfast-2026-06-01',
  artworkUrl: 'https://images.example.test/mix.jpg',
  artists: ['Guest Selector', 'Library Artist'],
  audioUrl: 'https://audio.example.test/mix.mp3',
})

function mixBrowseData(search: string, total: number) {
  const { identity } = subscriptionBrowseQuery(
    parseSubscriptionBrowseState(new URLSearchParams(search), 'mixes'),
    'mixes',
  )
  return [
    [['ai-status'], { available: true, reason: null }],
    [['mixes', 'fields'], mixBrowseFields],
    [
      ['mixes', 'browse', identity, 1],
      {
        page: 1,
        size: 100,
        totalCount: total,
        pageCount: Math.ceil(total / 100),
        items: total ? [mix] : [],
      },
    ],
  ] satisfies Array<[unknown[], unknown]>
}

test('Mixes uses its own cache and its table defaults to Title, Show, Station, Artist, Broadcast, Duration and Listened', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=table'
  // A Subscriptions cache entry under the same identity must not appear in Mixes.
  const html = render(
    <SubscriptionBrowser library="mixes" />,
    [...browseData(search, 2), ...mixBrowseData(search, 120)],
    search,
    '/mixes',
  )
  assert.match(
    html,
    /<table class="ds-table" data-layout="fixed" aria-label="Mixes"/,
  )
  const heads = [...html.matchAll(/aria-label="Resize ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, [
    'Title',
    'Show',
    'Station',
    'Artist',
    'Broadcast',
    'Duration',
    'Listened',
  ])
  assert.equal((html.match(/data-item-index=/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Bread basics|Views|Likes|Comments/)
  assert.match(html, /120 mixes/)
  assert.match(html, /placeholder="Search titles, shows, artists, tags..."/)
  assert.match(html, /title="Sort by Broadcast">Broadcast/)
  assert.match(
    html,
    new RegExp(`href="/mixes/shows/${mixShowId}">Example Breakfast</a>`),
  )
  assert.match(html, /title="Filter Station: Rinse FM"/)
  assert.match(html, /title="Filter Artist: Guest Selector"/)
  assert.match(html, /<td title="2026-06-01">2026-06-01<\/td>/)
  assert.match(html, /<td data-align="end" title="1:00:00">1:00:00<\/td>/)
  assert.match(html, /aria-label="Open details for Example Breakfast/)
})

test('Mixes grid cards are square with the broadcast date and station and no length badge', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const html = render(
    <SubscriptionBrowser library="mixes" />,
    mixBrowseData('', 120),
    '',
    '/mixes',
  )
  assert.match(html, /data-view="grid"/)
  assert.match(html, /<span class="ds-art">/)
  assert.doesNotMatch(html, /data-ratio="video"|ds-art-badge/)
  assert.match(html, /<span>2026-06-01<\/span><span>Rinse FM<\/span>/)
  assert.match(html, /title="Tag: garage"/)
  assert.match(
    html,
    new RegExp(`href="/mixes/shows/${mixShowId}">Example Breakfast</a>`),
  )
})

test('Mixes list rows show square artwork, the show, Broadcast and Duration', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=list'
  const html = render(
    <SubscriptionBrowser library="mixes" />,
    mixBrowseData(search, 120),
    search,
    '/mixes',
  )
  assert.match(
    html,
    /<span class="ds-w-date">2026-06-01<\/span><span class="ds-w-num">1:00:00<\/span><\/div>/,
  )
  assert.match(html, />Broadcast</)
  assert.doesNotMatch(html, />Views</)
  assert.match(
    html,
    /<a class="ds-row-title" title="Example Breakfast with Guest Selector" href="\/mixes\/rinse\.example-breakfast-2026-06-01">/,
  )
})

test('an empty Mixes library points to the station imports', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const empty = render(
    <SubscriptionBrowser library="mixes" />,
    mixBrowseData('', 0),
    '',
    '/mixes',
  )
  assert.match(empty, /<strong>No mixes yet<\/strong>/)
  assert.match(empty, /href="\/imports\/rinse\?mediaType=mix">Open Imports/)
  const noMatches = render(
    <SubscriptionBrowser library="mixes" />,
    mixBrowseData('q=nothing', 0),
    'q=nothing',
    '/mixes',
  )
  assert.match(noMatches, /No mixes match/)
})

test('show-scoped Mixes shows a removable exact show filter', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = new URLSearchParams({ sourceId: mixShowId }).toString()
  const source = SubscriptionSourceSchema.parse({
    type: 'rinse',
    id: mixShowId,
    title: 'Example Breakfast',
    description: null,
    thumbnailUrl: null,
    url: 'https://www.rinse.fm/shows/example-breakfast',
    storedItems: 1,
    latestItemAt: null,
    historyComplete: true,
    itemTotal: null,
  })
  const html = render(
    <SubscriptionBrowser library="mixes" />,
    [...mixBrowseData(search, 1), [['mixes', 'source', mixShowId], { source }]],
    search,
    '/mixes',
  )
  assert.match(html, /Show: Example Breakfast/)
  assert.match(html, /aria-label="Remove show filter"/)
})

test('mix details lead with Listened and link to library artists, the show, the station and the recording', async () => {
  const { SubscriptionItemDetails } =
    await import('./subscription-item-details')
  const noNavigation = () => {
    throw new Error('Unexpected navigation')
  }
  const router = {
    back: noNavigation,
    forward: noNavigation,
    refresh: noNavigation,
    hmrRefresh: noNavigation,
    push: noNavigation,
    replace: noNavigation,
    prefetch: noNavigation,
  }
  const read = {
    ...mix,
    watchedAt: WATCHED_AT,
    libraryArtists: [{ id: 'artist-1', name: 'library artist' }],
  }
  const html = render(
    <AppRouterContext.Provider value={router}>
      <SubscriptionItemDetails id={mix.id} library="mixes" />
    </AppRouterContext.Provider>,
    [[['mixes', 'item', mix.id], read]],
    '',
    `/mixes/${mix.id}`,
  )
  assert.match(html, /<div class="ds-kicker">Mix<\/div>/)
  assert.match(
    html,
    /<button[^>]*aria-pressed="true"[^>]*><svg[^>]*>.*?<\/svg>Listened<\/button>/,
  )
  assert.match(html, /Listened 2026-09-21/)
  assert.doesNotMatch(html, /Watched/)
  assert.match(
    html,
    new RegExp(`href="/mixes/shows/${mixShowId}">Example Breakfast</a>`),
  )
  // A billed name with a library artist opens it; any other name filters Mixes.
  assert.match(
    html,
    /title="Open library artist" class="ds-pill" data-size="md" href="\/artists\/artist-1"><span class="ds-pill-label">Library Artist<\/span>/,
  )
  assert.match(html, /title="Filter Artist: Guest Selector"/)
  assert.match(html, /title="Filter Tags: garage"/)
  assert.match(
    html,
    /First Track - Guest Selector\nSecond Track - Library Artist/,
  )
  assert.match(
    html,
    /href="https:\/\/www\.rinse\.fm\/episodes\/example-breakfast-2026-06-01"[^>]*aria-label="Open on Rinse FM \(opens in a new tab\)"/,
  )
  assert.match(
    html,
    /href="https:\/\/audio\.example\.test\/mix\.mp3"[^>]*aria-label="Open recording \(opens in a new tab\)"/,
  )
  assert.doesNotMatch(html, /ds-play|<audio/)
  const withoutRecording = render(
    <AppRouterContext.Provider value={router}>
      <SubscriptionItemDetails id={mix.id} library="mixes" />
    </AppRouterContext.Provider>,
    [[['mixes', 'item', mix.id], { ...mix, audioUrl: null }]],
    '',
    `/mixes/${mix.id}`,
  )
  assert.doesNotMatch(withoutRecording, /Open recording/)
  assert.match(withoutRecording, /aria-pressed="false"[^>]*>Listened</)
})

test('the shows list is the channels table for Mixes with stations and stored mixes', async () => {
  const { default: SubscriptionChannels } =
    await import('./subscription-channels')
  const sources = {
    items: [
      SubscriptionSourceSchema.parse({
        type: 'rinse',
        id: mixShowId,
        title: 'Example Breakfast',
        description: null,
        thumbnailUrl: null,
        url: 'https://www.rinse.fm/shows/example-breakfast',
        storedItems: 12,
        latestItemAt: '2026-06-01T00:00:00.000Z',
        historyComplete: false,
        itemTotal: null,
      }),
    ],
  }
  const html = render(
    <SubscriptionChannels library="mixes" />,
    [[['mixes', 'sources'], sources]],
    'q=breakfast',
    '/mixes/shows',
  )
  assert.match(html, /<h1>Shows<\/h1>/)
  assert.match(
    html,
    /<table class="ds-table" aria-label="Shows" data-layout="fixed"/,
  )
  const heads = [...html.matchAll(/title="Sort by ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, ['Show', 'Station', 'Stored mixes', 'Latest mix'])
  assert.match(html, /<td>Rinse FM<\/td>/)
  assert.match(html, /1 show/)
  assert.match(html, /History for Example Breakfast/)
  assert.ok(html.includes(`href="/mixes/shows/${mixShowId}"`))
  assert.ok(html.includes(`href="/mixes?sourceId=${mixShowId}"`))
  assert.match(html, /aria-label="Filter mixes by Example Breakfast"/)
  assert.doesNotMatch(html, /YouTube|Podcast/)
})

/**
 * The browser inside a channel or show detail, held to `sourceId`, with the
 * detail URL's `search`. The cache answers only requests that carry the source.
 */
async function renderEmbedded({
  library = 'subscriptions',
  sourceId = channelId,
  search = '',
  total = 2,
  inspect,
}: {
  library?: 'subscriptions' | 'mixes'
  sourceId?: string
  search?: string
  total?: number
  /** Opens a page drawer on this item around the detail. */
  inspect?: string
} = {}) {
  const { EmbeddedSubscriptionBrowser } = await import('./subscription-browser')
  const { DetailInspectorProvider } = await import('./detail-inspector-context')
  const settings = new URLSearchParams(search)
  if (!settings.has('sortBy')) {
    settings.set('sortBy', 'publishedAt')
    settings.set('direction', 'desc')
  }
  const { identity, params } = subscriptionBrowseQuery(
    { ...parseSubscriptionBrowseState(settings, library), sourceId },
    library,
  )
  assert.equal(params.get('sourceId'), sourceId)
  const countParams = new URLSearchParams(params)
  for (const key of ['sortBy', 'direction']) countParams.delete(key)
  countParams.sort()
  const items = library === 'mixes' ? [mix] : [video, episode]
  const detailSearch = new URLSearchParams(search)
  if (inspect)
    detailSearch.set(
      'inspect',
      JSON.stringify([{ kind: 'subscription', id: inspect }]),
    )
  return render(
    <DetailInspectorProvider>
      <EmbeddedSubscriptionBrowser
        library={library}
        sourceId={sourceId}
        storage={library === 'mixes' ? 'show-mixes' : 'channel-items'}
        sort={{ key: 'publishedAt', direction: 'desc' }}
      />
    </DetailInspectorProvider>,
    [
      [['ai-status'], { available: true, reason: null }],
      [
        [library, 'fields'],
        library === 'mixes' ? mixBrowseFields : subscriptionBrowseFields,
      ],
      [
        [library, 'browse-count', countParams.toString()],
        { totalCount: total, unfilteredCount: 128 },
      ],
      [
        [library, 'browse', identity, 1],
        {
          page: 1,
          size: 100,
          totalCount: total,
          pageCount: Math.ceil(total / 100),
          items: total ? items : [],
        },
      ],
    ],
    detailSearch.toString(),
    library === 'mixes' ? `/mixes/shows/${sourceId}` : `/channels/${sourceId}`,
  )
}

test('Subscriptions inside a detail keep every Browse control and none of the page', async () => {
  const html = await renderEmbedded()
  assert.match(html, /placeholder="Search titles, channels, podcasts, tags..."/)
  assert.match(html, /aria-label="Sort by"/)
  assert.match(html, /aria-label="Browse views"/)
  // The rows come from the source-scoped page and count requests.
  assert.match(html, />Bread basics</)
  assert.match(html, /role="status">2 items<\/span>/)
  assert.doesNotMatch(html, /2 of 128/)
  // No page frame for the app shell to size, and the list scrolls in a box.
  assert.doesNotMatch(html, /class="media-browser"|class="browse-main"/)
  assert.match(
    html,
    /class="[^"]*browse-scroll bi-scroll max-h-\[min\(420px,50dvh\)\][^"]*"[^>]*data-inspector-scroll=""/,
  )
  // The list starts as a table, newest first, as the old channel list did.
  assert.match(html, /data-view="table"/)
  assert.match(
    html,
    new RegExp(
      `<a class="ds-btn" data-variant="link" href="/subscriptions\\?sourceId=${channelId}&amp;sortBy=publishedAt&amp;direction=desc&amp;view=table&amp;density=standard">Show in Subscriptions</a>`,
    ),
  )
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const page = render(<SubscriptionBrowser />, browseData('', 2), '')
  assert.match(page, /class="media-browser"/)
  assert.doesNotMatch(page, /data-inspector-scroll|Show in Subscriptions/)
})

test('Subscriptions inside a detail are held to their source, which is not a filter', async () => {
  const html = await renderEmbedded()
  assert.doesNotMatch(html, /Remove channel filter|Channel: |Clear all/)

  const searched = await renderEmbedded({ search: 'q=bread' })
  // The search is a pill on the line under the toolbar, before the count and the link.
  assert.match(
    searched,
    /<div class="ds-filterline">.*?Search: bread.*?>Clear all<\/button><span class="ds-toolbar-count" role="status">[^<]*<\/span><a [^>]*>Show in Subscriptions<\/a><\/div>/,
  )
  assert.doesNotMatch(searched, /Remove channel filter/)

  // An empty source is empty, not a filter without matches.
  const empty = await renderEmbedded({ total: 0 })
  assert.match(empty, /No subscriptions yet/)
  assert.doesNotMatch(empty, /No subscriptions match/)
})

test('Show in Subscriptions and Show in Mixes carry the source and the list settings', async () => {
  const changed = await renderEmbedded({
    search: 'q=bread&sortBy=likeCount&direction=asc&view=grid&density=compact',
  })
  assert.match(
    changed,
    new RegExp(
      `href="/subscriptions\\?sourceId=${channelId}&amp;q=bread&amp;sortBy=likeCount&amp;direction=asc&amp;view=grid&amp;density=compact">Show in Subscriptions<`,
    ),
  )

  const mixes = await renderEmbedded({
    library: 'mixes',
    sourceId: mixShowId,
    search: 'sortBy=durationSec&direction=asc&view=grid&density=standard',
  })
  assert.match(
    mixes,
    new RegExp(
      `href="/mixes\\?sourceId=${mixShowId}&amp;sortBy=durationSec&amp;direction=asc&amp;view=grid&amp;density=standard">Show in Mixes<`,
    ),
  )
  assert.match(mixes, /placeholder="Search titles, shows, artists, tags..."/)
  assert.doesNotMatch(mixes, /Remove show filter|Show: /)
  // The grid shows the value the list is sorted by.
  assert.match(mixes, /data-view="grid"/)
  assert.match(mixes, /<span>Duration [^<]+<\/span>/)
})

test('a list inside a detail leaves the page drawer and its selected row to the page', async () => {
  const embedded = await renderEmbedded({ inspect: video.id })
  assert.match(embedded, />Bread basics</)
  assert.doesNotMatch(
    embedded,
    /<tr[^>]*aria-selected="true"|inspector-backdrop/,
  )

  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const { DetailInspectorProvider } = await import('./detail-inspector-context')
  const search = `view=table&inspect=${encodeURIComponent(
    JSON.stringify([{ kind: 'subscription', id: video.id }]),
  )}`
  const noNavigation = () => {
    throw new Error('Unexpected navigation')
  }
  const router = {
    back: noNavigation,
    forward: noNavigation,
    refresh: noNavigation,
    hmrRefresh: noNavigation,
    push: noNavigation,
    replace: noNavigation,
    prefetch: noNavigation,
  }
  const page = render(
    <AppRouterContext.Provider value={router}>
      <DetailInspectorProvider>
        <SubscriptionBrowser />
      </DetailInspectorProvider>
    </AppRouterContext.Provider>,
    browseData(search, 2),
    search,
  )
  assert.match(page, /aria-selected="true"/)
  assert.match(page, /inspector-backdrop/)
})
