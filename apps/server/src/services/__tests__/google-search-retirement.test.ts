import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nextJob: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  request: vi.fn(),
  persist: vi.fn(),
}))

vi.mock('@/env', () => ({ env: { MEDIA_PLUGIN_PATHS: [] } }))
vi.mock('@/lib/db', () => {
  const transaction = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => [{ status: 'running' }],
        }),
      }),
    }),
    update: mocks.update,
  }
  return {
    db: {
      query: {
        scrapeJob: { findFirst: mocks.nextJob },
        providerRequestState: { findFirst: async () => undefined },
      },
      update: mocks.update,
      transaction: async (run: (tx: typeof transaction) => Promise<unknown>) =>
        run(transaction),
    },
  }
})
vi.mock('@/services/provider-state', () => ({
  applyProviderResult: mocks.persist,
  applyProviderResultInTransaction: mocks.persist,
}))
vi.mock('@/services/provider-requests', () => ({
  createProviderRequest: mocks.request,
  getProviderSafety: vi.fn(),
  recordProviderFailure: vi.fn(),
  recordProviderSuccess: vi.fn(),
}))

import { normalizeGoogleSearchPayload } from '../../../scripts/import-legacy'
import {
  getScrapePlugin,
  listLoadedScrapePlugins,
  listProviderCatalog,
} from '@/plugins/registry'
import { getBuiltinScrapePlugin } from '@/plugins/builtin'
import {
  isProviderSecretConfigured,
  resolveProviderSecrets,
} from '@/lib/provider-secrets'
import { createJob, processQueuedJobs } from '../jobs'

describe('Google Custom Search retirement', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live HTTP is forbidden')
      }),
    )
    mocks.update.mockReturnValue({ set: mocks.set })
    mocks.set.mockReturnValue({
      where: () => ({ returning: async () => [{ id: 'legacy-google-job' }] }),
    })
  })

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('retains an import-only catalog identity without any active scraper or credentials', async () => {
    const catalog = await listProviderCatalog()
    expect(
      catalog.find((entry) => entry.id === 'google-custom-search'),
    ).toMatchObject({
      id: 'google-custom-search',
      displayName: 'Google Custom Search (legacy)',
      surface: 'import',
      supportsScrape: false,
      supportsLegacyImport: true,
      secrets: [],
    })
    expect(
      catalog.filter((entry) => entry.supportsScrape).map((entry) => entry.id),
    ).not.toContain('google-custom-search')
    expect(getBuiltinScrapePlugin('google-custom-search')).toBeNull()
    expect(await getScrapePlugin('google-custom-search')).toBeNull()
    expect(
      (await listLoadedScrapePlugins()).map((plugin) => plugin.manifest.id),
    ).not.toContain('google-custom-search')
    expect((await getScrapePlugin('serply'))?.manifest.id).toBe('serply')
  })

  it('does not resolve old Google environment credentials', () => {
    for (const key of [
      'GOOGLE_SEARCH_API_KEY',
      'RYM_GOOGLE_SEARCH_ID',
      'METACRITIC_GOOGLE_SEARCH_ID',
      'DISCOGS_GOOGLE_SEARCH_ID',
      'DISCOGS_RELEASE_GOOGLE_SEARCH_ID',
    ]) {
      vi.stubEnv(key, 'unused-offline-fixture')
    }
    expect(resolveProviderSecrets('google-custom-search', [])).toEqual({})
    expect(
      isProviderSecretConfigured('google-custom-search', 'apiKey', []),
    ).toBe(false)
    expect(
      isProviderSecretConfigured('google-custom-search', 'searchEngineId', []),
    ).toBe(false)
  })

  it('preserves legacy payloads, zero ratings, source links and genre translation', () => {
    const payload = {
      rymGoogle: {
        link: 'https://rateyourmusic.com/release/album/example/album/',
        rating: { value: 0, votes: 0 },
        genres: ['Ambient', 'Drone'],
      },
      metacriticGoogle: {
        link: 'https://www.metacritic.com/music/album/example/',
        rating: { value: 80, votes: 10 },
      },
    }
    const original = structuredClone(payload)
    const result = normalizeGoogleSearchPayload(payload)
    expect(result?.payload).toEqual(original)
    expect(result?.normalized.tags).toEqual([
      { name: 'Ambient', kind: 'genre' },
      { name: 'Drone', kind: 'genre' },
    ])
    expect(result?.normalized.links).toEqual([
      {
        provider: 'google-custom-search',
        label: 'RYM / Sonemic',
        url: payload.rymGoogle.link,
      },
      {
        provider: 'google-custom-search',
        label: 'Metacritic',
        url: payload.metacriticGoogle.link,
      },
    ])
    expect(payload).toEqual(original)
    expect(normalizeGoogleSearchPayload({})).toBeNull()
  })

  it.each(['google-custom-search', 'exa'])(
    'fails an existing queued %s job as unsupported before transport or persistence',
    async (provider) => {
      mocks.nextJob.mockResolvedValueOnce({
        id: 'legacy-google-job',
        provider,
        items: [
          { id: 'legacy-item', mediaItemId: 'album-1', status: 'queued' },
        ],
      })
      await processQueuedJobs()
      expect(mocks.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'No executable plugin is loaded for this provider.',
          finishedAt: expect.any(Date),
        }),
      )
      expect(mocks.update).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['google-custom-search', 'exa'])(
    'rejects newly requested %s jobs before database access',
    async (provider) => {
      await expect(
        createJob(
          {
            provider,
            scope: { mediaType: 'album', mediaItemIds: ['album-1'], limit: 1 },
            options: {},
            confirmBroadRun: false,
          },
          null,
        ),
      ).rejects.toThrow('Provider cannot be scraped')
      expect(mocks.nextJob).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
    },
  )
})
