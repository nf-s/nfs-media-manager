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
import { TrackPlayabilitySchema } from './match-diagnostics'
import {
  MixShowIdSchema,
  MixSortSchema,
  MixStationSchema,
  SubscriptionDaySchema,
  SubscriptionProviderSchema,
  SubscriptionSearchFieldsSchema,
  SubscriptionSortSchema,
  SubscriptionSourceIdSchema,
  subscriptionTypeLabels,
  type MixStation,
  type SubscriptionSort,
} from './subscriptions'

export const AI_SEARCH_MAX_TEXT = 2000
export const AI_AUDIO_MAX_BYTES = 5 * 1024 * 1024
export const AI_AUDIO_MAX_SECONDS = 60
/** A subscription or mix plan names at most this many channels, podcasts or shows. */
export const AI_SUBSCRIPTION_MAX_SOURCES = 50

/** Libraries whose search uses the shared browse plan. */
export const AiMediaLibrarySchema = z.enum(['album', 'film', 'track', 'artist'])
export type AiMediaLibrary = z.infer<typeof AiMediaLibrarySchema>
/**
 * `subscription` searches stored videos and podcast episodes and returns an
 * `AiSubscriptionSearchResponse`; `mix` searches stored station mixes and
 * returns an `AiMixSearchResponse`.
 */
export const AiSearchLibrarySchema = z.enum([
  ...AiMediaLibrarySchema.options,
  'subscription',
  'mix',
])
export type AiSearchLibrary = z.infer<typeof AiSearchLibrarySchema>

export const AiSearchInputSchema = z
  .object({
    mediaType: AiSearchLibrarySchema,
    context: z.literal('matches').optional(),
    text: z.string().trim().min(1).max(AI_SEARCH_MAX_TEXT),
  })
  .strict()
  .refine((input) => !input.context || input.mediaType === 'track', {
    path: ['context'],
    message: 'Match filters are available in Tracks.',
  })
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
    playability: TrackPlayabilitySchema.optional(),
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

/** What Subscriptions and Mixes plans share. */
const storedItemPlanShape = {
  q: z.string().max(200),
  fields: SubscriptionSearchFieldsSchema,
  publishedFrom: SubscriptionDaySchema.nullable(),
  publishedTo: SubscriptionDaySchema.nullable(),
  /** Inclusive seconds. */
  durationMinSec: z.number().int().nonnegative().nullable(),
  durationMaxSec: z.number().int().nonnegative().nullable(),
  direction: DirectionSchema,
}
const SourceNamesSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(AI_SUBSCRIPTION_MAX_SOURCES)

const subscriptionPlanShape = {
  ...storedItemPlanShape,
  /** Empty for both types. */
  types: z.array(SubscriptionProviderSchema).max(2),
  sortBy: SubscriptionSortSchema,
}

/** The model's Subscriptions plan: sources are the names the request mentioned, resolved on the server. */
export const AiSubscriptionInterpretedPlanSchema = z
  .object({
    ...subscriptionPlanShape,
    sourceNames: SourceNamesSchema,
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
          type: SubscriptionProviderSchema,
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

/** A billed artist or a tag of a mix, as an exact filter in its mode. */
export const AiMixFilterSchema = z
  .object({
    field: z.enum(['artist', 'genre']),
    value: z.string().trim().min(1).max(200),
    mode: z.enum(['any', 'required', 'exclude']),
  })
  .strict()

const mixPlanShape = {
  ...storedItemPlanShape,
  /** Empty for every station. */
  stations: z.array(MixStationSchema).max(MixStationSchema.options.length),
  filters: z.array(AiMixFilterSchema).max(20),
  sortBy: MixSortSchema,
}

/** The model's Mixes plan: shows are the names the request mentioned, resolved on the server. */
export const AiMixInterpretedPlanSchema = z
  .object({ ...mixPlanShape, sourceNames: SourceNamesSchema })
  .strict()
export type AiMixInterpretedPlan = z.infer<typeof AiMixInterpretedPlanSchema>

export const AiMixInterpretationSchema = z
  .object({
    plan: AiMixInterpretedPlanSchema.nullable(),
    explanation: AiSearchInterpretationSchema.shape.explanation,
    assumptions: AiSearchInterpretationSchema.shape.assumptions,
  })
  .strict()

/** A Mixes plan whose show names matched stored station shows. */
export const AiMixPlanSchema = z
  .object({
    ...mixPlanShape,
    sources: z
      .array(
        z.object({
          id: MixShowIdSchema,
          type: MixStationSchema,
          title: z.string(),
        }),
      )
      .max(AI_SUBSCRIPTION_MAX_SOURCES),
  })
  .strict()
export type AiMixPlan = z.infer<typeof AiMixPlanSchema>

export const AiMixSearchResponseSchema = AiMixInterpretationSchema.extend({
  plan: AiMixPlanSchema.nullable(),
  warnings: AiSearchResponseSchema.shape.warnings,
})
export type AiMixSearchResponse = z.infer<typeof AiMixSearchResponseSchema>

type StoredItemBrowseQuery<Sort> = {
  q: string
  fields: AiSubscriptionPlan['fields']
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  sortBy: Sort
  direction: AiSubscriptionPlan['direction']
}

/** Sources form one any-of group, and days become inclusive UTC epoch millisecond bounds. */
function storedItemBrowseQuery<Sort>(
  plan: (AiSubscriptionPlan | AiMixPlan) & { sortBy: Sort },
  filters: BrowseFilter[],
): StoredItemBrowseQuery<Sort> {
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
    filters: [
      ...[...new Set(plan.sources.map((source) => source.title))].map(
        (title): BrowseFilter => ({
          field: 'source',
          value: title,
          mode: 'any',
        }),
      ),
      ...filters,
    ],
    ranges,
    sortBy: plan.sortBy,
    direction: plan.direction,
  }
}

/** The Subscriptions browse query a plan applies: a single type is required. */
export function aiSubscriptionBrowseQuery(
  plan: AiSubscriptionPlan,
): StoredItemBrowseQuery<SubscriptionSort> {
  const types = [...new Set(plan.types)]
  const [type] = types
  return storedItemBrowseQuery(
    plan,
    types.length === 1 && type
      ? [
          {
            field: 'type',
            value: subscriptionTypeLabels[type],
            mode: 'required',
          },
        ]
      : [],
  )
}

/**
 * The Mixes browse query a plan applies: a single station is required, and
 * several stations exclude the others, so the any-of group stays the shows'.
 * Artist and tag filters keep their modes.
 */
export function aiMixBrowseQuery(
  plan: AiMixPlan,
): StoredItemBrowseQuery<AiMixPlan['sortBy']> {
  const stations = new Set<MixStation>(plan.stations)
  const [station] = stations
  const others = MixStationSchema.options.filter(
    (option) => !stations.has(option),
  )
  const stationFilters: BrowseFilter[] =
    stations.size === 1 && station
      ? [
          {
            field: 'type',
            value: subscriptionTypeLabels[station],
            mode: 'required',
          },
        ]
      : stations.size
        ? others.map((other) => ({
            field: 'type',
            value: subscriptionTypeLabels[other],
            mode: 'exclude',
          }))
        : []
  return storedItemBrowseQuery(plan, [...stationFilters, ...plan.filters])
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
