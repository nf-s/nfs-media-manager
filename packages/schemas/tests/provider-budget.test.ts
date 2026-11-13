import { describe, expect, it } from 'vitest'
import {
  ProviderRequestBudgetSchema,
  ProviderSummarySchema,
} from '../src/provider'

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

describe('provider summary', () => {
  const summary = {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    surface: 'provider',
    mediaTypes: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    supportsScrape: false,
    supportsLegacyImport: false,
    secrets: [],
    pluginPath: null,
  }
  it('marks Subscriptions providers and defaults to other libraries', () => {
    expect(ProviderSummarySchema.parse(summary).subscriptions).toBe(false)
    expect(
      ProviderSummarySchema.parse({ ...summary, subscriptions: true })
        .subscriptions,
    ).toBe(true)
  })
})
