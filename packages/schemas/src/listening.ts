import { z } from 'zod'

export const ListeningPeriodSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({
      kind: z.literal('rolling'),
      amount: z.number().int().min(1).max(1000),
      unit: z.enum(['days', 'weeks', 'months', 'years']),
    }),
    z.object({
      kind: z.literal('dates'),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
    }),
  ])
  .refine(
    (period) =>
      period.kind !== 'dates' ||
      period.from !== undefined ||
      period.to !== undefined,
    'Choose a start or end date',
  )
  .refine(
    (period) =>
      period.kind !== 'dates' ||
      period.from === undefined ||
      period.to === undefined ||
      period.from <= period.to,
    'Start date must not follow end date',
  )

export type ListeningPeriod = z.infer<typeof ListeningPeriodSchema>

export const defaultListeningPeriod: ListeningPeriod = {
  kind: 'rolling',
  amount: 1,
  unit: 'years',
}

export const ListeningRuleSchema = z
  .object({
    period: ListeningPeriodSchema,
    min: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    max: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine(
    (rule) => rule.min !== undefined || rule.max !== undefined,
    'Choose a minimum or maximum scrobble count',
  )
  .refine(
    (rule) =>
      rule.min === undefined || rule.max === undefined || rule.min <= rule.max,
    'Minimum must not exceed maximum',
  )

export type ListeningRule = z.infer<typeof ListeningRuleSchema>

export const ListeningFilterSchema = z.object({
  match: z.enum(['all', 'any']),
  rules: z.array(ListeningRuleSchema).max(10),
})

export type ListeningFilter = z.infer<typeof ListeningFilterSchema>

function parseOptionalJson(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const ListeningFilterParamSchema = z.preprocess(
  parseOptionalJson,
  ListeningFilterSchema.optional(),
)
export const ListeningPeriodParamSchema = z.preprocess(
  parseOptionalJson,
  ListeningPeriodSchema.optional(),
)
