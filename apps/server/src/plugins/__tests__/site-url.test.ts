import { describe, expect, it } from 'vitest'
import { ProviderSiteUrlSchema } from '@repo/schemas/provider'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'

describe('built-in provider sites', () => {
  it('names an http or https site for every provider-page entry', () => {
    const providers = getBuiltinProviderCatalog().filter(
      (provider) => provider.surface === 'provider',
    )
    expect(providers.length).toBeGreaterThan(0)
    for (const provider of providers)
      expect(
        ProviderSiteUrlSchema.safeParse(provider.siteUrl).success,
        provider.id,
      ).toBe(true)
  })
})
