import { z } from 'zod'
import { BrowseFieldSchema } from './browse'
import {
  RatingsRankingRowSchema,
  RatingsSourceSchema,
  RatingsSourcesRequestSchema,
} from './ratings-explorer'

const key = BrowseFieldSchema.shape.key
const id = z.string().min(1)
const count = z.number().int().nonnegative()
const numberOrNull = z.number().nullable()
const correlation = z.number().min(-1).max(1).nullable()
const sources = z.array(RatingsSourceSchema).max(64)

const leaders = z
  .array(
    z.object({
      id,
      title: z.string(),
      score: numberOrNull,
      value: z.number(),
    }),
  )
  .max(8)

export const RatingsAgreementPageSchema = z.object({
  sources,
  libraryTotal: count,
  total: count,
  pairs: z.array(z.object({ x: key, y: key, count, correlation })).max(2016),
  bias: z
    .array(
      z.object({
        key,
        items: count,
        runs: numberOrNull,
        strays: numberOrNull,
        furthest: z.number().min(0).max(1).nullable(),
      }),
    )
    .max(64),
  lists: z.object({
    divided: leaders,
    criticsHigher: leaders,
    audiencesHigher: leaders,
    personalHigher: leaders,
    personalLower: leaders,
  }),
})
export type RatingsAgreementPage = z.infer<typeof RatingsAgreementPageSchema>

export const RatingsCompareRequestSchema =
  RatingsSourcesRequestSchema.safeExtend({
    x: key.optional(),
    y: key.optional(),
  })
export type RatingsCompareRequest = z.infer<typeof RatingsCompareRequestSchema>

export const RatingsComparePointSchema = z.object({
  id,
  title: z.string(),
  year: z.number().int().nullable(),
  x: z.number(),
  y: z.number(),
  xRaw: numberOrNull,
  yRaw: numberOrNull,
})
export type RatingsComparePoint = z.infer<typeof RatingsComparePointSchema>
export const ratingsPointLimit = 512
export const RatingsComparePageSchema = z.object({
  sources,
  libraryTotal: count,
  total: count,
  x: key,
  y: key,
  count,
  correlation,
  meanGap: numberOrNull,
  xMin: numberOrNull,
  xMax: numberOrNull,
  yMin: numberOrNull,
  yMax: numberOrNull,
  points: z.array(RatingsComparePointSchema).max(ratingsPointLimit),
  yHigher: z.array(RatingsComparePointSchema).max(8),
  xHigher: z.array(RatingsComparePointSchema).max(8),
})
export type RatingsComparePage = z.infer<typeof RatingsComparePageSchema>

export const RatingsCalculationRequestSchema =
  RatingsSourcesRequestSchema.safeExtend({
    id: id.max(512),
  })
export const RatingsCalculationSchema = RatingsRankingRowSchema.nullable()
