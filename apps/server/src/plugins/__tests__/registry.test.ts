import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('plugin registry', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('loads configured external plugins into the provider catalog', async () => {
    const fixturePath = fileURLToPath(
      new URL('./fixtures/mock-scrape-plugin.ts', import.meta.url),
    )

    vi.doMock('@/env', () => ({
      env: {
        MEDIA_PLUGIN_PATHS: [fixturePath],
      },
    }))

    const { getScrapePlugin, listProviderCatalog } =
      await import('@/plugins/registry')

    const catalog = await listProviderCatalog()
    const pluginProvider = catalog.find(
      (provider) => provider.id === 'mock-scraper',
    )

    expect(pluginProvider).toMatchObject({
      id: 'mock-scraper',
      displayName: 'Mock Scraper',
      surface: 'provider',
      supportsScrape: true,
      supportsLegacyImport: true,
      pluginPath: fixturePath,
    })

    const plugin = await getScrapePlugin('mock-scraper')

    expect(plugin?.manifest.displayName).toBe('Mock Scraper')
    expect(plugin?.manifest.browseFields?.[0]?.rating).toEqual({
      provider: 'mock-scraper',
      shortLabel: 'Fixture',
      scale: 100,
      votesKey: 'plugin.mock-scraper.votes',
    })
  })

  it('returns builtin scrape plugins for executable film providers', async () => {
    vi.doMock('@/env', () => ({
      env: {
        MEDIA_PLUGIN_PATHS: [],
      },
    }))

    const { getScrapePlugin, listProviderCatalog } =
      await import('@/plugins/registry')
    const catalog = await listProviderCatalog()

    expect(
      catalog.find((provider) => provider.id === 'tmdb')?.supportsScrape,
    ).toBe(true)
    expect(
      catalog.find((provider) => provider.id === 'omdb')?.supportsScrape,
    ).toBe(true)

    const tmdbPlugin = await getScrapePlugin('tmdb')
    const omdbPlugin = await getScrapePlugin('omdb')

    expect(tmdbPlugin?.manifest.displayName).toBe('TMDb')
    expect(omdbPlugin?.manifest.displayName).toBe('OMDb')
    expect(await getScrapePlugin('exa')).toBeNull()
    expect(catalog.some((provider) => provider.id === 'exa')).toBe(false)
    expect((await getScrapePlugin('serply'))?.manifest.id).toBe('serply')
  })

  it('keeps public providers available when an optional local package is absent', async () => {
    vi.doMock('@/env', () => ({
      env: { MEDIA_PLUGIN_PATHS: ['./missing-fixture-package/index.mjs'] },
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { listProviderCatalog } = await import('@/plugins/registry')
      expect(
        (await listProviderCatalog()).some(
          (provider) => provider.id === 'tmdb',
        ),
      ).toBe(true)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
