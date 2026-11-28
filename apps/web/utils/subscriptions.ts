import {
  sameBrowseFilter,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import {
  MixSortSchema,
  SubscriptionItemQuerySchema,
  SubscriptionSearchFieldsSchema,
  SubscriptionSortSchema,
  SubscriptionSourceIdSchema,
  SubscriptionTypeSchema,
  subscriptionSort,
  subscriptionLibraryTypes,
  subscriptionLiveLabels,
  subscriptionTypeLabels,
  type SubscriptionItem,
  type SubscriptionLibrary,
  type SubscriptionPublishedPrecision,
  type SubscriptionSort,
  type SubscriptionSource,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { youtubeThumbnailUrl } from '@repo/schemas/youtube'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatDateTime,
} from '@repo/ui/lib/format'
import type { TitleSuggestion } from './browse-suggestions'
import {
  fewestGridColumns,
  parseBrowseView,
  type BrowseView,
  type GridDensity,
} from './media-grid'
import { libraryImportsHome, scopedHref } from './media-scope'
import { formatVideoDuration } from './youtube'

export {
  subscriptionSort,
  subscriptionSortLabels,
  subscriptionSortLabelsFor,
} from '@repo/schemas/subscriptions'
export { subscriptionRangeLabel } from '@repo/schemas/browse-display'

type Noun = { one: string; other: string }
type SubscriptionLibraryPage = {
  collection: 'subscriptions' | 'mixes'
  path: string
  sourcesPath: string
  importsHref: string
  itemKind: 'subscription' | 'mix'
  sourceKind: 'channel' | 'show'
  name: string
  items: Noun
  plural: string
  sources: Noun
  sourcesTitle: string
}

/**
 * Where each library lives in the app. Both read the Subscriptions API; the
 * collection names the library in query keys and browser storage, so the two
 * never share a cache entry or saved view.
 */
export const subscriptionLibraryPages: Record<
  SubscriptionLibrary,
  SubscriptionLibraryPage
> = {
  subscriptions: {
    collection: 'subscriptions',
    path: '/subscriptions',
    sourcesPath: '/subscriptions/channels',
    importsHref: '/imports/youtube?mediaType=subscription',
    itemKind: 'subscription',
    sourceKind: 'channel',
    name: 'Subscriptions',
    items: { one: 'item', other: 'items' },
    plural: 'subscriptions',
    sources: { one: 'channel', other: 'channels' },
    sourcesTitle: 'Channels',
  },
  mixes: {
    collection: 'mixes',
    path: '/mixes',
    sourcesPath: '/mixes/shows',
    importsHref: scopedHref(libraryImportsHome('mix'), 'mix'),
    itemKind: 'mix',
    sourceKind: 'show',
    name: 'Mixes',
    items: { one: 'mix', other: 'mixes' },
    plural: 'mixes',
    sources: { one: 'show', other: 'shows' },
    sourcesTitle: 'Shows',
  },
}

/** API parameters that select a library; Subscriptions is the API default. */
export function subscriptionLibraryParams(
  library: SubscriptionLibrary,
): Record<string, string> {
  return library === 'mixes' ? { library } : {}
}

/** URL parameters of the open drawer; changing them keeps the page and is not saved. */
export const subscriptionDrawerParams = ['item']

/** Column, picker and sort order: identity, creator, properties, dates, counts, pills. */
export const subscriptionFieldOrders: Record<SubscriptionLibrary, string[]> = {
  subscriptions: [
    'title',
    'source',
    'type',
    'publishedAt',
    'durationSec',
    'live',
    'watchedAt',
    'viewCount',
    'likeCount',
    'commentCount',
    'genre',
  ],
  mixes: [
    'title',
    'source',
    'type',
    'artist',
    'publishedAt',
    'durationSec',
    'hasRecording',
    'watchedAt',
    'genre',
  ],
}
export const subscriptionFieldOrder = subscriptionFieldOrders.subscriptions

export const defaultSubscriptionColumnsFor: Record<
  SubscriptionLibrary,
  string[]
> = {
  subscriptions: ['title', 'source', 'publishedAt', 'durationSec', 'watchedAt'],
  mixes: [
    'title',
    'source',
    'type',
    'artist',
    'publishedAt',
    'durationSec',
    'watchedAt',
  ],
}
export const defaultSubscriptionColumns =
  defaultSubscriptionColumnsFor.subscriptions

export type SubscriptionSearchFields = 'title' | 'all'

/** Browse page state, read from the URL search parameters. */
export type SubscriptionBrowseState = {
  q: string
  sourceId?: string
  fields: SubscriptionSearchFields
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  /** As chosen; `subscriptionSort` gives the sort actually applied. */
  sortBy: SubscriptionSort | null
  direction: 'asc' | 'desc'
  view: BrowseView
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
  library: SubscriptionLibrary = 'subscriptions',
): SubscriptionBrowseState {
  const sort = SubscriptionSortSchema.safeParse(params.get('sortBy'))
  const fields = SubscriptionSearchFieldsSchema.safeParse(params.get('fields'))
  const source = SubscriptionSourceIdSchema.safeParse(params.get('sourceId'))
  const columns = params.get('columns')
  return {
    q: (params.get('q') ?? '').trim().slice(0, 200),
    ...(source.success ? { sourceId: source.data } : {}),
    fields: fields.success ? fields.data : 'all',
    filters: parseSubscriptionFilters(params.get('filters')),
    ranges: parseSubscriptionRanges(params.get('ranges')),
    sortBy:
      sort.success && isSubscriptionSort(sort.data, library) ? sort.data : null,
    direction: params.get('direction') === 'asc' ? 'asc' : 'desc',
    view: parseBrowseView(params.get('view')),
    columns: columns === null ? null : columns.split(',').filter(Boolean),
  }
}

export function subscriptionSortOptions(
  q: string,
  library: SubscriptionLibrary = 'subscriptions',
): SubscriptionSort[] {
  return SubscriptionSortSchema.options.filter(
    (option) =>
      (option !== 'relevance' || q) && isSubscriptionSort(option, library),
  )
}

export function isSubscriptionSort(
  key: string,
  library: SubscriptionLibrary = 'subscriptions',
): key is SubscriptionSort {
  // Mixes have no view, like or comment counts.
  return (
    library === 'mixes' ? MixSortSchema : SubscriptionSortSchema
  ).safeParse(key).success
}

/** The API parameters for a state, and the identity that resets the virtual scroller. */
export function subscriptionBrowseQuery(
  state: SubscriptionBrowseState,
  library: SubscriptionLibrary = 'subscriptions',
) {
  const sortBy = subscriptionSort(state)
  const direction = sortBy === 'relevance' ? 'desc' : state.direction
  const params = new URLSearchParams(subscriptionLibraryParams(library))
  if (state.q) {
    params.set('q', state.q)
    params.set('fields', state.fields)
  }
  if (state.sourceId) params.set('sourceId', state.sourceId)
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
  state: Pick<SubscriptionBrowseState, 'q' | 'filters' | 'ranges' | 'sourceId'>,
) {
  return Boolean(
    state.q || state.sourceId || state.filters.length || state.ranges.length,
  )
}

export function withSubscriptionFilter(
  filters: BrowseFilter[],
  filter: BrowseFilter,
): BrowseFilter[] {
  return filters.some((item) => sameBrowseFilter(item, filter))
    ? filters
    : [...filters, filter]
}

export function subscriptionsHref(
  filters: BrowseFilter[],
  library: SubscriptionLibrary = 'subscriptions',
) {
  const path = subscriptionLibraryPages[library].path
  return filters.length
    ? `${path}?${new URLSearchParams({ filters: JSON.stringify(filters) })}`
    : path
}

/** Browse page filtered to one channel, podcast or show. */
export function subscriptionSourceHref(
  id: string,
  library: SubscriptionLibrary = 'subscriptions',
) {
  return `${subscriptionLibraryPages[library].path}?${new URLSearchParams({ sourceId: id })}`
}

/** The library's channel or show list, optionally filtered to one type. */
export function subscriptionSourcesHref(
  library: SubscriptionLibrary,
  type?: SubscriptionType,
) {
  const path = subscriptionLibraryPages[library].sourcesPath
  return type ? `${path}?${new URLSearchParams({ type })}` : path
}

export function subscriptionTypeFilter(type: SubscriptionType): BrowseFilter {
  return { field: 'type', value: subscriptionTypeLabels[type] }
}

/** A YouTube thumbnail, or the episode or mix artwork with the show's as fallback. */
export function subscriptionArtworkUrl(item: SubscriptionItem) {
  return item.type === 'youtube'
    ? youtubeThumbnailUrl(item.id)
    : (item.artworkUrl ?? item.sourceThumbnailUrl)
}

/** Live and upcoming streams instead of a length; an en dash when unknown. */
export function formatSubscriptionDuration(item: SubscriptionItem) {
  if (item.type === 'youtube' && item.live !== 'none')
    return subscriptionLiveLabels[item.live]
  return item.durationSec === null
    ? EMPTY_VALUE
    : formatVideoDuration(item.durationSec)
}

/**
 * A publish date in ISO form, only as precise as the provider reported it:
 * `2024`, `2024-03` or `2024-03-01`. Dates without a time are UTC days; a
 * timed date is the local day, and `detail` adds the time.
 */
export function formatSubscriptionPublished(
  publishedAt: string,
  precision: SubscriptionPublishedPrecision,
  { detail = false }: { detail?: boolean } = {},
) {
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE
  const day = date.toISOString().slice(0, 10)
  if (precision === 'year') return day.slice(0, 4)
  if (precision === 'month') return day.slice(0, 7)
  if (precision === 'day') return day
  return detail ? formatDateTime(date) : formatDate(date)
}

/** "12K" style counts for the grid; an en dash when hidden or absent. */
export function formatCompactSubscriptionCount(
  value: number | null,
  locale = 'en',
) {
  if (value === null) return EMPTY_VALUE
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
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

/** Height of a nested subscription card under its thumbnail. */
export const subscriptionCardBodyHeight = 72

/** Grid geometry: 16:9 thumbnails over a fixed-height body. */
/** Width per column of a nested video grid, by density. Compact fits three on a phone. */
const subscriptionColumnWidth: Record<
  'mobile' | 'desktop',
  Record<GridDensity, number>
> = {
  mobile: { compact: 110, standard: 170, roomy: 240 },
  desktop: { compact: 180, standard: 250, roomy: 340 },
}

export function subscriptionGridGeometry(
  width: number,
  density: GridDensity = 'standard',
) {
  const mobile = width <= 700
  const gap = mobile ? 8 : 12
  const columns = Math.max(
    fewestGridColumns(density),
    Math.floor(
      width / subscriptionColumnWidth[mobile ? 'mobile' : 'desktop'][density],
    ),
  )
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

export type SubscriptionSourceColumn = {
  key: SubscriptionSourceSort
  label: string
  numeric?: boolean
  defaultVisible?: boolean
}

const subscriptionSourceColumns: SubscriptionSourceColumn[] = [
  { key: 'title', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'storedItems', label: 'Stored items', numeric: true },
  { key: 'latestItemAt', label: 'Latest item' },
  { key: 'size', label: 'Subscribers / episodes', numeric: true },
  { key: 'description', label: 'Description', defaultVisible: false },
  { key: 'handle', label: 'Handle', defaultVisible: false },
  { key: 'historyComplete', label: 'History', defaultVisible: false },
]

/** A station show has no handle; its size is the station's episode count. */
const mixSourceColumns: SubscriptionSourceColumn[] = [
  { key: 'title', label: 'Show' },
  { key: 'type', label: 'Station' },
  { key: 'storedItems', label: 'Stored mixes', numeric: true },
  { key: 'latestItemAt', label: 'Latest mix' },
  { key: 'size', label: 'Episodes', numeric: true, defaultVisible: false },
  { key: 'description', label: 'Description', defaultVisible: false },
  { key: 'historyComplete', label: 'History', defaultVisible: false },
]

export const subscriptionSourceColumnsFor: Record<
  SubscriptionLibrary,
  SubscriptionSourceColumn[]
> = {
  subscriptions: subscriptionSourceColumns,
  mixes: mixSourceColumns,
}

export function subscriptionSourceSort(
  value: string | null,
  library: SubscriptionLibrary = 'subscriptions',
): SubscriptionSourceSort {
  return (
    subscriptionSourceColumnsFor[library].find((column) => column.key === value)
      ?.key ?? 'title'
  )
}

function inLibrary(
  type: SubscriptionType,
  library: SubscriptionLibrary | undefined,
) {
  return !library || subscriptionLibraryTypes[library].includes(type)
}

/** A type in the URL; with a library, only that library's types. */
export function parseSubscriptionType(
  value: string | null,
  library?: SubscriptionLibrary,
): SubscriptionType | null {
  const result = SubscriptionTypeSchema.safeParse(value)
  return result.success && inLibrary(result.data, library) ? result.data : null
}

export function parseSubscriptionTypes(
  value: string | null,
  library?: SubscriptionLibrary,
): SubscriptionType[] {
  try {
    const result = SubscriptionTypeSchema.array().safeParse(
      value ? JSON.parse(value) : [],
    )
    return result.success
      ? result.data.filter((type) => inLibrary(type, library))
      : []
  } catch {
    return []
  }
}

/** A channel's subscribers or a podcast's episode total; null when hidden or unknown. */
export function subscriptionSourceSize(source: SubscriptionSource) {
  return source.type === 'youtube' ? source.subscriberCount : source.itemTotal
}

export function formatSubscriptionSourceSize(source: SubscriptionSource) {
  const size = subscriptionSourceSize(source)
  if (size === null) return source.type === 'youtube' ? 'Hidden' : EMPTY_VALUE
  return `${formatCount(size)} ${
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
    types = [],
    history = [],
    sortBy,
    direction,
  }: {
    q: string
    type: SubscriptionType | null
    types?: readonly SubscriptionType[]
    history?: readonly ('complete' | 'reading')[]
    sortBy: SubscriptionSourceSort
    direction: 'asc' | 'desc'
  },
) {
  const needle = q.trim().toLocaleLowerCase()
  const matching = sources.filter(
    (source) =>
      (!type || source.type === type) &&
      (!types.length || types.includes(source.type)) &&
      (!history.length ||
        history.includes(source.historyComplete ? 'complete' : 'reading')) &&
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
