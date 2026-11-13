import {
  YOUTUBE_VIDEO_PAGE_SIZE,
  YoutubeChannelIdSchema,
  YoutubeDurationSchema,
  YoutubeSearchFieldsSchema,
  YoutubeVideoQuerySchema,
  YoutubeVideoSortSchema,
  type YoutubeChannel,
  type YoutubeDuration,
  type YoutubeSyncSchedule,
  type YoutubeSyncStatus,
  type YoutubeVideo,
  type YoutubeVideoSort,
} from '@repo/schemas/youtube'
import type { z } from 'zod'

/** How often the page re-reads status while a sync job is queued or running. */
export const YOUTUBE_SYNC_POLL_MS = 3000

/** The server accepts at most this many channels in one search. */
export const YOUTUBE_MAX_CHANNEL_FILTERS = 50

export const youtubeSyncStateLabels: Record<
  YoutubeSyncStatus['state'],
  string
> = {
  never: 'Not synced',
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  failed: 'Failed',
  complete: 'Complete',
}

export const youtubeScheduleLabels: Record<YoutubeSyncSchedule, string> = {
  off: 'Off',
  '1h': 'Every hour',
  '3h': 'Every 3 hours',
  '6h': 'Every 6 hours',
  daily: 'Daily',
  weekly: 'Weekly',
}

export const youtubeDurationLabels: Record<YoutubeDuration, string> = {
  short: 'Under 4 minutes',
  medium: '4–20 minutes',
  long: 'Over 20 minutes',
}

export const youtubeSortLabels: Record<YoutubeVideoSort, string> = {
  relevance: 'Relevance',
  publishedAt: 'Published',
  viewCount: 'Views',
  durationSec: 'Duration',
}

export function youtubeSyncPollInterval(
  state: YoutubeSyncStatus['state'] | null,
) {
  return state === 'running' ? YOUTUBE_SYNC_POLL_MS : false
}

/** "12 of 40", or the subscription-list step before channels are counted. */
export function youtubeChannelProgress(
  status: Pick<
    YoutubeSyncStatus,
    'state' | 'phase' | 'channelsDone' | 'channelsTotal'
  >,
) {
  if (status.state === 'running' && status.phase === 'subscriptions')
    return 'Reading subscriptions'
  if (status.phase === null) return '-'
  return `${status.channelsDone.toLocaleString()} of ${status.channelsTotal.toLocaleString()}`
}

export type YoutubeVideoView = 'grid' | 'list'
type SearchFields = z.infer<typeof YoutubeSearchFieldsSchema>

/** Videos page state, read from and written to the URL search parameters. */
export type YoutubeVideoState = {
  q: string
  fields: SearchFields
  channelIds: string[]
  duration: YoutubeDuration | null
  publishedFrom: string | null
  publishedTo: string | null
  /** As chosen; `youtubeVideoSort` gives the sort actually applied. */
  sortBy: YoutubeVideoSort | null
  sortDirection: 'asc' | 'desc'
  view: YoutubeVideoView
}

function parsed<T>(
  result: { success: true; data: T } | { success: false },
): T | null {
  return result.success ? result.data : null
}

export function parseYoutubeVideoState(
  params: URLSearchParams,
): YoutubeVideoState {
  const day = (key: 'publishedFrom' | 'publishedTo') =>
    parsed(
      YoutubeVideoQuerySchema.shape[key].safeParse(
        params.get(key) ?? undefined,
      ),
    ) ?? null
  const channelIds = [
    ...new Set(
      params
        .getAll('channelId')
        .filter((id) => YoutubeChannelIdSchema.safeParse(id).success),
    ),
  ].slice(0, YOUTUBE_MAX_CHANNEL_FILTERS)
  return {
    q: (params.get('q') ?? '').trim().slice(0, 200),
    fields:
      parsed(YoutubeSearchFieldsSchema.safeParse(params.get('fields'))) ??
      'all',
    channelIds,
    duration: parsed(YoutubeDurationSchema.safeParse(params.get('duration'))),
    publishedFrom: day('publishedFrom'),
    publishedTo: day('publishedTo'),
    sortBy: parsed(YoutubeVideoSortSchema.safeParse(params.get('sortBy'))),
    sortDirection: params.get('sortDirection') === 'asc' ? 'asc' : 'desc',
    view: params.get('view') === 'list' ? 'list' : 'grid',
  }
}

/** Relevance needs a search; without a chosen sort, searches rank by relevance and browsing shows the newest first. */
export function youtubeVideoSort(
  state: Pick<YoutubeVideoState, 'q' | 'sortBy'>,
): YoutubeVideoSort {
  if (state.sortBy && (state.sortBy !== 'relevance' || state.q))
    return state.sortBy
  return state.q ? 'relevance' : 'publishedAt'
}

export function youtubeSortOptions(q: string): YoutubeVideoSort[] {
  return YoutubeVideoSortSchema.options.filter(
    (option) => option !== 'relevance' || q,
  )
}

export function youtubeVideosPath(
  state: YoutubeVideoState,
  page: number,
  size = YOUTUBE_VIDEO_PAGE_SIZE,
) {
  const params = new URLSearchParams()
  if (state.q) {
    params.set('q', state.q)
    params.set('fields', state.fields)
  }
  for (const id of state.channelIds) params.append('channelId', id)
  if (state.duration) params.set('duration', state.duration)
  if (state.publishedFrom) params.set('publishedFrom', state.publishedFrom)
  if (state.publishedTo) params.set('publishedTo', state.publishedTo)
  const sortBy = youtubeVideoSort(state)
  params.set('sortBy', sortBy)
  params.set(
    'sortDirection',
    sortBy === 'relevance' ? 'desc' : state.sortDirection,
  )
  params.set('page', String(page))
  params.set('size', String(size))
  return `/api/v1/youtube/videos?${params}`
}

/** Whether any search or filter narrows the stored videos. */
export function hasYoutubeVideoFilters(state: YoutubeVideoState) {
  return Boolean(
    state.q ||
    state.fields !== 'all' ||
    state.channelIds.length ||
    state.duration ||
    state.publishedFrom ||
    state.publishedTo,
  )
}

/**
 * Applies parameter updates to a search string. Arrays repeat the parameter;
 * null or empty removes it. Any change other than the open video closes it.
 */
export function updateYoutubeSearch(
  search: string,
  updates: Record<string, string | string[] | null>,
) {
  const params = new URLSearchParams(search)
  for (const [key, value] of Object.entries(updates)) {
    params.delete(key)
    if (Array.isArray(value)) for (const item of value) params.append(key, item)
    else if (value) params.set(key, value)
  }
  if (Object.keys(updates).some((key) => key !== 'video'))
    params.delete('video')
  return params.toString()
}

/** A UTC day from the date filters, in the viewer's date format. */
export function formatYoutubeDay(day: string, locale?: string) {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString(locale, {
    timeZone: 'UTC',
  })
}

export function youtubeChannelVideosHref(channelId: string) {
  return `/youtube?${new URLSearchParams({ channelId })}`
}

/** h:mm:ss, or m:ss under an hour. */
export function formatVideoDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`
}

export function youtubeDurationLabel(
  video: Pick<YoutubeVideo, 'live' | 'durationSec'>,
) {
  if (video.live === 'live') return 'Live'
  if (video.live === 'upcoming') return 'Upcoming'
  return formatVideoDuration(video.durationSec)
}

/** 12K, 1.2M; a dash when the count is hidden. */
export function formatCompactCount(value: number | null, locale?: string) {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatCount(value: number | null) {
  return value === null ? 'Hidden' : value.toLocaleString()
}

export type YoutubeChannelSort =
  | 'title'
  | 'handle'
  | 'subscriberCount'
  | 'storedVideos'
  | 'latestVideoAt'

export const youtubeChannelColumns: Array<{
  key: YoutubeChannelSort
  label: string
  numeric?: boolean
}> = [
  { key: 'title', label: 'Channel' },
  { key: 'handle', label: 'Handle' },
  { key: 'subscriberCount', label: 'Subscribers', numeric: true },
  { key: 'storedVideos', label: 'Stored videos', numeric: true },
  { key: 'latestVideoAt', label: 'Latest video' },
]

export function youtubeChannelSort(value: string | null): YoutubeChannelSort {
  return (
    youtubeChannelColumns.find((column) => column.key === value)?.key ?? 'title'
  )
}

/** Filters by title or handle and sorts; missing values sort last in either direction. */
export function filterYoutubeChannels(
  channels: YoutubeChannel[],
  q: string,
  sortBy: YoutubeChannelSort,
  sortDirection: 'asc' | 'desc',
) {
  const needle = q.trim().toLocaleLowerCase()
  const matching = needle
    ? channels.filter((channel) =>
        [channel.title, channel.handle ?? ''].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        ),
      )
    : channels
  const sign = sortDirection === 'asc' ? 1 : -1
  return [...matching].sort((a, b) => {
    const left = a[sortBy]
    const right = b[sortBy]
    if (left === right) return a.title.localeCompare(b.title)
    if (left === null) return 1
    if (right === null) return -1
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right))
    return order * sign || a.title.localeCompare(b.title)
  })
}
