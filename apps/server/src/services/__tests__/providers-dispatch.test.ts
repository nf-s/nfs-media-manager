import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderCatalogEntry } from '@/lib/provider-catalog'
import { listProviders } from '@/services/providers'

const mocks = vi.hoisted(() => ({
  env: { RUNTIME_KIND: 'node' },
  catalog: vi.fn(),
  plugin: vi.fn(),
  secrets: vi.fn(),
  safety: vi.fn(),
  budget: vi.fn(),
}))

vi.mock('@/env', () => ({ env: mocks.env }))
vi.mock('@/lib/db', () => ({
  db: { query: { providerSecret: { findMany: mocks.secrets } } },
}))
vi.mock('@/plugins/registry', () => ({
  listProviderCatalog: mocks.catalog,
  getScrapePlugin: mocks.plugin,
}))
vi.mock('@/services/provider-requests', () => ({
  getProviderSafety: mocks.safety,
  getProviderBudgetStatus: mocks.budget,
}))

const provider: ProviderCatalogEntry = {
  id: 'fixture',
  displayName: 'Fixture',
  description: '',
  mediaTypes: ['album'],
  rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
  secrets: [],
  surface: 'provider',
  subscriptions: false,
  supportsScrape: true,
  supportsLegacyImport: false,
  pluginPath: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.env.RUNTIME_KIND = 'node'
  mocks.catalog.mockResolvedValue([provider])
  mocks.plugin.mockResolvedValue({ manifest: provider })
  mocks.secrets.mockResolvedValue([])
  mocks.safety.mockResolvedValue(null)
  mocks.budget.mockResolvedValue(null)
})

describe('provider dispatch controls', () => {
  it.each([
    { runtime: 'node', loaded: true, supported: false },
    { runtime: 'cloudflare', loaded: true, supported: true },
    { runtime: 'cloudflare', loaded: false, supported: false },
  ])(
    'reports controls only for a hosted loaded plugin ($runtime, $loaded)',
    async ({ runtime, loaded, supported }) => {
      mocks.env.RUNTIME_KIND = runtime
      if (!loaded) mocks.plugin.mockResolvedValue(null)
      const summaries = await listProviders()
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.supportsJobDispatchControl).toBe(supported)
    },
  )
})
