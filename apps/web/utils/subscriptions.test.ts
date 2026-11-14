import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SpotifySubscriptionItemSchema,
  SubscriptionSourceSchema,
  YoutubeSubscriptionItemSchema,
  subscriptionBrowseFields,
} from '@repo/schemas/subscriptions'
import { browseSuggestions } from './browse-suggestions'
import {
  filterSubscriptionSources,
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  formatSubscriptionSourceSize,
  hasSubscriptionFilters,
  parseSubscriptionBrowseState,
  savedSubscriptionSearch,
  subscriptionArtworkUrl,
  subscriptionBrowseQuery,
  subscriptionGridGeometry,
  subscriptionRangeLabel,
  subscriptionSort,
  subscriptionSortOptions,
  subscriptionSourceHref,
  subscriptionTitleSuggestions,
  updateSubscriptionSearch,
  withSubscriptionFilter,
} from './subscriptions'

const channelId = `UC${'c'.repeat(22)}`
const showId = 's'.repeat(22)

const video = YoutubeSubscriptionItemSchema.parse({
  type: 'youtube',
  id: 'abcdefghijk',
  sourceId: channelId,
  sourceTitle: 'Example Cooking',
  sourceThumbnailUrl: 'https://images.example.test/channel.jpg',
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
  sourceThumbnailUrl: 'https://images.example.test/show.jpg',
  title: 'Orbits',
  description: '',
  tags: [],
  publishedAt: '2024-03-01T00:00:00.000Z',
  publishedPrecision: 'month',
  durationSec: 3725,
  url: `https://open.spotify.com/episode/${'e'.repeat(22)}`,
  artworkUrl: null,
})

test('browse state round-trips search, filters, ranges, sort, view and columns through the URL', () => {
  const filters = [
    { field: 'source', value: 'Example Cooking', mode: 'required' as const },
    { field: 'type', value: 'Podcast', mode: 'exclude' as const },
  ]
  const ranges = [
    { field: 'durationSec', min: 60, max: 600, includeMissing: true },
  ]
  const search = updateSubscriptionSearch('item=abcdefghijk', {
    q: 'orbit',
    fields: 'title',
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy: 'viewCount',
    direction: 'asc',
    view: 'list',
    columns: 'title,type,genre',
  })
  assert.deepEqual(parseSubscriptionBrowseState(search), {
    q: 'orbit',
    fields: 'title',
    filters,
    ranges,
    sortBy: 'viewCount',
    direction: 'asc',
    view: 'list',
    columns: ['title', 'type', 'genre'],
  })
  assert.equal(search.get('item'), 'abcdefghijk')
  assert.doesNotMatch(savedSubscriptionSearch(search), /item=/)
  assert.equal(
    updateSubscriptionSearch(search.toString(), {
      q: null,
      view: '',
    }).has('q'),
    false,
  )
})

test('invalid URL parameters fall back to defaults', () => {
  const state = parseSubscriptionBrowseState(
    new URLSearchParams({
      fields: 'everything',
      filters: '[{"field":"handle","value":"x"}]',
      ranges: '[{"field":"rating","min":1}]',
      sortBy: 'score',
      direction: 'sideways',
      view: 'table',
    }),
  )
  assert.deepEqual(state, {
    q: '',
    fields: 'all',
    filters: [],
    ranges: [],
    sortBy: null,
    direction: 'desc',
    view: 'grid',
    columns: null,
  })
  assert.equal(hasSubscriptionFilters(state), false)
})

test('relevance applies only with a search and the API query follows the applied sort', () => {
  assert.equal(subscriptionSort({ q: '', sortBy: null }), 'publishedAt')
  assert.equal(subscriptionSort({ q: 'bread', sortBy: null }), 'relevance')
  assert.equal(subscriptionSort({ q: '', sortBy: 'relevance' }), 'publishedAt')
  assert.equal(subscriptionSort({ q: '', sortBy: 'title' }), 'title')
  assert.deepEqual(subscriptionSortOptions(''), [
    'publishedAt',
    'title',
    'source',
    'durationSec',
    'viewCount',
    'likeCount',
    'commentCount',
  ])
  assert.equal(subscriptionSortOptions('bread')[0], 'relevance')

  const browse = parseSubscriptionBrowseState(
    new URLSearchParams('q=bread&fields=title&direction=asc&view=list'),
  )
  const query = subscriptionBrowseQuery(browse)
  assert.equal(query.sortBy, 'relevance')
  assert.equal(query.direction, 'desc')
  assert.equal(
    query.params.toString(),
    'q=bread&fields=title&filters=%5B%5D&ranges=%5B%5D&sortBy=relevance&direction=desc',
  )
  // The view does not change the query, so switching it keeps loaded pages.
  assert.equal(
    subscriptionBrowseQuery({ ...browse, view: 'grid' }).identity,
    query.identity,
  )
  assert.equal(
    subscriptionBrowseQuery(
      parseSubscriptionBrowseState(new URLSearchParams()),
    ).params.has('q'),
    false,
  )
})

test('filters are added once and source links filter the browse page', () => {
  const filter = { field: 'source', value: 'Example Cooking' }
  const once = withSubscriptionFilter([], filter)
  assert.equal(withSubscriptionFilter(once, filter), once)
  assert.equal(
    subscriptionSourceHref('Example Cooking'),
    `/subscriptions?${new URLSearchParams({ filters: JSON.stringify([filter]) })}`,
  )
})

test('range chip labels format dates, durations and missing values', () => {
  const fields = subscriptionBrowseFields
  assert.equal(
    subscriptionRangeLabel(
      {
        field: 'publishedAt',
        min: Date.parse('2026-01-01T00:00:00.000Z'),
        includeMissing: false,
      },
      fields,
    ),
    'Published: 2026-01-01 to *',
  )
  assert.equal(
    subscriptionRangeLabel(
      { field: 'durationSec', min: 240, max: 3725, includeMissing: false },
      fields,
    ),
    'Duration: 4:00 to 1:02:05',
  )
  assert.equal(
    subscriptionRangeLabel(
      { field: 'viewCount', max: 1000, includeMissing: true },
      fields,
    ),
    'Views: * to 1,000 + missing',
  )
})

test('published dates show only the precision the provider reported', () => {
  const at = '2024-03-01T00:00:00.000Z'
  assert.equal(
    formatSubscriptionPublished(at, 'year', { locale: 'en-US' }),
    '2024',
  )
  assert.equal(
    formatSubscriptionPublished(at, 'month', { locale: 'en-US' }),
    'Mar 2024',
  )
  assert.equal(
    formatSubscriptionPublished(at, 'day', { locale: 'en-US' }),
    '3/1/2024',
  )
  assert.equal(
    formatSubscriptionPublished(video.publishedAt, 'time', { locale: 'en-US' }),
    new Date(video.publishedAt).toLocaleDateString('en-US'),
  )
  assert.equal(
    formatSubscriptionPublished(video.publishedAt, 'time', {
      detail: true,
      locale: 'en-US',
    }),
    new Date(video.publishedAt).toLocaleString('en-US'),
  )
  assert.equal(formatSubscriptionPublished('not a date', 'day'), '-')
})

test('durations show live state, length or a dash; artwork falls back to the show', () => {
  assert.equal(formatSubscriptionDuration(video), '12:34')
  assert.equal(formatSubscriptionDuration(episode), '1:02:05')
  assert.equal(
    formatSubscriptionDuration({ ...video, live: 'live', durationSec: null }),
    'Live',
  )
  assert.equal(
    formatSubscriptionDuration({
      ...video,
      live: 'upcoming',
      durationSec: null,
    }),
    'Upcoming',
  )
  assert.equal(
    formatSubscriptionDuration({ ...episode, durationSec: null }),
    '-',
  )
  assert.equal(
    subscriptionArtworkUrl(video),
    'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
  )
  assert.equal(subscriptionArtworkUrl(episode), episode.sourceThumbnailUrl)
  assert.equal(
    subscriptionArtworkUrl({
      ...episode,
      artworkUrl: 'https://images.example.test/episode.jpg',
    }),
    'https://images.example.test/episode.jpg',
  )
})

test('title suggestions name the channel and year, and rank exact titles first', () => {
  const suggestions = subscriptionTitleSuggestions([
    { ...episode, title: 'Orbits explained' },
    episode,
    { ...episode, id: 'f'.repeat(22) },
  ])
  assert.deepEqual(
    browseSuggestions([], suggestions, 'orbits').map((option) =>
      option.kind === 'item' ? option.item : undefined,
    ),
    [
      {
        id: episode.id,
        title: 'Orbits',
        label: `Orbits · Example Science Hour · 2024 · ${episode.id}`,
      },
      {
        id: 'f'.repeat(22),
        title: 'Orbits',
        label: `Orbits · Example Science Hour · 2024 · ${'f'.repeat(22)}`,
      },
      {
        id: episode.id,
        title: 'Orbits explained',
        label: 'Orbits explained · Example Science Hour · 2024',
      },
    ],
  )
})

test('grid geometry keeps at least two columns and 16:9 thumbnails', () => {
  const desktop = subscriptionGridGeometry(1000)
  assert.equal(desktop.columns, 4)
  assert.equal(desktop.mobile, false)
  assert.equal(desktop.cardHeight, ((1000 - 3 * 12) / 4) * (9 / 16) + 72)
  assert.equal(desktop.rowHeight, desktop.cardHeight + 12)
  const phone = subscriptionGridGeometry(300)
  assert.equal(phone.columns, 2)
  assert.equal(phone.gap, 8)
})

const youtubeSourceInput = {
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
  subscriberCount: null,
}
const youtubeSource = SubscriptionSourceSchema.parse(youtubeSourceInput)
const spotifySource = SubscriptionSourceSchema.parse({
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
})

test('sources filter by name, handle and type and sort missing values last', () => {
  const sources = [youtubeSource, spotifySource]
  const options = { q: '', type: null, direction: 'asc' as const }
  assert.deepEqual(
    filterSubscriptionSources(sources, { ...options, sortBy: 'size' }).map(
      (source) => source.id,
    ),
    [showId, channelId],
  )
  assert.deepEqual(
    filterSubscriptionSources(sources, {
      ...options,
      sortBy: 'latestItemAt',
      direction: 'desc',
    }).map((source) => source.id),
    [channelId, showId],
  )
  assert.deepEqual(
    filterSubscriptionSources(sources, { ...options, sortBy: 'type' }).map(
      (source) => source.type,
    ),
    ['spotify', 'youtube'],
  )
  assert.deepEqual(
    filterSubscriptionSources(sources, {
      ...options,
      q: 'EXAMPLECOOK',
      sortBy: 'title',
    }).map((source) => source.id),
    [channelId],
  )
  assert.deepEqual(
    filterSubscriptionSources(sources, {
      ...options,
      type: 'spotify',
      sortBy: 'title',
    }).map((source) => source.id),
    [showId],
  )
  assert.equal(formatSubscriptionSourceSize(youtubeSource), 'Hidden')
  assert.equal(formatSubscriptionSourceSize(spotifySource), '240 episodes')
  assert.equal(
    formatSubscriptionSourceSize(
      SubscriptionSourceSchema.parse({
        ...youtubeSourceInput,
        subscriberCount: 1,
      }),
    ),
    '1 subscriber',
  )
})
