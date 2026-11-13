import { z } from 'zod'
import { DirectionSchema, PaginatedDataSchema } from './common'
import { JobStatusSchema } from './job'

/** `scrape_job.options.task` of the account-level job that syncs subscriptions and videos. */
export const YOUTUBE_SYNC_TASK = 'youtube-subscription-sync'

/** Read-only access to the account's subscriptions. */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'

export const YoutubeChannelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/)
export const YoutubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/)

export const YoutubeAccountStatusSchema = z.object({
  /** The OAuth client and redirect URI are saved in Providers. */
  configured: z.boolean(),
  connected: z.boolean(),
  redirectUri: z.string().nullable(),
})
export const YoutubeAuthorizeInputSchema = z.object({}).strict()
export const YoutubeAuthorizeResultSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
})
export const YoutubeCallbackSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(256).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.error), {
    message: 'Expected an authorization code or denial',
  })
export const YoutubeDisconnectResultSchema = z.object({
  disconnected: z.literal(true),
})

/**
 * `paused`: the daily YouTube quota ran out; the schedule resumes the run
 * after `resumeAfter`. `stopped`: cancelled, or its worker was interrupted.
 */
export const YoutubeSyncStateSchema = z.enum([
  'never',
  'running',
  'paused',
  'stopped',
  'failed',
  'complete',
])

export const YoutubeSyncScheduleSchema = z.enum([
  'off',
  '1h',
  '3h',
  '6h',
  'daily',
  'weekly',
])
export const YoutubeSyncSettingsSchema = z
  .object({ schedule: YoutubeSyncScheduleSchema })
  .strict()
export const YoutubeSyncInputSchema = z.object({}).strict()

export const YoutubeSyncStatusSchema = z.object({
  account: YoutubeAccountStatusSchema,
  /** `running` covers a queued or running sync job, including the gap between chained jobs. */
  state: YoutubeSyncStateSchema,
  /** The most recent sync job, whatever its status. */
  job: z
    .object({ id: z.string(), status: JobStatusSchema })
    .nullable()
    .default(null),
  schedule: YoutubeSyncScheduleSchema,
  /** When the schedule will next queue or resume a sync; null when off, not connected or waiting on a manual sync. */
  nextScheduledAt: z.string().datetime().nullable(),
  /** The step the current or last run reached. */
  phase: z.enum(['subscriptions', 'videos']).nullable(),
  channelsDone: z.number().int().nonnegative(),
  channelsTotal: z.number().int().nonnegative(),
  newVideos: z.number().int().nonnegative(),
  storedChannels: z.number().int().nonnegative(),
  storedVideos: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
  resumeAfter: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
})

export const YoutubeChannelSchema = z.object({
  id: YoutubeChannelIdSchema,
  title: z.string(),
  /** `@handle`, when the channel has one. */
  handle: z.string().nullable(),
  description: z.string().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  /** Null when the channel hides its subscriber count. */
  subscriberCount: z.number().int().nonnegative().nullable(),
  /** Videos stored here, which can trail the channel while its history is being read. */
  storedVideos: z.number().int().nonnegative(),
  latestVideoAt: z.string().datetime().nullable(),
  /** Every upload has been read at least once. */
  historyComplete: z.boolean(),
})
export const YoutubeChannelListSchema = z.object({
  items: z.array(YoutubeChannelSchema),
})

export const YoutubeVideoSortSchema = z.enum([
  'relevance',
  'publishedAt',
  'viewCount',
  'durationSec',
])
/** `title`: video title, tags and channel name. `all`: also the description. */
export const YoutubeSearchFieldsSchema = z.enum(['title', 'all'])
/** YouTube's own duration buckets: under 4 minutes, 4 to 20 minutes, over 20 minutes. */
export const YoutubeDurationSchema = z.enum(['short', 'medium', 'long'])
const DaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)))

export const YOUTUBE_VIDEO_PAGE_SIZE = 48

const channelIds = z
  .union([YoutubeChannelIdSchema, z.array(YoutubeChannelIdSchema).max(50)])
  .transform((value) => (Array.isArray(value) ? value : [value]))

export const YoutubeVideoQuerySchema = z.object({
  /** Web-search syntax: every word must match; "quoted phrases", `or` and `-exclusions` are supported. */
  q: z.string().trim().max(200).optional(),
  fields: YoutubeSearchFieldsSchema.default('all'),
  /** Repeat the parameter to search several channels. */
  channelId: channelIds.optional(),
  duration: YoutubeDurationSchema.optional(),
  /** Inclusive UTC days. */
  publishedFrom: DaySchema.optional(),
  publishedTo: DaySchema.optional(),
  /** Defaults to `relevance` with a search and `publishedAt` without one. */
  sortBy: YoutubeVideoSortSchema.optional(),
  sortDirection: DirectionSchema.default('desc'),
  page: z.coerce.number().int().positive().max(10000).default(1),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(YOUTUBE_VIDEO_PAGE_SIZE),
})

export const YoutubeVideoSchema = z.object({
  id: YoutubeVideoIdSchema,
  channelId: YoutubeChannelIdSchema,
  channelTitle: z.string(),
  channelThumbnailUrl: z.string().url().nullable(),
  title: z.string(),
  description: z.string(),
  publishedAt: z.string().datetime(),
  /** Zero for a live stream or premiere that has not finished. */
  durationSec: z.number().int().nonnegative(),
  /** Counts as of the last sync that read the video; null when hidden. */
  viewCount: z.number().int().nonnegative().nullable(),
  likeCount: z.number().int().nonnegative().nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  live: z.enum(['none', 'live', 'upcoming']),
})
export const YoutubeVideoPageSchema = PaginatedDataSchema(YoutubeVideoSchema)

export function youtubeVideoUrl(id: string) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
}

export function youtubeChannelUrl(id: string) {
  return `https://www.youtube.com/channel/${encodeURIComponent(id)}`
}

/** 320×180 still; every public video has one. */
export function youtubeThumbnailUrl(id: string) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`
}

export type YoutubeAccountStatus = z.infer<typeof YoutubeAccountStatusSchema>
export type YoutubeSyncStatus = z.infer<typeof YoutubeSyncStatusSchema>
export type YoutubeSyncSchedule = z.infer<typeof YoutubeSyncScheduleSchema>
export type YoutubeChannel = z.infer<typeof YoutubeChannelSchema>
export type YoutubeVideo = z.infer<typeof YoutubeVideoSchema>
export type YoutubeVideoPage = z.infer<typeof YoutubeVideoPageSchema>
export type YoutubeVideoQuery = z.infer<typeof YoutubeVideoQuerySchema>
export type YoutubeVideoQueryInput = z.input<typeof YoutubeVideoQuerySchema>
export type YoutubeVideoSort = z.infer<typeof YoutubeVideoSortSchema>
export type YoutubeDuration = z.infer<typeof YoutubeDurationSchema>
