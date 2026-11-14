import {
  formatBrowseValue,
  sameBrowseFilter,
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import {
  SubscriptionItemQuerySchema,
  SubscriptionSearchFieldsSchema,
  SubscriptionSortSchema,
  SubscriptionTypeSchema,
  subscriptionTypeLabels,
  type SubscriptionItem,
  type SubscriptionPublishedPrecision,
  type SubscriptionSort,
  type SubscriptionSource,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { youtubeThumbnailUrl } from '@repo/schemas/youtube'
import type { TitleSuggestion } from './browse-suggestions'
import { formatVideoDuration } from './youtube'

/** API collection, page path and browser storage key suffix. */
export const subscriptionCollection = 'subscriptions'
export const subscriptionsPath = '/subscriptions'
export const subscriptionImportsHref = '/imports/youtube?mediaType=subscription'
/** URL parameters of the open drawer; changing them keeps the page and is not saved. */
export const subscriptionDrawerParams = ['item']

export const defaultSubscriptionColumns = [
  'title',
  'source',
  'type',
  'publishedAt',
  'durationSec',
  'viewCount',
]

export type SubscriptionView = 'grid' | 'list'
export type SubscriptionSearchFields = 'title' | 'all'

/** Browse page state, read from the URL search parameters. */
export type SubscriptionBrowseState = {
  q: string
  fields: SubscriptionSearchFields
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  /** As chosen; `subscriptionSort` gives the sort actually applied. */
  sortBy: SubscriptionSort | null
  direction: 'asc' | 'desc'
  view: SubscriptionView
  /** Null when the URL does not choose columns. */
  columns: string[] | null
}

export function parseSubscriptionFilters(value: string | null): BrowseFilter[] {
  const result = SubscriptionItemQuerySchema.shape.filters.safeParse(value)
  return result.success ? result.data : []
}

export function parseSubscriptionRanges(value: string | null): BrowseRange[] {
  const result = SubscriptionItemQuerySchema.shape.ranges.safeParse(value)
  return result.success ? result.data : []
}

export function parseSubscriptionBrowseState(
  params: URLSearchParams,
): SubscriptionBrowseState {
  const sort = SubscriptionSortSchema.safeParse(params.get('sortBy'))
  const fields = SubscriptionSearchFieldsSchema.safeParse(params.get('fields'))
  const columns = params.get('columns')
  return {
    q: (params.get('q') ?? '').trim().slice(0, 200),
    fields: fields.success ? fields.data : 'all',
    filters: parseSubscriptionFilters(params.get('filters')),
    ranges: parseSubscriptionRanges(params.get('ranges')),
    sortBy: sort.success ? sort.data : null,
    direction: params.get('direction') === 'asc' ? 'asc' : 'desc',
    view: params.get('view') === 'list' ? 'list' : 'grid',
    columns: columns === null ? null : columns.split(',').filter(Boolean),
  }
}

/** Relevance needs a search; without a chosen sort, searches rank by relevance and browsing shows the newest first. */
export function subscriptionSort(
  state: Pick<SubscriptionBrowseState, 'q' | 'sortBy'>,
): SubscriptionSort {
  if (state.sortBy && (state.sortBy !== 'relevance' || state.q))
    return state.sortBy
  return state.q ? 'relevance' : 'publishedAt'
}

export const subscriptionSortLabels: Record<SubscriptionSort, string> = {
  relevance: 'Relevance',
  publishedAt: 'Published',
  title: 'Title',
  source: 'Channel',
  durationSec: 'Duration',
  viewCount: 'Views',
  likeCount: 'Likes',
  commentCount: 'Comments',
}

export function subscriptionSortOptions(q: string): SubscriptionSort[] {
  return SubscriptionSortSchema.options.filter(
    (option) => option !== 'relevance' || q,
  )
}

export function isSubscriptionSort(key: string): key is SubscriptionSort {
  return SubscriptionSortSchema.safeParse(key).success
}

/** The API parameters for a state, and the identity that resets the virtual scroller. */
export function subscriptionBrowseQuery(state: SubscriptionBrowseState) {
  const sortBy = subscriptionSort(state)
  const direction = sortBy === 'relevance' ? 'desc' : state.direction
  const params = new URLSearchParams()
  if (state.q) {
    params.set('q', state.q)
    params.set('fields', state.fields)
  }
  params.set('filters', JSON.stringify(state.filters))
  params.set('ranges', JSON.stringify(state.ranges))
  params.set('sortBy', sortBy)
  params.set('direction', direction)
  return { identity: params.toString(), params, sortBy, direction }
}

/** Applies parameter updates to a search string; null or empty removes a parameter. */
export function updateSubscriptionSearch(
  search: string,
  updates: Record<string, string | null>,
) {
  const params = new URLSearchParams(search)
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === '') params.delete(key)
    else params.set(key, value)
  }
  return params
}

/** The view state remembered for the next visit: everything except the open drawer. */
export function savedSubscriptionSearch(params: URLSearchParams) {
  const saved = new URLSearchParams(params)
  for (const key of subscriptionDrawerParams) saved.delete(key)
  return saved.toString()
}

export function hasSubscriptionFilters(
  state: Pick<SubscriptionBrowseState, 'q' | 'filters' | 'ranges'>,
) {
  return Boolean(state.q || state.filters.length || state.ranges.length)
}

export function withSubscriptionFilter(
  filters: BrowseFilter[],
  filter: BrowseFilter,
): BrowseFilter[] {
  return filters.some((item) => sameBrowseFilter(item, filter))
    ? filters
    : [...filters, filter]
}

export function subscriptionsHref(filters: BrowseFilter[]) {
  return filters.length
    ? `${subscriptionsPath}?${new URLSearchParams({ filters: JSON.stringify(filters) })}`
    : subscriptionsPath
}

/** Browse page filtered to one channel or podcast. */
export function subscriptionSourceHref(title: string) {
  return subscriptionsHref([{ field: 'source', value: title }])
}

export function subscriptionTypeFilter(type: SubscriptionType): BrowseFilter {
  return { field: 'type', value: subscriptionTypeLabels[type] }
}

export function subscriptionOpenLabel(type: SubscriptionType) {
  return type === 'youtube' ? 'Open on YouTube' : 'Open on Spotify'
}

/** A YouTube thumbnail, or the episode artwork with the show's as fallback. */
export function subscriptionArtworkUrl(item: SubscriptionItem) {
  return item.type === 'youtube'
    ? youtubeThumbnailUrl(item.id)
    : (item.artworkUrl ?? item.sourceThumbnailUrl)
}

/** Live and upcoming streams instead of a length; a dash when unknown. */
export function formatSubscriptionDuration(item: SubscriptionItem) {
  if (item.type === 'youtube' && item.live === 'live') return 'Live'
  if (item.type === 'youtube' && item.live === 'upcoming') return 'Upcoming'
  return item.durationSec === null ? '-' : formatVideoDuration(item.durationSec)
}

/**
 * A publish date shown only as precisely as the provider reported it. Dates
 * without a time are UTC days; `detail` adds the time when there is one.
 */
export function formatSubscriptionPublished(
  publishedAt: string,
  precision: SubscriptionPublishedPrecision,
  { detail = false, locale }: { detail?: boolean; locale?: string } = {},
) {
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return '-'
  if (precision === 'year') return String(date.getUTCFullYear())
  if (precision === 'month')
    return date.toLocaleDateString(locale, {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
    })
  if (precision === 'day')
    return date.toLocaleDateString(locale, { timeZone: 'UTC' })
  return detail ? date.toLocaleString(locale) : date.toLocaleDateString(locale)
}

/** "12K" style counts for the grid; a dash when hidden or absent. */
export function formatCompactSubscriptionCount(
  value: number | null,
  locale?: string,
) {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function rangeBound(field: BrowseField | undefined, value: number) {
  if (field?.key === 'durationSec') return formatVideoDuration(value)
  if (field) return formatBrowseValue(field, value)
  return String(value)
}

/** "Published: 2024-01-01 to *", with durations as m:ss. */
export function subscriptionRangeLabel(
  range: BrowseRange,
  fields: BrowseField[],
) {
  const field = fields.find((field) => field.key === range.field)
  const bound = (value: number | undefined) =>
    value === undefined ? '*' : rangeBound(field, value)
  return `${field?.label ?? range.field}: ${bound(range.min)} to ${bound(range.max)}${range.includeMissing ? ' + missing' : ''}`
}

/** Labels "Title · Channel · Year", with the ID when two labels are equal. */
export function subscriptionTitleSuggestions(
  items: Pick<
    SubscriptionItem,
    'id' | 'title' | 'sourceTitle' | 'publishedAt'
  >[],
): TitleSuggestion[] {
  return items
    .map((item) => ({
      id: item.id,
      title: item.title,
      label: [item.title, item.sourceTitle, item.publishedAt.slice(0, 4)]
        .filter(Boolean)
        .join(' · '),
    }))
    .map((item, _, all) => ({
      ...item,
      label: all.some(
        (other) => other.id !== item.id && other.label === item.label,
      )
        ? `${item.label} · ${item.id}`
        : item.label,
    }))
}

/** Height of a grid card under the thumbnail; matches `.cardBody` in subscription-browser.module.css. */
export const subscriptionCardBodyHeight = 72

/** Grid geometry: 16:9 thumbnails over a fixed-height body. */
export function subscriptionGridGeometry(width: number) {
  const mobile = width <= 700
  const gap = mobile ? 8 : 12
  const columns = Math.max(2, Math.floor(width / (mobile ? 170 : 250)))
  const thumbWidth = Math.max(0, (width - (columns - 1) * gap) / columns)
  const cardHeight = thumbWidth * (9 / 16) + subscriptionCardBodyHeight
  return { mobile, gap, columns, cardHeight, rowHeight: cardHeight + gap }
}

export type SubscriptionSourceSort =
  | 'title'
  | 'type'
  | 'storedItems'
  | 'latestItemAt'
  | 'size'
  | 'description'
  | 'handle'
  | 'historyComplete'

export const subscriptionSourceColumns: Array<{
  key: SubscriptionSourceSort
  label: string
  numeric?: boolean
  defaultVisible?: boolean
}> = [
  { key: 'title', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'storedItems', label: 'Stored items', numeric: true },
  { key: 'latestItemAt', label: 'Latest item' },
  { key: 'size', label: 'Subscribers / episodes', numeric: true },
  { key: 'description', label: 'Description', defaultVisible: false },
  { key: 'handle', label: 'Handle', defaultVisible: false },
  { key: 'historyComplete', label: 'History', defaultVisible: false },
]

export function subscriptionSourceSort(
  value: string | null,
): SubscriptionSourceSort {
  return (
    subscriptionSourceColumns.find((column) => column.key === value)?.key ??
    'title'
  )
}

export function parseSubscriptionType(
  value: string | null,
): SubscriptionType | null {
  const result = SubscriptionTypeSchema.safeParse(value)
  return result.success ? result.data : null
}

/** A channel's subscribers or a podcast's episode total; null when hidden or unknown. */
export function subscriptionSourceSize(source: SubscriptionSource) {
  return source.type === 'youtube' ? source.subscriberCount : source.itemTotal
}

export function formatSubscriptionSourceSize(source: SubscriptionSource) {
  const size = subscriptionSourceSize(source)
  if (size === null) return source.type === 'youtube' ? 'Hidden' : '-'
  return `${size.toLocaleString()} ${
    source.type === 'youtube'
      ? size === 1
        ? 'subscriber'
        : 'subscribers'
      : size === 1
        ? 'episode'
        : 'episodes'
  }`
}

function sourceSortValue(
  source: SubscriptionSource,
  key: SubscriptionSourceSort,
): string | number | null {
  if (key === 'type') return subscriptionTypeLabels[source.type]
  if (key === 'size') return subscriptionSourceSize(source)
  if (key === 'handle') return source.type === 'youtube' ? source.handle : null
  if (key === 'historyComplete')
    return source.historyComplete ? 'Complete' : 'Reading history'
  return source[key]
}

/** Filters by name and type and sorts; missing values sort last in either direction. */
export function filterSubscriptionSources(
  sources: SubscriptionSource[],
  {
    q,
    type,
    sortBy,
    direction,
  }: {
    q: string
    type: SubscriptionType | null
    sortBy: SubscriptionSourceSort
    direction: 'asc' | 'desc'
  },
) {
  const needle = q.trim().toLocaleLowerCase()
  const matching = sources.filter(
    (source) =>
      (!type || source.type === type) &&
      (!needle ||
        [source.title, source.type === 'youtube' ? (source.handle ?? '') : '']
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle)),
  )
  const sign = direction === 'asc' ? 1 : -1
  return [...matching].sort((a, b) => {
    const left = sourceSortValue(a, sortBy)
    const right = sourceSortValue(b, sortBy)
    const byTitle = a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    if (left === right) return byTitle
    if (left === null) return 1
    if (right === null) return -1
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right))
    return order * sign || byTitle
  })
}
