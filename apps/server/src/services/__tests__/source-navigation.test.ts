import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
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
        mediaItemId: 'film',
        provider: 'legacy-record',
        payload: { collections: [{ id: '17', name: 'Festival' }] },
      },
      {
        mediaItemId: 'film',
        provider: 'fixture',
        payload: {
          collections: [
            { id: '17', name: 'Festival' },
            { id: '18', name: 'Award winners' },
          ],
        },
      },
      { mediaItemId: 'film', provider: 'other', payload: {} },
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

  it('batches collection lookups without mixing film provenance', async () => {
    mocks.plugins.mockResolvedValue([
      {
        manifest,
        readStoredCollections: (payload: JsonValue) =>
          z
            .array(z.object({ id: z.string(), name: z.string() }))
            .parse(payload),
      },
    ])
    mocks.states.mockResolvedValue([
      {
        mediaItemId: 'first',
        provider: 'fixture',
        payload: [{ id: '17', name: 'First collection' }],
      },
      {
        mediaItemId: 'second',
        provider: 'fixture',
        payload: [{ id: '18', name: 'Second collection' }],
      },
    ])
    const { getCollectionSourceLinksForItems } =
      await import('../source-navigation')
    const links = await getCollectionSourceLinksForItems([
      { id: 'first', metadata: {} },
      { id: 'second', metadata: {} },
    ])
    expect(links.get('first')?.map((link) => link.name)).toEqual([
      'First collection',
    ])
    expect(links.get('second')?.map((link) => link.name)).toEqual([
      'Second collection',
    ])
    expect(mocks.plugins).toHaveBeenCalledOnce()
    expect(mocks.states).toHaveBeenCalledOnce()
  })

  it('bounds provider payload reads and deduplicates overlapping film IDs', async () => {
    mocks.plugins.mockResolvedValue([
      {
        manifest,
        readStoredCollections: (payload: JsonValue) =>
          z
            .array(z.object({ id: z.string(), name: z.string() }))
            .parse(payload),
      },
    ])
    const readIds: string[] = []
    mocks.states.mockImplementation(async (predicate: SQL) => {
      const params = new PgDialect().sqlToQuery(predicate).params
      expect(params.length).toBeLessThanOrEqual(102)
      const ids = params.filter(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('film-'),
      )
      readIds.push(...ids)
      return ids.map((id) => ({
        mediaItemId: id,
        provider: 'fixture',
        payload: [{ id, name: id }],
      }))
    })
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `film-${index}`,
      metadata: {},
    }))
    const { getCollectionSourceLinksForItems } =
      await import('../source-navigation')
    const links = await getCollectionSourceLinksForItems([...items, ...items])
    expect(readIds).toEqual(items.map((item) => item.id))
    expect(links.get('film-204')?.map((link) => link.name)).toEqual([
      'film-204',
    ])
    expect(mocks.plugins).toHaveBeenCalledOnce()
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
      { mediaItemId: 'film', provider: 'legacy-record', payload: {} },
      { mediaItemId: 'film', provider: 'fixture', payload: {} },
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
