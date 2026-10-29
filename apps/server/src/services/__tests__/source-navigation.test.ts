import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  MediaPluginManifestSchema,
  type JsonValue,
} from '@repo/media-plugin-sdk'

const mocks = vi.hoisted(() => ({
  states: vi.fn(),
  plugins: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.states }) }) },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: mocks.plugins,
}))

const manifest = MediaPluginManifestSchema.parse({
  id: 'fixture',
  displayName: 'Fixture',
  description: '',
  mediaTypes: ['film'],
  secrets: [],
  rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
  sourceNavigation: {
    collectionUrlTemplate: 'https://example.com/collection/{id}',
  },
})

describe('offline collection provenance', () => {
  afterEach(() => vi.resetAllMocks())

  it('reads existing provider and legacy payloads via the local plugin without a rescrape or duplicate links', async () => {
    const readStoredCollections = vi.fn(
      (payload: JsonValue) =>
        z
          .object({
            collections: z.array(
              z.object({ id: z.string(), name: z.string() }),
            ),
          })
          .parse(payload).collections,
    )
    mocks.plugins.mockResolvedValue([{ manifest, readStoredCollections }])
    mocks.states.mockResolvedValue([
      {
        provider: 'legacy-record',
        payload: { collections: [{ id: '17', name: 'Festival' }] },
      },
      {
        provider: 'fixture',
        payload: {
          collections: [
            { id: '17', name: 'Festival' },
            { id: '18', name: 'Award winners' },
          ],
        },
      },
      { provider: 'other', payload: {} },
    ])
    const { getCollectionSourceLinks } = await import('../source-navigation')
    const links = await getCollectionSourceLinks('film', {})
    expect(links).toHaveLength(2)
    expect(links[0]?.url).toBe('https://example.com/collection/17')
    expect(readStoredCollections).toHaveBeenCalledTimes(2)
  })

  it('does not read stored payloads when no plugin offers a reader', async () => {
    mocks.plugins.mockResolvedValue([{ manifest }])
    const { getCollectionSourceLinks } = await import('../source-navigation')
    expect(await getCollectionSourceLinks('film', {})).toEqual([])
    expect(mocks.states).not.toHaveBeenCalled()
  })

  it('isolates unsupported/malformed legacy payloads from detail browsing', async () => {
    const readStoredCollections = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Unsupported legacy payload')
      })
      .mockReturnValueOnce([{ id: 123, name: 'Invalid' }])
    mocks.plugins.mockResolvedValue([{ manifest, readStoredCollections }])
    mocks.states.mockResolvedValue([
      { provider: 'legacy-record', payload: {} },
      { provider: 'fixture', payload: {} },
    ])
    const { getCollectionSourceLinks } = await import('../source-navigation')
    expect(
      await getCollectionSourceLinks('film', {
        'plugin.fixture.details': {
          collections: [{ id: 4, name: 'Saved collection' }],
        },
      }),
    ).toMatchObject([
      { name: 'Saved collection', url: 'https://example.com/collection/4' },
    ])
  })
})

describe('offline Discogs tag provenance', () => {
  afterEach(() => vi.resetAllMocks())

  it('skips database reads without Discogs origin items', async () => {
    const { getStoredDiscogsTagPayloads } = await import('../source-navigation')
    expect(await getStoredDiscogsTagPayloads([])).toEqual([])
    expect(mocks.states).not.toHaveBeenCalled()
  })

  it('retains item attribution across historical and current projected tag fields', async () => {
    const history = {
      mediaItemId: 'album-a',
      payload: { master: { styles: ['Arena Rock'] } },
    }
    const current = {
      mediaItemId: 'album-b',
      payload: { release: { genres: ['Electronic'] } },
    }
    mocks.states
      .mockResolvedValueOnce([history])
      .mockResolvedValueOnce([current])
    const { getStoredDiscogsTagPayloads } = await import('../source-navigation')
    expect(await getStoredDiscogsTagPayloads(['album-a', 'album-b'])).toEqual([
      history,
      current,
    ])
    expect(mocks.states).toHaveBeenCalledTimes(2)
    expect(mocks.plugins).not.toHaveBeenCalled()
  })
})
