import { z } from 'zod'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowseRangeSchema,
  type BrowseFilter,
  type BrowseRange,
} from './browse'
import { DirectionSchema } from './common'
import { ListeningFilterSchema, ListeningPeriodSchema } from './listening'
import {
  SubscriptionDaySchema,
  SubscriptionSearchFieldsSchema,
  SubscriptionSortSchema,
  SubscriptionSourceIdSchema,
  SubscriptionTypeSchema,
  subscriptionTypeLabels,
  type SubscriptionSort,
} from './subscriptions'

export const AI_SEARCH_MAX_TEXT = 2000
export const AI_AUDIO_MAX_BYTES = 5 * 1024 * 1024
export const AI_AUDIO_MAX_SECONDS = 60
/** A subscription plan names at most this many channels and podcasts. */
export const AI_SUBSCRIPTION_MAX_SOURCES = 50

/** Libraries whose search is a media-item browse plan. */
export const AiMediaLibrarySchema = z.enum(['album', 'film', 'track'])
export type AiMediaLibrary = z.infer<typeof AiMediaLibrarySchema>
/**
 * `subscription` searches stored videos and podcast episodes and returns an
 * `AiSubscriptionSearchResponse`.
 */
export const AiSearchLibrarySchema = z.enum([
  ...AiMediaLibrarySchema.options,
  'subscription',
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

const subscriptionPlanShape = {
  q: z.string().max(200),
  fields: SubscriptionSearchFieldsSchema,
  /** Empty for both types. */
  types: z.array(SubscriptionTypeSchema).max(2),
  publishedFrom: SubscriptionDaySchema.nullable(),
  publishedTo: SubscriptionDaySchema.nullable(),
  /** Inclusive seconds. */
  durationMinSec: z.number().int().nonnegative().nullable(),
  durationMaxSec: z.number().int().nonnegative().nullable(),
  sortBy: SubscriptionSortSchema,
  direction: DirectionSchema,
}

/** The model's Subscriptions plan: sources are the names the request mentioned, resolved on the server. */
export const AiSubscriptionInterpretedPlanSchema = z
  .object({
    ...subscriptionPlanShape,
    sourceNames: z
      .array(z.string().trim().min(1).max(100))
      .max(AI_SUBSCRIPTION_MAX_SOURCES),
  })
  .strict()
export type AiSubscriptionInterpretedPlan = z.infer<
  typeof AiSubscriptionInterpretedPlanSchema
>

export const AiSubscriptionInterpretationSchema = z
  .object({
    plan: AiSubscriptionInterpretedPlanSchema.nullable(),
    explanation: AiSearchInterpretationSchema.shape.explanation,
    assumptions: AiSearchInterpretationSchema.shape.assumptions,
  })
  .strict()

/** A Subscriptions plan whose source names matched stored subscribed channels or podcasts. */
export const AiSubscriptionPlanSchema = z
  .object({
    ...subscriptionPlanShape,
    sources: z
      .array(
        z.object({
          id: SubscriptionSourceIdSchema,
          type: SubscriptionTypeSchema,
          title: z.string(),
        }),
      )
      .max(AI_SUBSCRIPTION_MAX_SOURCES),
  })
  .strict()
export type AiSubscriptionPlan = z.infer<typeof AiSubscriptionPlanSchema>

export const AiSubscriptionSearchResponseSchema =
  AiSubscriptionInterpretationSchema.extend({
    plan: AiSubscriptionPlanSchema.nullable(),
    warnings: AiSearchResponseSchema.shape.warnings,
  })
export type AiSubscriptionSearchResponse = z.infer<
  typeof AiSubscriptionSearchResponseSchema
>

/**
 * The Subscriptions browse query a plan applies: sources form one any-of
 * group, a single type is required, and days become inclusive UTC epoch
 * millisecond bounds.
 */
export function aiSubscriptionBrowseQuery(plan: AiSubscriptionPlan): {
  q: string
  fields: AiSubscriptionPlan['fields']
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  sortBy: SubscriptionSort
  direction: AiSubscriptionPlan['direction']
} {
  const types = [...new Set(plan.types)]
  const [type] = types
  const filters: BrowseFilter[] = [
    ...new Set(plan.sources.map((source) => source.title)),
  ].map((title) => ({ field: 'source', value: title, mode: 'any' }))
  if (types.length === 1 && type)
    filters.push({
      field: 'type',
      value: subscriptionTypeLabels[type],
      mode: 'required',
    })
  const ranges: BrowseRange[] = []
  if (plan.publishedFrom || plan.publishedTo)
    ranges.push({
      field: 'publishedAt',
      ...(plan.publishedFrom
        ? { min: Date.parse(`${plan.publishedFrom}T00:00:00.000Z`) }
        : {}),
      ...(plan.publishedTo
        ? { max: Date.parse(`${plan.publishedTo}T23:59:59.999Z`) }
        : {}),
      includeMissing: false,
    })
  if (plan.durationMinSec !== null || plan.durationMaxSec !== null)
    ranges.push({
      field: 'durationSec',
      ...(plan.durationMinSec === null ? {} : { min: plan.durationMinSec }),
      ...(plan.durationMaxSec === null ? {} : { max: plan.durationMaxSec }),
      includeMissing: false,
    })
  return {
    q: plan.q,
    fields: plan.fields,
    filters,
    ranges,
    sortBy: plan.sortBy,
    direction: plan.direction,
  }
}

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
