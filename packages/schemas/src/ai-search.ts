import { z } from 'zod'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowseRangeSchema,
} from './browse'
import { DirectionSchema } from './common'
import { ListeningFilterSchema, ListeningPeriodSchema } from './listening'
import {
  YoutubeChannelIdSchema,
  YoutubeDurationSchema,
  YoutubeSearchFieldsSchema,
  YoutubeVideoQuerySchema,
  YoutubeVideoSortSchema,
} from './youtube'

export const AI_SEARCH_MAX_TEXT = 2000
export const AI_AUDIO_MAX_BYTES = 5 * 1024 * 1024
export const AI_AUDIO_MAX_SECONDS = 60
/** The Videos page searches at most this many channels at once. */
export const AI_YOUTUBE_MAX_CHANNELS = 50

/** Libraries whose search is a media-item browse plan. */
export const AiMediaLibrarySchema = z.enum(['album', 'film', 'track'])
export type AiMediaLibrary = z.infer<typeof AiMediaLibrarySchema>
/** `youtube` searches stored YouTube videos and returns an `AiYoutubeSearchResponse`. */
export const AiSearchLibrarySchema = z.enum([
  ...AiMediaLibrarySchema.options,
  'youtube',
])
export type AiSearchLibrary = z.infer<typeof AiSearchLibrarySchema>

export const AiSearchInputSchema = z
  .object({
    mediaType: AiSearchLibrarySchema,
    text: z.string().trim().min(1).max(AI_SEARCH_MAX_TEXT),
  })
  .strict()
export type AiSearchInput = z.infer<typeof AiSearchInputSchema>

export const AiSearchPlanSchema = z
  .object({
    q: z.string().max(200),
    filters: z.array(BrowseFilterSchema.strict()).max(20),
    ranges: z.array(BrowseRangeSchema).max(20),
    sortBy: BrowseKeySchema,
    direction: z.enum(['asc', 'desc']),
    limitResults: z.number().int().min(1).max(10000).nullable(),
    listening: ListeningFilterSchema.nullable(),
    listeningSort: ListeningPeriodSchema.nullable(),
  })
  .strict()
export type AiSearchPlan = z.infer<typeof AiSearchPlanSchema>

export const AiSearchInterpretationSchema = z
  .object({
    plan: AiSearchPlanSchema.nullable(),
    explanation: z.string().trim().min(1).max(1000),
    assumptions: z.array(z.string().trim().min(1).max(400)).max(10),
  })
  .strict()

export const AiSearchResponseSchema = AiSearchInterpretationSchema.extend({
  warnings: z.array(z.string().max(400)).max(10),
})
export type AiSearchResponse = z.infer<typeof AiSearchResponseSchema>

const youtubeDay = YoutubeVideoQuerySchema.shape.publishedFrom.unwrap()
const youtubePlanShape = {
  q: z.string().max(200),
  fields: YoutubeSearchFieldsSchema,
  duration: YoutubeDurationSchema.nullable(),
  publishedFrom: youtubeDay.nullable(),
  publishedTo: youtubeDay.nullable(),
  sortBy: YoutubeVideoSortSchema,
  sortDirection: DirectionSchema,
}

/** The model's YouTube plan: channels are the names the request mentioned, resolved on the server. */
export const AiYoutubeInterpretedPlanSchema = z
  .object({
    ...youtubePlanShape,
    channelNames: z
      .array(z.string().trim().min(1).max(100))
      .max(AI_YOUTUBE_MAX_CHANNELS),
  })
  .strict()
export type AiYoutubeInterpretedPlan = z.infer<
  typeof AiYoutubeInterpretedPlanSchema
>

export const AiYoutubeInterpretationSchema = z
  .object({
    plan: AiYoutubeInterpretedPlanSchema.nullable(),
    explanation: AiSearchInterpretationSchema.shape.explanation,
    assumptions: AiSearchInterpretationSchema.shape.assumptions,
  })
  .strict()

/** A YouTube plan whose channel names matched stored subscribed channels. */
export const AiYoutubePlanSchema = z
  .object({
    ...youtubePlanShape,
    channels: z
      .array(z.object({ id: YoutubeChannelIdSchema, title: z.string() }))
      .max(AI_YOUTUBE_MAX_CHANNELS),
  })
  .strict()
export type AiYoutubePlan = z.infer<typeof AiYoutubePlanSchema>

export const AiYoutubeSearchResponseSchema =
  AiYoutubeInterpretationSchema.extend({
    plan: AiYoutubePlanSchema.nullable(),
    warnings: AiSearchResponseSchema.shape.warnings,
  })
export type AiYoutubeSearchResponse = z.infer<
  typeof AiYoutubeSearchResponseSchema
>

export const AiStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
})

export const AiTranscriptionInputSchema = z
  .object({
    audio: z
      .string()
      .min(4)
      .max(4 * Math.ceil(AI_AUDIO_MAX_BYTES / 3))
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((value) => value.length % 4 === 0, 'Invalid audio encoding'),
    mimeType: z
      .string()
      .max(100)
      .regex(
        /^audio\/(?:webm|mp4|ogg|wav|mpeg)(?:;\s*codecs=[a-zA-Z0-9., -]+)?$/,
      ),
  })
  .strict()
export type AiTranscriptionInput = z.infer<typeof AiTranscriptionInputSchema>
export const AiTranscriptionSchema = z.object({
  text: z.string().trim().min(1).max(AI_SEARCH_MAX_TEXT),
})
