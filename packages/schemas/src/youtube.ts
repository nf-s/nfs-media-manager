import { z } from 'zod'

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
export type YoutubeSyncSchedule = z.infer<typeof YoutubeSyncScheduleSchema>
