import { z } from 'zod'
import {
  BrowseFacetQuerySchema,
  BrowseFilterSchema,
  BrowseRangesParamSchema,
  type BrowseField,
  type BrowseValues,
} from './browse'
import {
  DirectionSchema,
  PaginatedDataSchema,
  PaginationQuerySchema,
} from './common'
import { JobStatusSchema } from './job'
import { CatalogScopeQuerySchema } from './catalog'
import {
  YOUTUBE_SYNC_TASK,
  YoutubeChannelIdSchema,
  YoutubeSyncScheduleSchema,
  YoutubeSyncSettingsSchema,
  YoutubeSyncStateSchema,
  YoutubeVideoIdSchema,
  youtubeChannelUrl,
  youtubeVideoUrl,
} from './youtube'

/** `scrape_job.options.task` of the account-level job that syncs saved Spotify podcasts and their episodes. */
export const SPOTIFY_PODCAST_SYNC_TASK = 'spotify-podcast-sync'

/** A radio station whose archive fills the Mixes library. */
export const MixStationSchema = z.enum(['rinse', 'nts', 'lotradio'])
export type MixStation = z.infer<typeof MixStationSchema>

/** `scrape_job.options.task` of the job that syncs one station's shows and mixes. */
export const MIX_STATION_SYNC_TASKS: Record<MixStation, string> = {
  rinse: 'rinse-mix-sync',
  nts: 'nts-mix-sync',
  lotradio: 'lotradio-mix-sync',
}

/** Task jobs that fill the Mixes library. */
export const MIX_SYNC_TASKS = [
  MIX_STATION_SYNC_TASKS.rinse,
  MIX_STATION_SYNC_TASKS.nts,
  MIX_STATION_SYNC_TASKS.lotradio,
] as const

/** Task jobs that fill the Subscriptions library. */
export const SUBSCRIPTION_SYNC_TASKS = [
  YOUTUBE_SYNC_TASK,
  SPOTIFY_PODCAST_SYNC_TASK,
] as const

/** A provider whose account's channels and podcasts fill the Subscriptions library. */
export const SubscriptionProviderSchema = z.enum(['youtube', 'spotify'])
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>

/**
 * The provider a source or item comes from; it decides the displayed type.
 * YouTube and Spotify rows are the Subscriptions library; station rows are the
 * Mixes library. Both share the same tables, queries and sync checkpoints.
 */
export const SubscriptionTypeSchema = z.enum([
  ...SubscriptionProviderSchema.options,
  ...MixStationSchema.options,
])
export type SubscriptionType = z.infer<typeof SubscriptionTypeSchema>
export const subscriptionTypeLabels: Record<SubscriptionType, string> = {
  youtube: 'YouTube',
  spotify: 'Podcast',
  rinse: 'Rinse FM',
  nts: 'NTS',
  lotradio: 'The Lot Radio',
}

/** The library a stored row belongs to, decided by its type. */
export const SubscriptionLibrarySchema = z.enum(['subscriptions', 'mixes'])
export type SubscriptionLibrary = z.infer<typeof SubscriptionLibrarySchema>
export const subscriptionLibraryTypes: Record<
  SubscriptionLibrary,
  readonly SubscriptionType[]
> = {
  subscriptions: SubscriptionProviderSchema.options,
  mixes: MixStationSchema.options,
}
export function subscriptionLibraryOf(
  type: SubscriptionType,
): SubscriptionLibrary {
  return MixStationSchema.safeParse(type).success ? 'mixes' : 'subscriptions'
}

export const SpotifyShowIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/)
export const SpotifyEpisodeIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/)
/**
 * `<station>.<the station's own identifier>`. The dot keeps station rows apart
 * from YouTube and Spotify identifiers, which never contain one.
 */
const MIX_ID = /^(?:rinse|nts|lotradio)\.[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
export const MixShowIdSchema = z.string().regex(MIX_ID)
export const MixIdSchema = z.string().regex(MIX_ID)
export const SubscriptionSourceIdSchema = z.union([
  YoutubeChannelIdSchema,
  SpotifyShowIdSchema,
  MixShowIdSchema,
])
export const SubscriptionItemIdSchema = z.union([
  YoutubeVideoIdSchema,
  SpotifyEpisodeIdSchema,
  MixIdSchema,
])

/** How much of `publishedAt` the provider reported: Spotify gives a day, month or year. */
export const SubscriptionPublishedPrecisionSchema = z.enum([
  'time',
  'day',
  'month',
  'year',
])
export type SubscriptionPublishedPrecision = z.infer<
  typeof SubscriptionPublishedPrecisionSchema
>

/** A station row stores its own page address; YouTube and Spotify derive theirs. */
export function subscriptionItemUrl(
  type: SubscriptionType,
  id: string,
  storedUrl: string | null = null,
) {
  if (type === 'youtube') return youtubeVideoUrl(id)
  if (type === 'spotify')
    return `https://open.spotify.com/episode/${encodeURIComponent(id)}`
  return storedUrl ?? mixStationUrls[type]
}

export function subscriptionSourceUrl(
  type: SubscriptionType,
  id: string,
  storedUrl: string | null = null,
) {
  if (type === 'youtube') return youtubeChannelUrl(id)
  if (type === 'spotify')
    return `https://open.spotify.com/show/${encodeURIComponent(id)}`
  return storedUrl ?? mixStationUrls[type]
}

export const mixStationUrls: Record<MixStation, string> = {
  rinse: 'https://www.rinse.fm',
  nts: 'https://www.nts.live',
  lotradio: 'https://www.thelotradio.com',
}

const CountSchema = z.number().int().nonnegative().nullable()

const itemShape = {
  inLibrary: z.boolean().optional(),
  sourceTitle: z.string(),
  sourceThumbnailUrl: z.string().url().nullable(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  /** UTC. A date-only release is midnight UTC with `publishedPrecision` saying so. */
  publishedAt: z.string().datetime(),
  publishedPrecision: SubscriptionPublishedPrecisionSchema,
  /** Null when unknown, such as a live stream or premiere that has not finished. */
  durationSec: z.number().int().positive().nullable(),
  url: z.string().url(),
  /** UTC. Set by the owner; null when not watched. */
  watchedAt: z.string().datetime().nullable().default(null),
}

export const YoutubeSubscriptionItemSchema = z.object({
  type: z.literal('youtube'),
  id: YoutubeVideoIdSchema,
  sourceId: YoutubeChannelIdSchema,
  ...itemShape,
  /** Counts as of the last sync that read the video; null when hidden. */
  viewCount: CountSchema,
  likeCount: CountSchema,
  commentCount: CountSchema,
  live: z.enum(['none', 'live', 'upcoming']),
})
export const SpotifySubscriptionItemSchema = z.object({
  type: z.literal('spotify'),
  id: SpotifyEpisodeIdSchema,
  sourceId: SpotifyShowIdSchema,
  ...itemShape,
  artworkUrl: z.string().url().nullable(),
})
/** A mix or show episode from a station's archive. */
export const MixSubscriptionItemSchema = z.object({
  type: MixStationSchema,
  id: MixIdSchema,
  sourceId: MixShowIdSchema,
  ...itemShape,
  artworkUrl: z.string().url().nullable(),
  /** Billed performers as the station names them; not library artist identities. */
  artists: z.array(z.string()),
  /** The recording itself: a file, a stream or its SoundCloud or Mixcloud page. */
  audioUrl: z.string().url().nullable(),
  /**
   * Library artists whose name equals a billed name or the show's name,
   * ignoring case. Filled when one mix is read; empty in pages.
   */
  libraryArtists: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .default([]),
})
/** A YouTube video, a podcast episode or a station mix. */
export const SubscriptionItemSchema = z.discriminatedUnion('type', [
  YoutubeSubscriptionItemSchema,
  SpotifySubscriptionItemSchema,
  MixSubscriptionItemSchema,
])
export type SubscriptionItem = z.infer<typeof SubscriptionItemSchema>
export const SubscriptionItemPageSchema = PaginatedDataSchema(
  SubscriptionItemSchema,
)
export type SubscriptionItemPage = z.infer<typeof SubscriptionItemPageSchema>

const sourceShape = {
  inLibrary: z.boolean().optional(),
  subscribed: z.boolean().optional(),
  title: z.string(),
  description: z.string().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  url: z.string().url(),
  /** Items stored here, which can trail the source while its history is being read. */
  storedItems: z.number().int().nonnegative(),
  latestItemAt: z.string().datetime().nullable(),
  /** Every item has been read at least once. */
  historyComplete: z.boolean(),
}
/** A subscribed YouTube channel, a saved podcast or a station show. */
export const SubscriptionSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('youtube'),
    id: YoutubeChannelIdSchema,
    ...sourceShape,
    /** `@handle`, when the channel has one. */
    handle: z.string().nullable(),
    /** Null when the channel hides its subscriber count. */
    subscriberCount: CountSchema,
  }),
  z.object({
    type: z.literal('spotify'),
    id: SpotifyShowIdSchema,
    ...sourceShape,
    /** Spotify's episode count when the show was last listed. */
    itemTotal: CountSchema,
  }),
  z.object({
    type: MixStationSchema,
    id: MixShowIdSchema,
    ...sourceShape,
    /** The station's episode count when the show was last listed, if it states one. */
    itemTotal: CountSchema,
  }),
])
export type SubscriptionSource = z.infer<typeof SubscriptionSourceSchema>
/** Selects one library; every list and count reads only rows of its types. */
export const SubscriptionLibraryQuerySchema = z.object({
  ...CatalogScopeQuerySchema.shape,
  library: SubscriptionLibrarySchema.default('subscriptions'),
})
export const SubscriptionSourceQuerySchema =
  SubscriptionLibraryQuerySchema.extend({
    /** One type of the library. */
    type: SubscriptionTypeSchema.optional(),
  }).refine(
    (query) =>
      query.type === undefined ||
      subscriptionLibraryOf(query.type) === query.library,
    { message: 'Type is not part of this library', path: ['type'] },
  )
export type SubscriptionSourceQuery = z.infer<
  typeof SubscriptionSourceQuerySchema
>
export const SubscriptionSourceListSchema = z.object({
  items: z.array(SubscriptionSourceSchema),
})
export const SubscriptionSourceParamsSchema = z.object({
  id: SubscriptionSourceIdSchema,
})
export const SubscriptionSourceDetailSchema = z.object({
  source: SubscriptionSourceSchema,
  items: SubscriptionItemPageSchema,
})
export type SubscriptionSourceDetail = z.infer<
  typeof SubscriptionSourceDetailSchema
>

/** The Subscriptions Live state values, as the duration column shows them. */
export const subscriptionLiveLabels = {
  none: 'Not live',
  live: 'Live',
  upcoming: 'Upcoming',
} as const

/** What each library calls the fields both share. */
export const subscriptionLibraryLabels: Record<
  SubscriptionLibrary,
  { source: string; type: string; watched: string; published: string }
> = {
  subscriptions: {
    source: 'Channel',
    type: 'Type',
    watched: 'Watched',
    published: 'Published',
  },
  mixes: {
    source: 'Show',
    type: 'Station',
    watched: 'Listened',
    published: 'Broadcast',
  },
}

/** The Mixes browse fields: the shared keys under their Mixes labels, with artists and without counts. */
export const mixBrowseFields: BrowseField[] = [
  { key: 'title', label: 'Title', type: 'text', filterable: true },
  { key: 'source', label: 'Show', type: 'text', filterable: true },
  { key: 'type', label: 'Station', type: 'text', filterable: true },
  { key: 'artist', label: 'Artist', type: 'text', filterable: true },
  { key: 'genre', label: 'Tags', type: 'text', filterable: true },
  { key: 'description', label: 'Description', type: 'text', filterable: false },
  { key: 'publishedAt', label: 'Broadcast', type: 'date', filterable: true },
  {
    key: 'durationSec',
    label: 'Duration',
    type: 'number',
    format: 'seconds',
    filterable: true,
  },
  { key: 'watched', label: 'Listened', type: 'text', filterable: true },
  { key: 'watchedAt', label: 'Listened', type: 'date', filterable: true },
  /** Yes when the station gives the recording itself (`audioUrl`). */
  {
    key: 'hasRecording',
    label: 'Has recording',
    type: 'text',
    filterable: true,
  },
]

export function subscriptionBrowseFieldsFor(
  library: SubscriptionLibrary,
): BrowseField[] {
  return library === 'mixes' ? mixBrowseFields : subscriptionBrowseFields
}

export const subscriptionBrowseFields: BrowseField[] = [
  { key: 'title', label: 'Title', type: 'text', filterable: true },
  { key: 'source', label: 'Channel', type: 'text', filterable: true },
  { key: 'type', label: 'Type', type: 'text', filterable: true },
  { key: 'genre', label: 'Tags', type: 'text', filterable: true },
  { key: 'description', label: 'Description', type: 'text', filterable: false },
  { key: 'publishedAt', label: 'Published', type: 'date', filterable: true },
  {
    key: 'durationSec',
    label: 'Duration',
    type: 'number',
    format: 'seconds',
    filterable: true,
  },
  /** Watched or not, as for films; `watchedAt` holds the date. */
  { key: 'watched', label: 'Watched', type: 'text', filterable: true },
  { key: 'watchedAt', label: 'Watched', type: 'date', filterable: true },
  /** A YouTube live stream or premiere; podcast episodes are never live. */
  { key: 'live', label: 'Live state', type: 'text', filterable: true },
  {
    key: 'viewCount',
    label: 'Views',
    type: 'number',
    format: 'number',
    filterable: true,
  },
  {
    key: 'likeCount',
    label: 'Likes',
    type: 'number',
    format: 'number',
    filterable: true,
  },
  {
    key: 'commentCount',
    label: 'Comments',
    type: 'number',
    format: 'number',
    filterable: true,
  },
]

function libraryField(library: SubscriptionLibrary, key: string) {
  return subscriptionBrowseFieldsFor(library).find((field) => field.key === key)
}

/** A text filter of the library: only Mixes have `artist`. */
export function subscriptionLibraryHasTextFilter(
  library: SubscriptionLibrary,
  key: string,
) {
  const field = libraryField(library, key)
  return field?.type === 'text' && field.filterable
}

/** A range of the library: Mixes have no view, like or comment counts. */
export function subscriptionLibraryHasRange(
  library: SubscriptionLibrary,
  key: string,
) {
  const field = libraryField(library, key)
  return field !== undefined && field.type !== 'text' && field.filterable
}

/** Relevance, or a sortable field the library has. */
export function subscriptionLibraryHasSort(
  library: SubscriptionLibrary,
  sortBy: string,
) {
  return sortBy === 'relevance' || libraryField(library, sortBy) !== undefined
}

/** Values in the same units as the browse filters: dates in epoch milliseconds. */
export function getSubscriptionBrowseValues(
  item: SubscriptionItem,
): BrowseValues {
  return {
    title: item.title,
    source: item.sourceTitle,
    type: subscriptionTypeLabels[item.type],
    artist: 'artists' in item ? item.artists : [],
    genre: item.tags,
    description: item.description,
    publishedAt: Date.parse(item.publishedAt),
    durationSec: item.durationSec,
    watched: item.watchedAt ? 'Yes' : 'No',
    watchedAt: item.watchedAt ? Date.parse(item.watchedAt) : null,
    live: subscriptionLiveLabels[item.type === 'youtube' ? item.live : 'none'],
    hasRecording: 'audioUrl' in item ? (item.audioUrl ? 'Yes' : 'No') : null,
    viewCount: item.type === 'youtube' ? item.viewCount : null,
    likeCount: item.type === 'youtube' ? item.likeCount : null,
    commentCount: item.type === 'youtube' ? item.commentCount : null,
  }
}

export const SubscriptionTextFieldSchema = z.enum([
  'title',
  'source',
  'type',
  'artist',
  'genre',
  'watched',
  'live',
  'hasRecording',
])
export const SubscriptionRangeFieldSchema = z.enum([
  'publishedAt',
  'durationSec',
  'watchedAt',
  'viewCount',
  'likeCount',
  'commentCount',
])
export const SubscriptionSortSchema = z.enum([
  'relevance',
  'publishedAt',
  'title',
  'source',
  'durationSec',
  'watchedAt',
  'viewCount',
  'likeCount',
  'commentCount',
])
export type SubscriptionSort = z.infer<typeof SubscriptionSortSchema>
/** Mixes have no view, like or comment counts to sort by. */
export const MixSortSchema = SubscriptionSortSchema.exclude([
  'viewCount',
  'likeCount',
  'commentCount',
])
export type MixSort = z.infer<typeof MixSortSchema>
/** `title`: item title, tags and channel name. `all`: also the description. */
export const SubscriptionSearchFieldsSchema = z.enum(['title', 'all'])
/** An inclusive UTC day, `YYYY-MM-DD`. */
export const SubscriptionDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)))

const textField = (field: string) =>
  SubscriptionTextFieldSchema.safeParse(field).success
const rangeField = (field: string) =>
  SubscriptionRangeFieldSchema.safeParse(field).success

const SubscriptionFiltersParamSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string' || value.length === 0) return []
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  },
  z
    .array(
      BrowseFilterSchema.refine((filter) => textField(filter.field), {
        message: 'Unknown text filter',
        path: ['field'],
      }),
    )
    .max(100),
)

export const SubscriptionItemQuerySchema = PaginationQuerySchema.extend({
  ...CatalogScopeQuerySchema.shape,
  /** Which library to read; a row belongs to exactly one. */
  library: SubscriptionLibrarySchema.default('subscriptions'),
  /** Restricts the query to one channel or podcast by its stored identifier. */
  sourceId: SubscriptionSourceIdSchema.optional(),
  /** Web-search syntax: every word must match by its stem or as the start of a word; "quoted phrases", `or` and `-exclusions` are supported. */
  q: z.string().trim().max(200).optional(),
  fields: SubscriptionSearchFieldsSchema.default('all'),
  /**
   * JSON `BrowseFilter[]` over title, source, type, genre, watched (`Yes` or
   * `No`), for Subscriptions only live (`Live`, `Upcoming` or `Not live`) and,
   * for Mixes only, artist and hasRecording (`Yes` or `No`).
   */
  filters: SubscriptionFiltersParamSchema,
  /**
   * JSON `BrowseRange[]`; publishedAt and watchedAt bounds are epoch
   * milliseconds. Mixes have no view, like or comment counts.
   */
  ranges: BrowseRangesParamSchema.refine(
    (ranges) => ranges.every((range) => rangeField(range.field)),
    'Unknown numeric filter',
  ),
  /** Defaults to `relevance` with a search and `publishedAt` without one. */
  sortBy: SubscriptionSortSchema.optional(),
  direction: DirectionSchema.default('desc'),
}).superRefine((query, context) => {
  for (const [index, filter] of query.filters.entries())
    if (!subscriptionLibraryHasTextFilter(query.library, filter.field))
      context.addIssue({
        code: 'custom',
        message: 'Text filter is not part of this library',
        path: ['filters', index, 'field'],
      })
  for (const [index, range] of query.ranges.entries())
    if (!subscriptionLibraryHasRange(query.library, range.field))
      context.addIssue({
        code: 'custom',
        message: 'Numeric filter is not part of this library',
        path: ['ranges', index, 'field'],
      })
  if (
    query.sortBy !== undefined &&
    !subscriptionLibraryHasSort(query.library, query.sortBy)
  )
    context.addIssue({
      code: 'custom',
      message: 'Sort is not part of this library',
      path: ['sortBy'],
    })
})
export type SubscriptionItemQuery = z.infer<typeof SubscriptionItemQuerySchema>
export type SubscriptionItemQueryInput = z.input<
  typeof SubscriptionItemQuerySchema
>

export const SubscriptionItemParamsSchema = z.object({
  id: SubscriptionItemIdSchema,
})

/** Sets an item's watched date, or clears it with null. */
export const SubscriptionItemPatchSchema = z
  .object({ watchedAt: z.string().datetime().nullable() })
  .strict()
export type SubscriptionItemPatch = z.infer<typeof SubscriptionItemPatchSchema>

/** Filter suggestions of one library. */
export const SubscriptionFacetQuerySchema = BrowseFacetQuerySchema.extend(
  SubscriptionLibraryQuerySchema.shape,
)
export type SubscriptionFacetQuery = z.infer<
  typeof SubscriptionFacetQuerySchema
>

/** A facet row: a filter with its label ("Channel: Name", "Show: Name") and whole-library count. */
export const SubscriptionFilterOptionSchema = BrowseFilterSchema.extend({
  label: z.string(),
  count: z.number().int().positive(),
})
export type SubscriptionFilterOption = z.infer<
  typeof SubscriptionFilterOptionSchema
>

export const SubscriptionSyncStateSchema = YoutubeSyncStateSchema
export const SubscriptionSyncScheduleSchema = YoutubeSyncScheduleSchema
export type SubscriptionSyncSchedule = z.infer<
  typeof SubscriptionSyncScheduleSchema
>
export const SubscriptionSyncSettingsSchema = YoutubeSyncSettingsSchema
export const SubscriptionSyncInputSchema = z.object({}).strict()
export const SubscriptionSyncParamsSchema = z.object({
  provider: SubscriptionTypeSchema,
})

export const SubscriptionAccountStatusSchema = z.object({
  /** The provider's credentials are saved in Providers. */
  configured: z.boolean(),
  connected: z.boolean(),
  redirectUri: z.string().nullable(),
})
export type SubscriptionAccountStatus = z.infer<
  typeof SubscriptionAccountStatusSchema
>

export const SubscriptionSyncStatusSchema = z.object({
  provider: SubscriptionTypeSchema,
  account: SubscriptionAccountStatusSchema,
  /** `running` covers a queued or running sync job, including the gap between chained jobs. */
  state: SubscriptionSyncStateSchema,
  /** The most recent sync job, whatever its status. */
  job: z.object({ id: z.string(), status: JobStatusSchema }).nullable(),
  schedule: SubscriptionSyncScheduleSchema,
  /** When the schedule will next queue or resume a sync; null when off, not connected or waiting on a manual sync. */
  nextScheduledAt: z.string().datetime().nullable(),
  /** The step the current or last run reached: the source list, then each source's items. */
  phase: z.enum(['sources', 'items']).nullable(),
  sourcesDone: z.number().int().nonnegative(),
  sourcesTotal: z.number().int().nonnegative(),
  newItems: z.number().int().nonnegative(),
  storedSources: z.number().int().nonnegative(),
  storedItems: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
  resumeAfter: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
})
export type SubscriptionSyncStatus = z.infer<
  typeof SubscriptionSyncStatusSchema
>
