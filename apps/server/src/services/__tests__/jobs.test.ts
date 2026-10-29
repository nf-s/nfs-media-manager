import { afterEach, describe, expect, it, vi } from 'vitest'

describe('createJob', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it.each([[], ['album-1', 'album-2']])(
    'rejects scopes that are not one explicit item: %j',
    async (...mediaItemIds) => {
      vi.doMock('@/lib/db', () => ({
        db: {},
      }))

      vi.doMock('@/plugins/registry', () => ({
        getScrapePlugin: vi.fn().mockResolvedValue({
          manifest: {
            id: 'mock-scraper',
            displayName: 'Mock Scraper',
            description: 'Fixture plugin',
            mediaTypes: ['album'],
            rateLimit: {
              maxConcurrent: 1,
              minTimeMs: 0,
            },
            secrets: [],
          },
          scrapeMediaItem: vi.fn(),
        }),
      }))

      const { createJob } = await import('@/services/jobs')

      await expect(
        createJob(
          {
            provider: 'mock-scraper',
            scope: {
              mediaItemIds,
              mediaType: 'album',
              limit: 1,
            },
            options: {},
            confirmBroadRun: false,
          },
          'user-1',
        ),
      ).rejects.toHaveProperty('name', 'ZodError')
    },
  )
})
