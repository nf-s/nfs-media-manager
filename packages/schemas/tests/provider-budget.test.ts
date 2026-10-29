import { describe, expect, it } from 'vitest'
import { ProviderRequestBudgetSchema } from '../src/provider'

describe('provider request budget', () => {
  it('accepts configurable hourly and UTC daily caps', () => {
    for (const period of ['hour', 'day'])
      expect(
        ProviderRequestBudgetSchema.parse({ period, limit: 1000 }),
      ).toEqual({ period, limit: 1000 })
  })
  it('rejects missing, invalid and unbounded limits', () => {
    for (const input of [
      {},
      { period: 'week', limit: 1000 },
      ...[0, -1, 0.5, 100001, '1000', Infinity].map((limit) => ({
        period: 'day',
        limit,
      })),
    ])
      expect(ProviderRequestBudgetSchema.safeParse(input).success).toBe(false)
  })
})
