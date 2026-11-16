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
  SpotifySubscriptionItemSchema,
  SubscriptionSourceSchema,
  YoutubeSubscriptionItemSchema,
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
  assert.match(html, /<th scope="col">Type<span class="bi-resizer"/)
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

test('the default columns are Title, Channel, Published and Duration', async () => {
  const { default: SubscriptionBrowser } =
    await import('./subscription-browser')
  const search = 'view=table'
  const html = render(<SubscriptionBrowser />, browseData(search, 250), search)
  const heads = [...html.matchAll(/aria-label="Resize ([^"]+)"/g)].map(
    ([, label]) => label,
  )
  assert.deepEqual(heads, ['Title', 'Channel', 'Published', 'Duration'])
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
