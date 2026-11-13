import { z } from 'zod'
import {
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

/** Task jobs that fill the Subscriptions library. */
export const SUBSCRIPTION_SYNC_TASKS = [
  YOUTUBE_SYNC_TASK,
  SPOTIFY_PODCAST_SYNC_TASK,
] as const

/** The provider a source or item comes from; it decides the displayed type. */
export const SubscriptionTypeSchema = z.enum(['youtube', 'spotify'])
export type SubscriptionType = z.infer<typeof SubscriptionTypeSchema>
export const subscriptionTypeLabels: Record<SubscriptionType, string> = {
  youtube: 'YouTube',
  spotify: 'Podcast',
}

export const SpotifyShowIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/)
export const SpotifyEpisodeIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/)
export const SubscriptionSourceIdSchema = z.union([
  YoutubeChannelIdSchema,
  SpotifyShowIdSchema,
])
export const SubscriptionItemIdSchema = z.union([
  YoutubeVideoIdSchema,
  SpotifyEpisodeIdSchema,
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

export function subscriptionItemUrl(type: SubscriptionType, id: string) {
  return type === 'youtube'
    ? youtubeVideoUrl(id)
    : `https://open.spotify.com/episode/${encodeURIComponent(id)}`
}

export function subscriptionSourceUrl(type: SubscriptionType, id: string) {
  return type === 'youtube'
    ? youtubeChannelUrl(id)
    : `https://open.spotify.com/show/${encodeURIComponent(id)}`
}

const CountSchema = z.number().int().nonnegative().nullable()

const itemShape = {
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
/** A YouTube video or a podcast episode. */
export const SubscriptionItemSchema = z.discriminatedUnion('type', [
  YoutubeSubscriptionItemSchema,
  SpotifySubscriptionItemSchema,
])
export type SubscriptionItem = z.infer<typeof SubscriptionItemSchema>
export const SubscriptionItemPageSchema = PaginatedDataSchema(
  SubscriptionItemSchema,
)
export type SubscriptionItemPage = z.infer<typeof SubscriptionItemPageSchema>

const sourceShape = {
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
/** A subscribed YouTube channel or a saved podcast. */
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
])
export type SubscriptionSource = z.infer<typeof SubscriptionSourceSchema>
export const SubscriptionSourceQuerySchema = z.object({
  type: SubscriptionTypeSchema.optional(),
})
export const SubscriptionSourceListSchema = z.object({
  items: z.array(SubscriptionSourceSchema),
})

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

/** Values in the same units as the browse filters: dates in epoch milliseconds. */
export function getSubscriptionBrowseValues(
  item: SubscriptionItem,
): BrowseValues {
  return {
    title: item.title,
    source: item.sourceTitle,
    type: subscriptionTypeLabels[item.type],
    genre: item.tags,
    description: item.description,
    publishedAt: Date.parse(item.publishedAt),
    durationSec: item.durationSec,
    viewCount: item.type === 'youtube' ? item.viewCount : null,
    likeCount: item.type === 'youtube' ? item.likeCount : null,
    commentCount: item.type === 'youtube' ? item.commentCount : null,
  }
}

export const SubscriptionTextFieldSchema = z.enum([
  'title',
  'source',
  'type',
  'genre',
])
export const SubscriptionRangeFieldSchema = z.enum([
  'publishedAt',
  'durationSec',
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
  'viewCount',
  'likeCount',
  'commentCount',
])
export type SubscriptionSort = z.infer<typeof SubscriptionSortSchema>
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
  /** Web-search syntax: every word must match by its stem or as the start of a word; "quoted phrases", `or` and `-exclusions` are supported. */
  q: z.string().trim().max(200).optional(),
  fields: SubscriptionSearchFieldsSchema.default('all'),
  /** JSON `BrowseFilter[]` over title, source, type and genre. */
  filters: SubscriptionFiltersParamSchema,
  /** JSON `BrowseRange[]`; publishedAt bounds are epoch milliseconds. */
  ranges: BrowseRangesParamSchema.refine(
    (ranges) => ranges.every((range) => rangeField(range.field)),
    'Unknown numeric filter',
  ),
  /** Defaults to `relevance` with a search and `publishedAt` without one. */
  sortBy: SubscriptionSortSchema.optional(),
  direction: DirectionSchema.default('desc'),
})
export type SubscriptionItemQuery = z.infer<typeof SubscriptionItemQuerySchema>
export type SubscriptionItemQueryInput = z.input<
  typeof SubscriptionItemQuerySchema
>

export const SubscriptionItemParamsSchema = z.object({
  id: SubscriptionItemIdSchema,
})

/** A facet row: a filter with its label ("Channel: Name") and whole-library count. */
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
