import { z } from 'zod'
import { BrowseFieldSchema } from './browse'
import { DirectionSchema, MediaTypeSchema } from './common'

const key = BrowseFieldSchema.shape.key
const integer = z.number().int().nonnegative()
const weight = z.number().min(0).max(3).multipleOf(0.5)
const year = z.number().int().min(1).max(9999)
const adjusted = z.number().min(0).max(100).nullable()
const groups = z.enum(['audience', 'critics', 'personal', 'other'])

const sourceSetting = z.strictObject({
  key,
  weight,
  minVotes: integer.max(2_147_483_647),
})

export const RatingsSettingsSchema = z.strictObject({
  normalization: z
    .enum(['percentile', 'standardized', 'scale'])
    .default('percentile'),
  combine: z.enum(['mean', 'median', 'trimmed']).default('mean'),
  minSources: z.number().int().min(1).max(64).default(2),
  missingWeight: z
    .union([z.literal(0), z.literal(0.5), z.literal(1)])
    .default(0.5),
  outlierDistance: z.number().int().min(5).max(90).nullable().default(null),
  sources: z
    .array(sourceSetting)
    .max(64)
    .refine(
      (sources) =>
        new Set(sources.map((source) => source.key)).size === sources.length,
      'Each rating source can have one setting',
    )
    .default([]),
})
export type RatingsSettings = z.infer<typeof RatingsSettingsSchema>

const dimension = z
  .string()
  .max(127)
  .regex(/^(score|spread|counted|native\.[a-zA-Z][a-zA-Z0-9_.-]*)$/)
const binIndex = z.number().int().min(0).max(4)
const range = z
  .strictObject({
    dimension,
    first: binIndex,
    last: binIndex,
  })
  .refine(
    ({ first, last }) => first <= last,
    'End bin must follow the start bin',
  )
export type RatingsRange = z.infer<typeof range>

export const RatingsSourcesRequestSchema = z
  .strictObject({
    library: MediaTypeSchema,
    search: z.string().trim().max(200).default(''),
    tag: z.string().trim().max(200).default(''),
    yearFrom: year.optional(),
    yearTo: year.optional(),
    watched: z.boolean().optional(),
    minPlays: integer.max(2_147_483_647).optional(),
    scoredOnly: z.boolean().default(true),
    ranges: z
      .array(range)
      .max(67)
      .refine(
        (ranges) =>
          new Set(ranges.map((r) => r.dimension)).size === ranges.length,
        'Each histogram can have one range',
      )
      .default([]),
    settings: RatingsSettingsSchema.prefault({}),
  })
  .superRefine((request, ctx) => {
    if (
      request.yearFrom !== undefined &&
      request.yearTo !== undefined &&
      request.yearFrom > request.yearTo
    )
      ctx.addIssue({
        code: 'custom',
        path: ['yearTo'],
        message: 'End year must be at or after the start year',
      })
    if (request.library === 'album' && request.watched !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['watched'],
        message: 'Only films have a watched filter',
      })
    if (request.library === 'film' && request.minPlays !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['minPlays'],
        message: 'Only albums have a play count filter',
      })
  })
export type RatingsSourcesRequest = z.infer<typeof RatingsSourcesRequestSchema>
export const RatingsRankingRequestSchema =
  RatingsSourcesRequestSchema.safeExtend({
    offset: integer.max(2_147_483_647).default(0),
    limit: z.number().int().min(1).max(100).default(40),
    sort: key.default('score'),
    direction: DirectionSchema.default('desc'),
  })
export type RatingsRankingRequest = z.infer<typeof RatingsRankingRequestSchema>
export function defaultRatingsRankingRequest(
  library: RatingsRankingRequest['library'],
): RatingsRankingRequest {
  return RatingsRankingRequestSchema.parse({ library })
}

export const RatingsSourceSchema = z.object({
  key,
  label: z.string().min(1),
  scale: z.number().positive(),
  hasVotes: z.boolean(),
  votesKey: key.optional(),
  group: groups,
})
export type RatingsSource = z.infer<typeof RatingsSourceSchema>

export const RatingsSourcesPageSchema = z.object({
  sources: z.array(RatingsSourceSchema).max(64),
  total: integer,
  coverage: z
    .array(z.object({ key, recorded: integer, eligible: integer }))
    .max(64),
  histograms: z
    .array(
      z.object({
        dimension,
        bins: z
          .array(
            z.object({
              lower: z.number().nonnegative(),
              upper: z.number().nonnegative(),
              upperInclusive: z.boolean(),
              count: integer,
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .max(67),
})
export type RatingsSourcesPage = z.infer<typeof RatingsSourcesPageSchema>

export const RatingsObservationSchema = z.object({
  key,
  raw: z.number().nonnegative().nullable(),
  adjusted,
  votes: integer.nullable(),
  center: adjusted,
  status: z.enum([
    'counted',
    'missing',
    'disabled',
    'votes',
    'outlier',
    'trimmed',
  ]),
})
export type RatingsObservation = z.infer<typeof RatingsObservationSchema>

export const RatingsRankingRowSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  year: z.number().int().nullable(),
  score: adjusted,
  spread: z.number().nonnegative().nullable(),
  criticGap: z.number().nullable(),
  personalGap: z.number().nullable(),
  counted: integer,
  ratings: z.array(RatingsObservationSchema),
  core: adjusted,
  observedWeight: z.number().nonnegative(),
  missingWeight: z.number().nonnegative(),
  missingSum: z.number().nonnegative(),
})
export type RatingsRankingRow = z.infer<typeof RatingsRankingRowSchema>

export const RatingsRankingPageSchema = z.object({
  sources: z.array(RatingsSourceSchema),
  total: integer,
  rows: z.array(RatingsRankingRowSchema).max(100),
})
export type RatingsRankingPage = z.infer<typeof RatingsRankingPageSchema>
