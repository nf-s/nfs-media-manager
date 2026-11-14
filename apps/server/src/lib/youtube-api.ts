import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import {
  YOUTUBE_SCOPE,
  YoutubeChannelIdSchema,
  YoutubeVideoIdSchema,
} from '@repo/schemas/youtube'

export type YoutubeRequest = MediaPluginTestContext['request']

/** The API's largest page for every list call used here. */
export const YOUTUBE_PAGE_SIZE = 50

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(86400),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})

const ThumbnailsSchema = z
  .record(z.string(), z.object({ url: z.string().url() }))
  .optional()
const PageSchema = z.object({ nextPageToken: z.string().min(1).optional() })
const CountSchema = z.coerce.number().int().nonnegative()

export const YoutubeSubscriptionPageSchema = PageSchema.extend({
  items: z
    .array(
      z.object({
        snippet: z.object({
          title: z.string(),
          description: z.string().optional(),
          resourceId: z.object({ channelId: YoutubeChannelIdSchema }),
          thumbnails: ThumbnailsSchema,
        }),
      }),
    )
    .max(YOUTUBE_PAGE_SIZE)
    .default([]),
})

export const YoutubeChannelPageSchema = z.object({
  items: z
    .array(
      z.object({
        id: YoutubeChannelIdSchema,
        snippet: z.object({
          title: z.string(),
          description: z.string().optional(),
          customUrl: z.string().optional(),
          thumbnails: ThumbnailsSchema,
        }),
        statistics: z
          .object({
            subscriberCount: CountSchema.optional(),
            hiddenSubscriberCount: z.boolean().optional(),
            videoCount: CountSchema.optional(),
          })
          .optional(),
        contentDetails: z
          .object({
            relatedPlaylists: z.object({ uploads: z.string().optional() }),
          })
          .optional(),
      }),
    )
    .max(YOUTUBE_PAGE_SIZE)
    .default([]),
})

export const YoutubeUploadPageSchema = PageSchema.extend({
  items: z
    .array(
      z.object({
        contentDetails: z.object({ videoId: YoutubeVideoIdSchema }),
      }),
    )
    .max(YOUTUBE_PAGE_SIZE)
    .default([]),
})

export const YoutubeVideoListSchema = z.object({
  items: z
    .array(
      z.object({
        id: YoutubeVideoIdSchema,
        snippet: z.object({
          channelId: YoutubeChannelIdSchema,
          title: z.string(),
          description: z.string().default(''),
          publishedAt: z.string().datetime({ offset: true }),
          tags: z.array(z.string()).default([]),
          liveBroadcastContent: z
            .enum(['none', 'live', 'upcoming'])
            .catch('none'),
        }),
        contentDetails: z.object({ duration: z.string().optional() }),
        statistics: z
          .object({
            viewCount: CountSchema.optional(),
            likeCount: CountSchema.optional(),
            commentCount: CountSchema.optional(),
          })
          .optional(),
      }),
    )
    .max(YOUTUBE_PAGE_SIZE)
    .default([]),
})

/** The smallest thumbnail is enough for a channel avatar. */
export function youtubeThumbnail(
  thumbnails: z.infer<typeof ThumbnailsSchema>,
): string | null {
  return (
    thumbnails?.['default']?.url ??
    thumbnails?.['medium']?.url ??
    thumbnails?.['high']?.url ??
    null
  )
}

/** Seconds in an ISO 8601 duration such as `PT1H2M3S`; zero when absent or unreadable. */
export function youtubeDurationSeconds(value: string | undefined): number {
  const match =
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value ?? '',
    )
  if (!match) return 0
  const [weeks, days, hours, minutes, seconds] = match
    .slice(1)
    .map((part) => Number(part ?? 0))
  return (
    (weeks ?? 0) * 604800 +
    (days ?? 0) * 86400 +
    (hours ?? 0) * 3600 +
    (minutes ?? 0) * 60 +
    (seconds ?? 0)
  )
}

export function youtubeRedirectUri(value: string): string {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/api/v1/youtube/callback'
  ) {
    throw new Error(
      'Use the exact HTTPS YouTube callback URI (HTTP only on localhost)',
    )
  }
  return url.toString()
}

export function youtubeAuthorization(clientId: string, redirectUri: string) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: youtubeRedirectUri(redirectUri),
    scope: YOUTUBE_SCOPE,
    state,
    // A refresh token is only issued for offline access with a consent prompt.
    access_type: 'offline',
    prompt: 'consent',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString()
  return { state, verifier, url: url.toString() }
}

export async function youtubeToken(
  request: YoutubeRequest,
  body: URLSearchParams,
) {
  const response = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok)
    throw new Error(`Google token request failed (HTTP ${response.status})`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Google returned an invalid token response')
  }
  const parsed = TokenSchema.safeParse(payload)
  if (!parsed.success)
    throw new Error('Google returned an invalid token response')
  return parsed.data
}

export async function youtubeJson(
  request: YoutubeRequest,
  token: string,
  path: 'subscriptions' | 'channels' | 'playlistItems' | 'videos',
  params: Record<string, string>,
  options?: { notFoundOn404?: boolean },
): Promise<unknown> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`)
  url.search = new URLSearchParams(params).toString()
  const response = await request(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    options,
  )
  if (!response.ok)
    throw new Error(`YouTube request failed (HTTP ${response.status})`)
  return response.json()
}
