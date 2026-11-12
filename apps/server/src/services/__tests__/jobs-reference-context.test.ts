import type { MediaPluginScrapeContext } from '@repo/media-plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('job reference context', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it.each([false, true])(
    'reserves manualOverride for explicit overrides (override: %s)',
    async (hasOverride) => {
      const storedMetadata = {
        manualOverride: true,
        sourceProvider: 'forged-provider',
        evidence: 'preserved',
      }
      const ordinary = {
        provider: 'fixture-provider',
        referenceType: 'rym-url',
        externalId: 'https://rateyourmusic.com/release/album/artist/ordinary/',
        isPrimary: true,
        metadata: storedMetadata,
      }
      const foreign = {
        ...ordinary,
        provider: 'legacy-browser',
        referenceType: 'foreign-id',
        externalId: 'foreign-1',
      }
      const override = {
        referenceType: 'rym-url',
        externalId: 'https://rateyourmusic.com/release/album/artist/reviewed/',
      }
      const query = {
        scrapeJob: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'job-1',
            provider: 'fixture-provider',
            status: 'running',
            options: {},
            items: [
              {
                id: 'item-1',
                mediaItemId: 'album-1',
                provider: 'fixture-provider',
                status: 'queued',
                attemptCount: 0,
              },
            ],
          }),
        },
        scrapeJobItem: { findMany: vi.fn().mockResolvedValue([]) },
        mediaItem: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'album-1',
            mediaType: 'album',
            title: 'Fixture',
            credits: [],
          }),
        },
        providerReference: {
          findMany: vi.fn().mockResolvedValue([foreign, ordinary]),
        },
        providerReferenceOverride: {
          findMany: vi.fn().mockResolvedValue(hasOverride ? [override] : []),
        },
        providerSecret: { findMany: vi.fn().mockResolvedValue([]) },
      }
      const transaction = {
        query,
        select: () => ({
          from: () => ({
            where: () => ({ for: async () => [{ status: 'running' }] }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () =>
              Object.assign(Promise.resolve(), {
                returning: async () => [{ id: 'claimed' }],
              }),
          }),
        }),
        insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      }
      vi.doMock('@/lib/db', () => ({
        db: {
          ...transaction,
          transaction: async (
            write: (tx: typeof transaction) => Promise<unknown>,
          ) => write(transaction),
        },
      }))
      const scrape = vi.fn(async (context: MediaPluginScrapeContext) => {
        expect(context.mediaItemId).toBe('album-1')
        return { payload: {}, normalized: {} }
      })
      vi.doMock('@/plugins/registry', () => ({
        getScrapePlugin: async () => ({
          manifest: { id: 'fixture-provider', secrets: [] },
          scrapeMediaItem: scrape,
        }),
      }))
      vi.doMock('@/lib/provider-secrets', () => ({
        resolveProviderSecrets: () => ({}),
      }))
      vi.doMock('@/services/provider-reference-hints', () => ({
        getProviderReferenceHints: async () => [
          {
            referenceType: 'hint-id',
            externalId: 'hint-1',
            isPrimary: false,
            metadata: { sourceProvider: 'legacy-browser', searchHint: true },
          },
        ],
      }))
      vi.doMock('@/services/provider-state', () => ({
        applyProviderResultInTransaction: vi.fn(),
      }))
      vi.doMock('@/services/provider-requests', () => ({
        createProviderRequest: () => vi.fn(),
        recordProviderSuccess: vi.fn(),
        recordProviderFailure: vi.fn(),
        getProviderSafety: async () => ({
          halted: false,
          consecutiveFailures: 0,
        }),
      }))
      const { processQueuedJobById } = await import('@/services/jobs')
      const recordOutcome = vi.fn()
      await processQueuedJobById('job-1', 'fixture-provider', {
        canContinue: async () => true,
        recordOutcome,
      })
      expect(scrape).toHaveBeenCalledTimes(1)
      expect(recordOutcome).toHaveBeenCalledWith('success')
      const context = scrape.mock.calls[0]?.[0]
      expect(context?.existingReferences).toEqual([
        hasOverride
          ? {
              ...override,
              isPrimary: true,
              metadata: {
                sourceProvider: 'fixture-provider',
                manualOverride: true,
              },
            }
          : {
              referenceType: ordinary.referenceType,
              externalId: ordinary.externalId,
              isPrimary: true,
              metadata: {
                sourceProvider: 'fixture-provider',
                evidence: 'preserved',
              },
            },
        {
          referenceType: foreign.referenceType,
          externalId: foreign.externalId,
          isPrimary: true,
          metadata: { sourceProvider: 'legacy-browser', evidence: 'preserved' },
        },
        {
          referenceType: 'hint-id',
          externalId: 'hint-1',
          isPrimary: false,
          metadata: { sourceProvider: 'legacy-browser', searchHint: true },
        },
      ])
      expect(storedMetadata.manualOverride).toBe(true)
      expect(storedMetadata.sourceProvider).toBe('forged-provider')
    },
  )
})
