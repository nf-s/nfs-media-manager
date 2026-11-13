import { aiSubscriptionBrowseQuery } from '@repo/schemas/ai-search'
import {
  SubscriptionDaySchema,
  SubscriptionSearchFieldsSchema,
  SubscriptionSortSchema,
} from '@repo/schemas/subscriptions'
import { YoutubeVideoIdSchema } from '@repo/schemas/youtube'

type PageSearchParams = Record<string, string | string[] | undefined>

/** The sorts the old Videos page offered. */
const YoutubeSortSchema = SubscriptionSortSchema.extract([
  'relevance',
  'publishedAt',
  'viewCount',
  'durationSec',
])

function first(params: PageSearchParams, key: string) {
  const value = params[key]
  return (Array.isArray(value) ? value[0] : value) ?? null
}

function day(params: PageSearchParams, key: 'publishedFrom' | 'publishedTo') {
  const result = SubscriptionDaySchema.safeParse(first(params, key))
  return result.success ? result.data : null
}

/**
 * An old `/youtube` link as a Subscriptions browse link. Search, view, sort,
 * the open video and published days carry over; the days become one
 * inclusive UTC `publishedAt` range. Channel and duration filters are dropped.
 */
export function subscriptionsHrefFromYoutube(params: PageSearchParams) {
  const next = new URLSearchParams()
  const q = (first(params, 'q') ?? '').trim().slice(0, 200)
  if (q) {
    next.set('q', q)
    const fields = SubscriptionSearchFieldsSchema.safeParse(
      first(params, 'fields'),
    )
    if (fields.success) next.set('fields', fields.data)
  }
  const publishedFrom = day(params, 'publishedFrom')
  const publishedTo = day(params, 'publishedTo')
  if (publishedFrom || publishedTo) {
    const { ranges } = aiSubscriptionBrowseQuery({
      q,
      fields: 'all',
      sources: [],
      types: [],
      publishedFrom,
      publishedTo,
      durationMinSec: null,
      durationMaxSec: null,
      sortBy: 'publishedAt',
      direction: 'desc',
    })
    next.set('ranges', JSON.stringify(ranges))
  }
  const sortBy = YoutubeSortSchema.safeParse(first(params, 'sortBy'))
  if (sortBy.success && (sortBy.data !== 'relevance' || q))
    next.set('sortBy', sortBy.data)
  const direction = first(params, 'sortDirection')
  if (direction === 'asc' || direction === 'desc')
    next.set('direction', direction)
  const view = first(params, 'view')
  if (view === 'grid' || view === 'list') next.set('view', view)
  const video = YoutubeVideoIdSchema.safeParse(first(params, 'video'))
  if (video.success) next.set('item', video.data)
  return `/subscriptions${next.size ? `?${next}` : ''}`
}

/** The old YouTube subscriptions page is the YouTube import page; the OAuth outcome carries over. */
export function youtubeImportHrefFromSubscriptions(params: PageSearchParams) {
  const next = new URLSearchParams({ mediaType: 'subscription' })
  const outcome = first(params, 'youtube')
  if (outcome === 'connected' || outcome === 'error')
    next.set('youtube', outcome)
  return `/imports/youtube?${next}`
}
