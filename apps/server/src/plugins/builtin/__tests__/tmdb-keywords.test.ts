import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PluginResultSchema,
  ProviderRequestError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import {
  normalizeTmdbPayload,
  type JsonRecord,
} from '@/lib/provider-normalizers'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'
import { tmdbMovieFixture } from './fixtures/film-keywords'

function createContext(): MediaPluginScrapeContext {
  return {
    mediaItemId: 'film_1',
    mediaType: 'film',
    existingReferences: [
      { referenceType: 'tmdb', externalId: '603', isPrimary: true },
    ],
    secrets: { apiKey: 'offline-key' },
    request: vi.fn(async () => Response.json(tmdbMovieFixture)),
    log: vi.fn(async () => undefined),
  }
}

async function scrape(context: MediaPluginScrapeContext) {
  if (!tmdbPlugin.scrapeMediaItem) throw new Error('Missing scrape hook')
  return tmdbPlugin.scrapeMediaItem(context)
}

describe('TMDb keyword append', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Unexpected live request')
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('appends keywords alongside credits in the single details request', async () => {
    const context = createContext()
    const result = await scrape(context)
    expect(context.request).toHaveBeenCalledExactlyOnceWith(
      new URL(
        'https://api.themoviedb.org/3/movie/603?api_key=offline-key&append_to_response=credits%2Ckeywords',
      ),
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(result.payload).toEqual(tmdbMovieFixture)
    expect(result.normalized.credits).toContainEqual({
      name: 'Keanu Reeves',
      role: 'actor',
      billingOrder: 0,
    })
    expect(result.normalized.tags).toContainEqual({
      name: 'Science Fiction',
      kind: 'genre',
      source: 'tmdb',
      sourceId: '878',
      rawName: 'Science Fiction',
    })
    expect(PluginResultSchema.parse(result).normalized.tags).toEqual(
      result.normalized.tags,
    )
  })

  it('imports valid keyword IDs and preserves original names, ignoring invalid entries', () => {
    const result = normalizeTmdbPayload(tmdbMovieFixture)
    expect(
      result.normalized.tags.filter((tag) => tag.kind === 'keyword'),
    ).toEqual([
      {
        name: 'artificial intelligence',
        kind: 'keyword',
        source: 'tmdb',
        sourceId: '310',
        rawName: 'artificial intelligence',
      },
      {
        name: 'science-fiction',
        kind: 'keyword',
        source: 'tmdb',
        sourceId: '456',
        rawName: 'science-fiction',
      },
      {
        name: '  Mixed Case  ',
        kind: 'keyword',
        source: 'tmdb',
        sourceId: '789',
        rawName: '  Mixed Case  ',
      },
      {
        name: 'tmdb.keep-prefix',
        kind: 'keyword',
        source: 'tmdb',
        sourceId: '111',
        rawName: 'tmdb.keep-prefix',
      },
    ])
    expect(result.normalized.mediaPatch?.title).toBe('The Matrix')
  })

  const legacyPayloads: JsonRecord[] = [
    { id: 603, title: 'The Matrix' },
    { keywords: null },
    { keywords: [] },
    { keywords: 'invalid' },
    { keywords: { keywords: null } },
    {
      keywords: { results: [{ id: 1, name: 'TV shape must not be imported' }] },
    },
  ]
  it.each(legacyPayloads)(
    'does not fabricate keywords in missing or unsupported legacy shapes: %j',
    (payload) => {
      expect(normalizeTmdbPayload(payload).normalized.tags).toEqual([])
    },
  )

  it('uses only find plus one appended details request for IMDb resolution', async () => {
    const context = createContext()
    context.existingReferences = [
      { referenceType: 'imdb', externalId: 'tt0133093', isPrimary: true },
    ]
    const request = vi
      .fn<MediaPluginScrapeContext['request']>()
      .mockResolvedValueOnce(Response.json({ movie_results: [{ id: 603 }] }))
      .mockResolvedValueOnce(Response.json(tmdbMovieFixture))
    context.request = request
    await scrape(context)
    expect(request.mock.calls).toEqual([
      [
        new URL(
          'https://api.themoviedb.org/3/find/tt0133093?api_key=offline-key&external_source=imdb_id',
        ),
      ],
      [
        new URL(
          'https://api.themoviedb.org/3/movie/603?api_key=offline-key&append_to_response=credits%2Ckeywords',
        ),
      ],
    ])
  })

  it.each([401, 429, 500])(
    'stops at HTTP %i without a keyword request or retry',
    async (status) => {
      const context = createContext()
      context.request = vi.fn(async () => new Response(null, { status }))
      await expect(scrape(context)).rejects.toThrow(
        `TMDb request failed with status ${status}.`,
      )
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it('preserves a gateway quota failure without retry', async () => {
    const error = new ProviderRequestError(
      'Rate limit',
      'rate-limit',
      12345,
      true,
    )
    const context = createContext()
    context.request = vi.fn(async () => {
      throw error
    })
    await expect(scrape(context)).rejects.toBe(error)
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { success: false, status_message: 'Invalid API key: offline-key' },
    { ...tmdbMovieFixture, keywords: { success: false, status_code: 7 } },
  ])('rejects successful HTTP service-error payloads: %j', async (payload) => {
    const context = createContext()
    context.request = vi.fn(async () => Response.json(payload))
    await expect(scrape(context)).rejects.toThrow(
      'TMDb returned a service error.',
    )
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it('uses the same serial hard minimum in the executable and UI catalog', () => {
    const catalog = getBuiltinProviderCatalog().find(
      (entry) => entry.id === 'tmdb',
    )
    expect(tmdbPlugin.manifest.rateLimit).toEqual({
      maxConcurrent: 1,
      minTimeMs: 2000,
    })
    expect(catalog?.rateLimit).toEqual(tmdbPlugin.manifest.rateLimit)
  })
})
