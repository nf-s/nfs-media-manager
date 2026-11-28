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

/**
 * The lowest scrobble count of each bar of a library's listening histogram.
 * A bar ends one below the next bar's edge; the last bar is open-ended.
 */
export const listeningHistogramEdges = {
  album: [0, 1, 5, 10, 20, 50, 100, 200],
  track: [0, 1, 2, 5, 10, 20, 50, 100],
  artist: [0, 1, 10, 50, 100, 200, 500, 1000],
} as const satisfies Record<string, readonly number[]>
export type ListeningLibrary = keyof typeof listeningHistogramEdges

/** The period a listening histogram counts over, as a serialized query value. */
export const ListeningHistogramPeriodParamSchema = z.preprocess(
  parseOptionalJson,
  ListeningPeriodSchema,
)

/**
 * How many of a browse query's items have each number of scrobbles in a
 * period. The query's own listening rules are left out, so the bars show what
 * a rule would choose from.
 */
export const ListeningHistogramSchema = z
  .object({
    edges: z.array(z.number().int().nonnegative()).min(1),
    counts: z.array(z.number().int().nonnegative()),
  })
  .refine(
    (histogram) => histogram.edges.length === histogram.counts.length,
    'Each bar needs a count',
  )
export type ListeningHistogram = z.infer<typeof ListeningHistogramSchema>

/**
 * The instants a listening period covers: `from` inclusive; `to` inclusive
 * for a rolling period, which ends `now`, and exclusive for a date period,
 * which ends after its last UTC day. Calendar subtraction preserves UTC time
 * and clamps month ends.
 */
export function listeningPeriodBounds(
  period: ListeningPeriod,
  now: Date,
): { from?: Date; to?: Date; inclusiveTo?: boolean } {
  if (period.kind === 'all') return {}
  if (period.kind === 'dates') {
    return {
      from: period.from ? new Date(`${period.from}T00:00:00.000Z`) : undefined,
      to: period.to
        ? new Date(Date.parse(`${period.to}T00:00:00.000Z`) + 86_400_000)
        : undefined,
      inclusiveTo: false,
    }
  }
  const from = new Date(now)
  if (period.unit === 'days' || period.unit === 'weeks') {
    from.setUTCDate(
      from.getUTCDate() - period.amount * (period.unit === 'weeks' ? 7 : 1),
    )
  } else {
    const day = from.getUTCDate()
    from.setUTCDate(1)
    from.setUTCMonth(
      from.getUTCMonth() - period.amount * (period.unit === 'years' ? 12 : 1),
    )
    const monthEnd = new Date(from)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
    from.setUTCDate(Math.min(day, monthEnd.getUTCDate()))
  }
  return { from, to: now, inclusiveTo: true }
}

/** UTC calendar months as `YYYY-MM`, oldest first, from `from` to the month of `now`. */
export function monthKeys(from: string, now: Date) {
  const [year = NaN, month = NaN] = from.split('-').map(Number)
  const count =
    (now.getUTCFullYear() - year) * 12 + now.getUTCMonth() - (month - 1) + 1
  return Array.from({ length: Math.max(1, count) }, (_, index) =>
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index + 1 - count, 1),
    )
      .toISOString()
      .slice(0, 7),
  )
}
