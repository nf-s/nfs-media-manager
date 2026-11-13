import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  YOUTUBE_VIDEO_PAGE_SIZE,
  YoutubeChannelSchema,
  YoutubeVideoQuerySchema,
  type YoutubeSyncStatus,
} from '@repo/schemas/youtube'
import {
  filterYoutubeChannels,
  formatCompactCount,
  formatVideoDuration,
  formatYoutubeDay,
  hasYoutubeVideoFilters,
  parseYoutubeVideoState,
  updateYoutubeSearch,
  youtubeChannelProgress,
  youtubeChannelSort,
  youtubeChannelVideosHref,
  youtubeDurationLabel,
  youtubeSortOptions,
  youtubeSyncPollInterval,
  youtubeVideoSort,
  youtubeVideosPath,
} from './youtube'

const channelA = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const channelB = 'UCbbbbbbbbbbbbbbbbbbbbbb'

function state(search: string) {
  return parseYoutubeVideoState(new URLSearchParams(search))
}

function apiQuery(path: string) {
  const url = new URL(path, 'https://example.test')
  assert.equal(url.pathname, '/api/v1/youtube/videos')
  return url.searchParams
}

test('video state defaults to newest first in a grid and ignores invalid parameters', () => {
  assert.deepEqual(state(''), {
    q: '',
    fields: 'all',
    channelIds: [],
    duration: null,
    publishedFrom: null,
    publishedTo: null,
    sortBy: null,
    sortDirection: 'desc',
    view: 'grid',
  })
  const invalid = state(
    'fields=body&channelId=bad&duration=tiny&publishedFrom=2026-13-40&publishedTo=yesterday&sortBy=rating&sortDirection=up&view=table',
  )
  assert.deepEqual(invalid, state(''))
})

test('video state reads search, repeated channels, filters, sort and layout', () => {
  const parsed = state(
    `q=%20bread%20oven%20&fields=title&channelId=${channelA}&channelId=${channelB}&channelId=${channelA}&duration=long&publishedFrom=2026-01-01&publishedTo=2026-02-28&sortBy=viewCount&sortDirection=asc&view=list&video=abcdefghijk`,
  )
  assert.deepEqual(parsed, {
    q: 'bread oven',
    fields: 'title',
    channelIds: [channelA, channelB],
    duration: 'long',
    publishedFrom: '2026-01-01',
    publishedTo: '2026-02-28',
    sortBy: 'viewCount',
    sortDirection: 'asc',
    view: 'list',
  })
  assert.equal(hasYoutubeVideoFilters(parsed), true)
  assert.equal(
    hasYoutubeVideoFilters(state('sortBy=viewCount&view=list')),
    false,
  )
  assert.equal(hasYoutubeVideoFilters(state('fields=title')), true)
})

test('relevance is the default with a search and is never applied without one', () => {
  assert.equal(youtubeVideoSort({ q: '', sortBy: null }), 'publishedAt')
  assert.equal(youtubeVideoSort({ q: 'oven', sortBy: null }), 'relevance')
  assert.equal(youtubeVideoSort({ q: '', sortBy: 'relevance' }), 'publishedAt')
  assert.equal(
    youtubeVideoSort({ q: 'oven', sortBy: 'viewCount' }),
    'viewCount',
  )
  assert.equal(
    youtubeVideoSort({ q: '', sortBy: 'durationSec' }),
    'durationSec',
  )
  assert.deepEqual(youtubeSortOptions(''), [
    'publishedAt',
    'viewCount',
    'durationSec',
  ])
  assert.deepEqual(youtubeSortOptions('oven'), [
    'relevance',
    'publishedAt',
    'viewCount',
    'durationSec',
  ])
})

test('API paths carry every filter and an explicit sort the server schema accepts', () => {
  const browse = apiQuery(youtubeVideosPath(state(''), 1))
  assert.equal(browse.get('sortBy'), 'publishedAt')
  assert.equal(browse.get('sortDirection'), 'desc')
  assert.equal(browse.get('page'), '1')
  assert.equal(browse.get('size'), String(YOUTUBE_VIDEO_PAGE_SIZE))
  assert.equal(browse.has('q'), false)
  assert.equal(browse.has('fields'), false)

  const filtered = apiQuery(
    youtubeVideosPath(
      state(
        `q=oven&fields=title&channelId=${channelA}&channelId=${channelB}&duration=short&publishedFrom=2026-01-01&publishedTo=2026-01-31&sortDirection=asc`,
      ),
      3,
    ),
  )
  assert.equal(filtered.get('q'), 'oven')
  assert.equal(filtered.get('fields'), 'title')
  assert.deepEqual(filtered.getAll('channelId'), [channelA, channelB])
  assert.equal(filtered.get('duration'), 'short')
  assert.equal(filtered.get('publishedFrom'), '2026-01-01')
  assert.equal(filtered.get('publishedTo'), '2026-01-31')
  assert.equal(filtered.get('sortBy'), 'relevance')
  // Relevance always ranks the best matches first.
  assert.equal(filtered.get('sortDirection'), 'desc')
  assert.equal(filtered.get('page'), '3')

  const parsed = YoutubeVideoQuerySchema.parse({
    ...Object.fromEntries(filtered),
    channelId: filtered.getAll('channelId'),
  })
  assert.deepEqual(parsed.channelId, [channelA, channelB])
  assert.equal(parsed.page, 3)

  const ascending = apiQuery(
    youtubeVideosPath(state('sortBy=durationSec&sortDirection=asc'), 1, 10),
  )
  assert.equal(ascending.get('sortBy'), 'durationSec')
  assert.equal(ascending.get('sortDirection'), 'asc')
  assert.equal(ascending.get('size'), '10')
})

test('search updates repeat arrays, drop empty values and close the open video', () => {
  assert.equal(
    updateYoutubeSearch('q=old&video=abcdefghijk&view=list', {
      channelId: [channelA, channelB],
    }),
    `q=old&view=list&channelId=${channelA}&channelId=${channelB}`,
  )
  assert.equal(
    updateYoutubeSearch(`channelId=${channelA}&q=old`, {
      channelId: [],
      q: '',
    }),
    '',
  )
  assert.equal(
    updateYoutubeSearch('q=old', { video: 'abcdefghijk' }),
    'q=old&video=abcdefghijk',
  )
  assert.equal(
    updateYoutubeSearch('q=old&video=abcdefghijk', { video: null }),
    'q=old',
  )
  assert.equal(
    youtubeChannelVideosHref(channelA),
    `/youtube?channelId=${channelA}`,
  )
})

test('durations, counts and dates use compact display forms', () => {
  assert.equal(formatVideoDuration(0), '0:00')
  assert.equal(formatVideoDuration(59), '0:59')
  assert.equal(formatVideoDuration(61), '1:01')
  assert.equal(formatVideoDuration(600), '10:00')
  assert.equal(formatVideoDuration(3600), '1:00:00')
  assert.equal(formatVideoDuration(3725), '1:02:05')
  assert.equal(formatVideoDuration(36000 + 59), '10:00:59')
  assert.equal(youtubeDurationLabel({ live: 'none', durationSec: 95 }), '1:35')
  assert.equal(youtubeDurationLabel({ live: 'live', durationSec: 0 }), 'Live')
  assert.equal(
    youtubeDurationLabel({ live: 'upcoming', durationSec: 0 }),
    'Upcoming',
  )
  assert.equal(formatCompactCount(null), '-')
  assert.equal(formatCompactCount(950, 'en'), '950')
  assert.equal(formatCompactCount(12000, 'en'), '12K')
  assert.equal(formatCompactCount(12345, 'en'), '12.3K')
  assert.equal(formatCompactCount(1_250_000, 'en'), '1.3M')
  assert.equal(formatYoutubeDay('2026-03-01', 'en-GB'), '01/03/2026')
})

test('sync progress and polling follow the run state', () => {
  assert.equal(youtubeSyncPollInterval('running'), 3000)
  const idle: YoutubeSyncStatus['state'][] = [
    'never',
    'paused',
    'stopped',
    'failed',
    'complete',
  ]
  for (const state of idle) assert.equal(youtubeSyncPollInterval(state), false)
  assert.equal(youtubeSyncPollInterval(null), false)
  const base = { channelsDone: 12, channelsTotal: 40 }
  assert.equal(
    youtubeChannelProgress({
      ...base,
      state: 'running',
      phase: 'subscriptions',
    }),
    'Reading subscriptions',
  )
  assert.equal(
    youtubeChannelProgress({ ...base, state: 'running', phase: 'videos' }),
    '12 of 40',
  )
  assert.equal(
    youtubeChannelProgress({ ...base, state: 'never', phase: null }),
    '-',
  )
})

test('channel table filters by title or handle and sorts missing values last', () => {
  const channel = (
    id: string,
    title: string,
    handle: string | null,
    subscriberCount: number | null,
    latestVideoAt: string | null,
  ) =>
    YoutubeChannelSchema.parse({
      id,
      title,
      handle,
      description: null,
      thumbnailUrl: null,
      subscriberCount,
      storedVideos: 3,
      latestVideoAt,
      historyComplete: true,
    })
  const channels = [
    channel(channelA, 'Kiln Notes', '@kilnnotes', 5000, '2026-01-02T00:00:00Z'),
    channel(channelB, 'Bread Bench', null, null, null),
    channel(
      'UCcccccccccccccccccccccc',
      'Alder Workshop',
      '@alder',
      120,
      '2026-03-04T00:00:00Z',
    ),
  ]
  const titles = (items: typeof channels) => items.map((item) => item.title)
  assert.deepEqual(
    titles(filterYoutubeChannels(channels, '', 'title', 'asc')),
    ['Alder Workshop', 'Bread Bench', 'Kiln Notes'],
  )
  assert.deepEqual(
    titles(filterYoutubeChannels(channels, '', 'subscriberCount', 'desc')),
    ['Kiln Notes', 'Alder Workshop', 'Bread Bench'],
  )
  assert.deepEqual(
    titles(filterYoutubeChannels(channels, '', 'subscriberCount', 'asc')),
    ['Alder Workshop', 'Kiln Notes', 'Bread Bench'],
  )
  assert.deepEqual(
    titles(filterYoutubeChannels(channels, '', 'latestVideoAt', 'desc')),
    ['Alder Workshop', 'Kiln Notes', 'Bread Bench'],
  )
  assert.deepEqual(
    titles(filterYoutubeChannels(channels, 'ALDER', 'title', 'asc')),
    ['Alder Workshop'],
  )
  assert.deepEqual(
    titles(filterYoutubeChannels(channels, 'kilnn', 'title', 'asc')),
    ['Kiln Notes'],
  )
  assert.equal(youtubeChannelSort('storedVideos'), 'storedVideos')
  assert.equal(youtubeChannelSort('unknown'), 'title')
  assert.equal(youtubeChannelSort(null), 'title')
})
