import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { encryptSecretValue } from '@/lib/crypto'
import { normalizeMdblistPayload } from '@/lib/mdblist-normalizer'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import {
  isProviderSecretConfigured,
  resolveProviderSecrets,
} from '@/lib/provider-secrets'
import {
  getBuiltinScrapePlugin,
  listBuiltinScrapePlugins,
} from '@/plugins/builtin'
import { mdblistPlugin } from '@/plugins/builtin/mdblist'
import {
  mdblistDocumentedFixture,
  mdblistMovieFixture,
} from './fixtures/film-keywords'

function createContext(
  overrides: Partial<MediaPluginScrapeContext> = {},
): MediaPluginScrapeContext {
  return {
    mediaItemId: 'film_1',
    mediaType: 'film',
    existingReferences: [
      { referenceType: 'tmdb', externalId: '603', isPrimary: true },
      { referenceType: 'imdb', externalId: 'tt0133093', isPrimary: false },
    ],
    secrets: { apiKey: 'offline-key' },
    request: vi.fn(async () => Response.json(mdblistMovieFixture)),
    log: vi.fn(async () => undefined),
    ...overrides,
  }
}

async function scrape(context: MediaPluginScrapeContext) {
  if (!mdblistPlugin.scrapeMediaItem) throw new Error('Missing scrape hook')
  return mdblistPlugin.scrapeMediaItem(context)
}

describe('MDBList keyword provider', () => {
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
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses exactly one IMDb lookup through context.request, with singular keyword append', async () => {
    const context = createContext()
    const result = await scrape(context)
    expect(context.request).toHaveBeenCalledExactlyOnceWith(
      new URL(
        'https://api.mdblist.com/imdb/movie/tt0133093/?apikey=offline-key&append_to_response=keyword',
      ),
      undefined,
      { notFoundOn404: true },
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(result.payload).toEqual(mdblistMovieFixture)
    expect(result.normalized.mediaPatch).toBeUndefined()
    expect(result.normalized.filmPatch).toBeUndefined()
    expect(result.normalized.references).toEqual([])
    expect(result.normalized.playlists).toEqual([])
    expect(PluginResultSchema.parse(result)).toEqual(result)
  })

  it('cleans only recognized prefixes, preserves raw tokens and does not merge provenance', () => {
    const tags = normalizeMdblistPayload(mdblistMovieFixture).normalized.tags
    expect(tags).toEqual(
      [
        {
          name: 'cyber punk',
          kind: 'keyword',
          source: 'imdb',
          rawName: 'imdb.cyber-punk',
        },
        {
          name: 'virtual reality',
          kind: 'keyword',
          source: 'tmdb',
          rawName: 'tmdb.virtual-reality',
        },
        {
          name: 'space opera',
          kind: 'keyword',
          source: 'trakt',
          rawName: 'trakt.space-opera',
        },
        {
          name: 'has trailer',
          kind: 'keyword',
          source: 'mdblist',
          rawName: 'mdblist.has-trailer',
        },
        {
          name: 'imdb tv movie',
          kind: 'keyword',
          source: 'mdblist',
          rawName: 'imdb-tv-movie',
        },
        {
          name: '4k blu ray',
          kind: 'keyword',
          source: 'mdblist',
          rawName: '4k-blu-ray',
        },
        {
          name: 'artificial intelligence',
          kind: 'keyword',
          source: 'imdb',
          rawName: '  IMDb.artificial-intelligence  ',
        },
        {
          name: 'unknown.namespace.some token',
          kind: 'keyword',
          source: 'unknown',
          rawName: 'unknown.namespace.some-token',
        },
        {
          name: 'unknown:other token',
          kind: 'keyword',
          source: 'unknown',
          rawName: 'unknown:other-token',
        },
        {
          name: 'unknown prefix token',
          kind: 'keyword',
          source: 'unknown',
          rawName: 'unknown-prefix-token',
        },
        {
          name: 'imdbish.not a prefix',
          kind: 'keyword',
          source: 'unknown',
          rawName: 'imdbish.not-a-prefix',
        },
        {
          name: 'cyber punk',
          kind: 'keyword',
          source: 'imdb',
          rawName: 'imdb.cyber-punk',
        },
        {
          name: 'cyber punk',
          kind: 'keyword',
          source: 'tmdb',
          rawName: 'tmdb.cyber-punk',
        },
      ].map((tag, index) => ({ ...tag, sourceId: `mdblist:${index + 1}` })),
    )
  })

  it('uses TMDb as the primary lookup when there is no IMDb reference', async () => {
    const context = createContext({
      existingReferences: [
        { referenceType: 'tmdb', externalId: '603', isPrimary: true },
      ],
    })
    await scrape(context)
    expect(context.request).toHaveBeenCalledExactlyOnceWith(
      new URL(
        'https://api.mdblist.com/tmdb/movie/603/?apikey=offline-key&append_to_response=keyword',
      ),
      undefined,
      { notFoundOn404: true },
    )
  })

  it('accepts the maintained documentation shape and validates ids.tmdb, not the unrelated top-level id', async () => {
    const context = createContext({
      existingReferences: [
        { referenceType: 'tmdb', externalId: '184940', isPrimary: true },
      ],
      request: vi.fn(async () => Response.json(mdblistDocumentedFixture)),
    })
    const result = await scrape(context)
    expect(result.payload).toEqual(mdblistDocumentedFixture)
    expect(result.normalized.tags).toContainEqual({
      name: 'convent nunnery',
      kind: 'keyword',
      source: 'unknown',
      sourceId: 'mdblist:6325',
      rawName: 'convent-nunnery',
    })
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...mdblistMovieFixture, ids: { imdb: 'tt0133093', tmdb: 999 } },
    { ...mdblistMovieFixture, ids: { imdb: 'tt0133093', tmdb: null } },
    { ...mdblistMovieFixture, ids: { imdb: 'tt0133093' } },
    { ...mdblistMovieFixture, ids: { imdb: 'tt0133093', tmdb: '603' } },
    { ...mdblistMovieFixture, tmdbid: 999 },
    { ...mdblistMovieFixture, ids: undefined, id: 603, imdb_id: 'tt0133093' },
  ])(
    'rejects missing, invalid or conflicting TMDb identity: %j',
    async (payload) => {
      const context = createContext({
        existingReferences: [
          { referenceType: 'tmdb', externalId: '603', isPrimary: true },
        ],
        request: vi.fn(async () => Response.json(payload)),
      })
      await expect(scrape(context)).rejects.toThrow()
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it('supports legacy identifier spelling from the older single-title documentation', () => {
    const result = normalizeMdblistPayload(
      {
        type: 'movie',
        keywords: mdblistMovieFixture.keywords,
        imdbid: 'tt0133093',
        tmdbid: 603,
      },
      { imdb: 'tt0133093', tmdb: '603' },
    )
    expect(result.normalized.tags).not.toEqual([])
  })

  it.each([
    ['imdb-tv-movie', 'imdb tv movie', 'mdblist'],
    ['imdb-video-game', 'imdb video game', 'mdblist'],
    ['imdb:some-token', 'imdb:some token', 'unknown'],
    ['imdb.some.unknown-token', 'imdb.some.unknown token', 'unknown'],
    ['some.unknown-token', 'some.unknown token', 'unknown'],
    ['some-token', 'some token', 'unknown'],
    ['tmdb.science-fiction', 'science fiction', 'tmdb'],
  ])(
    'preserves unfamiliar namespaces and custom keyword provenance: %s',
    (rawName, name, source) => {
      expect(
        normalizeMdblistPayload({
          ...mdblistMovieFixture,
          keywords: [{ id: 1, name: rawName }],
        }).normalized.tags,
      ).toEqual([
        { name, kind: 'keyword', source, sourceId: 'mdblist:1', rawName },
      ])
    },
  )

  const invalidContexts: Partial<MediaPluginScrapeContext>[] = [
    { mediaType: 'album' },
    { secrets: {} },
    { secrets: { apiKey: '  ' } },
    { existingReferences: [] },
    {
      existingReferences: [
        { referenceType: 'title', externalId: 'The Matrix', isPrimary: true },
      ],
    },
    {
      existingReferences: [
        {
          referenceType: 'imdb',
          externalId: 'tt1/../../user',
          isPrimary: true,
        },
      ],
    },
    {
      existingReferences: [
        { referenceType: 'tmdb', externalId: '0', isPrimary: true },
      ],
    },
    {
      existingReferences: [
        { referenceType: 'tmdb', externalId: '603?apikey=x', isPrimary: true },
      ],
    },
  ]
  it.each(invalidContexts)(
    'rejects invalid input before HTTP: %j',
    async (overrides) => {
      const context = createContext(overrides)
      await expect(scrape(context)).rejects.toThrow()
      expect(context.request).not.toHaveBeenCalled()
    },
  )

  it('does not fall back to TMDb after an invalid IMDb identifier', async () => {
    const context = createContext({
      existingReferences: [
        { referenceType: 'imdb', externalId: 'invalid', isPrimary: true },
        { referenceType: 'tmdb', externalId: '603', isPrimary: false },
      ],
    })
    await expect(scrape(context)).rejects.toThrow(
      'Invalid MDBList lookup identifier',
    )
    expect(context.request).not.toHaveBeenCalled()
  })

  it.each(['0', '603?apikey=x', '', 'invalid'])(
    'rejects an invalid alternate TMDb identifier before either request: %s',
    async (externalId) => {
      const context = createContext({
        existingReferences: [
          { referenceType: 'imdb', externalId: 'tt0133093', isPrimary: true },
          { referenceType: 'tmdb', externalId, isPrimary: false },
        ],
      })
      await expect(scrape(context)).rejects.toThrow(
        'Invalid MDBList lookup identifier',
      )
      expect(context.request).not.toHaveBeenCalled()
    },
  )

  it('reports missing exact IDs explicitly without a title search', async () => {
    const context = createContext({
      existingReferences: [],
      media: { title: 'The Matrix', artists: [] },
    })
    await expect(scrape(context)).rejects.toThrow(
      'MDBList scraping requires an IMDb or TMDb reference.',
    )
    expect(context.request).not.toHaveBeenCalled()
  })

  it.each([400, 401, 403, 404, 429, 500, 503])(
    'stops on HTTP %i without retries or fallback',
    async (status) => {
      const context = createContext({
        request: vi.fn(
          async () =>
            new Response('private error', {
              status,
              headers: { 'Retry-After': '120' },
            }),
        ),
      })
      await expect(scrape(context)).rejects.toThrow(
        `MDBList request failed with status ${status}.`,
      )
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it('falls back once to the explicit TMDb movie ID after an IMDb gateway miss', async () => {
    const request = vi
      .fn<MediaPluginScrapeContext['request']>()
      .mockRejectedValueOnce(new ProviderItemNotFoundError('No IMDb match'))
      .mockResolvedValueOnce(Response.json(mdblistMovieFixture))
    const result = await scrape(createContext({ request }))
    expect(result.payload).toEqual(mdblistMovieFixture)
    expect(PluginResultSchema.parse(result)).toEqual(result)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(
      1,
      new URL(
        'https://api.mdblist.com/imdb/movie/tt0133093/?apikey=offline-key&append_to_response=keyword',
      ),
      undefined,
      { notFoundOn404: true },
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      new URL(
        'https://api.mdblist.com/tmdb/movie/603/?apikey=offline-key&append_to_response=keyword',
      ),
      undefined,
      { notFoundOn404: true },
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { referenceType: 'imdb', externalId: 'tt0133093', isPrimary: true },
    { referenceType: 'tmdb', externalId: '603', isPrimary: true },
  ])(
    'preserves a gateway miss when no other explicit ID exists: %j',
    async (reference) => {
      const error = new ProviderItemNotFoundError('No matching film')
      const context = createContext({
        existingReferences: [reference],
        request: vi.fn(async () => {
          throw error
        }),
      })
      await expect(scrape(context)).rejects.toBe(error)
      expect(context.request).toHaveBeenCalledExactlyOnceWith(
        new URL(
          `https://api.mdblist.com/${reference.referenceType}/movie/${reference.externalId}/?apikey=offline-key&append_to_response=keyword`,
        ),
        undefined,
        { notFoundOn404: true },
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('preserves the final not-found classification after both exact IDs miss', async () => {
    const error = new ProviderItemNotFoundError('No TMDb match')
    const request = vi
      .fn<MediaPluginScrapeContext['request']>()
      .mockRejectedValueOnce(new ProviderItemNotFoundError('No IMDb match'))
      .mockRejectedValueOnce(error)
    await expect(scrape(createContext({ request }))).rejects.toBe(error)
    expect(request).toHaveBeenCalledTimes(2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { ids: { imdb: 'tt9999999', tmdb: 603 } },
    { ids: { imdb: null, tmdb: 603 } },
    { ids: { tmdb: 603 } },
    { ids: { imdb: 'tt0133093', tmdb: 999 } },
    { ids: { imdb: 'tt0133093', tmdb: null } },
    { ids: { imdb: 'tt0133093' }, id: 603 },
    { imdbid: 'tt9999999' },
    { imdb_id: 'tt9999999' },
    { tmdbid: 999 },
  ])(
    'cross-validates both expected IDs on fallback, without further requests: %j',
    async (overrides) => {
      const request = vi
        .fn<MediaPluginScrapeContext['request']>()
        .mockRejectedValueOnce(new ProviderItemNotFoundError('No IMDb match'))
        .mockResolvedValueOnce(
          Response.json({ ...mdblistMovieFixture, ...overrides }),
        )
      await expect(scrape(createContext({ request }))).rejects.toThrow(
        'MDBList returned a different or missing lookup identifier.',
      )
      expect(request).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    { type: 'show' },
    { keywords: null },
    { ids: { imdb: 'tt0133093', tmdb: '603' } },
    { error: 'Service failure' },
  ])(
    'rejects invalid fallback payloads without a third request: %j',
    async (overrides) => {
      const request = vi
        .fn<MediaPluginScrapeContext['request']>()
        .mockRejectedValueOnce(new ProviderItemNotFoundError('No IMDb match'))
        .mockResolvedValueOnce(
          Response.json({ ...mdblistMovieFixture, ...overrides }),
        )
      await expect(scrape(createContext({ request }))).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(2)
    },
  )

  it('does not treat an unbranded not-found error as an exact-ID miss', async () => {
    const error = new Error('No matching film')
    error.name = 'ProviderItemNotFoundError'
    const request = vi
      .fn<MediaPluginScrapeContext['request']>()
      .mockRejectedValueOnce(error)
    await expect(scrape(createContext({ request }))).rejects.toBe(error)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    'rate-limit',
    'cooldown',
    'access-denied',
    'request-failed',
  ] satisfies ProviderRequestError['code'][])(
    'preserves gateway %s errors, including Retry-After and recorded state',
    async (code) => {
      const error = new ProviderRequestError(
        'Gateway stopped request',
        code,
        123456789,
        true,
      )
      const context = createContext({
        request: vi.fn(async () => {
          throw error
        }),
      })
      await expect(scrape(context)).rejects.toBe(error)
      expect(context.request).toHaveBeenCalledTimes(1)

      const fallbackRequest = vi
        .fn<MediaPluginScrapeContext['request']>()
        .mockRejectedValueOnce(new ProviderItemNotFoundError('No IMDb match'))
        .mockRejectedValueOnce(error)
      await expect(
        scrape(createContext({ request: fallbackRequest })),
      ).rejects.toBe(error)
      expect(fallbackRequest).toHaveBeenCalledTimes(2)
    },
  )

  it('does not retry transport or invalid JSON failures', async () => {
    const error = new Error('Offline transport failure')
    const request = vi
      .fn<MediaPluginScrapeContext['request']>()
      .mockRejectedValueOnce(error)
    await expect(scrape(createContext({ request }))).rejects.toBe(error)
    expect(request).toHaveBeenCalledTimes(1)
    const invalidJson = vi.fn(async () => new Response('{invalid'))
    await expect(
      scrape(createContext({ request: invalidJson })),
    ).rejects.toThrow()
    expect(invalidJson).toHaveBeenCalledTimes(1)
  })

  it.each([
    null,
    [],
    'unknown',
    123,
    {},
    { ...mdblistMovieFixture, type: 'show' },
    { ...mdblistMovieFixture, ids: { imdb: 'bad', tmdb: 603 } },
    { ...mdblistMovieFixture, ids: { imdb: 'tt0133093', tmdb: -1 } },
    { ...mdblistMovieFixture, ids: { imdb: 'tt0133093', tmdb: 1.5 } },
    { ...mdblistMovieFixture, keywords: undefined },
    { ...mdblistMovieFixture, keywords: null },
    { ...mdblistMovieFixture, keywords: 'imdb.cyber-punk' },
    { ...mdblistMovieFixture, keywords: [null] },
    { ...mdblistMovieFixture, keywords: [42] },
    { ...mdblistMovieFixture, keywords: ['imdb.cyber-punk'] },
    { ...mdblistMovieFixture, keywords: [{ name: 'unknown object shape' }] },
    { ...mdblistMovieFixture, keywords: [{ id: '1', name: 'bad id' }] },
    { ...mdblistMovieFixture, keywords: [{ id: 0, name: 'bad id' }] },
    { ...mdblistMovieFixture, keywords: [{ id: -1, name: 'bad id' }] },
    { ...mdblistMovieFixture, keywords: [{ id: 1.5, name: 'bad id' }] },
    { ...mdblistMovieFixture, keywords: [{ id: 1, name: 42 }] },
    { ...mdblistMovieFixture, ids: { imdb: 'tt9999999' } },
    { ...mdblistMovieFixture, ids: { imdb: null } },
    { ...mdblistMovieFixture, ids: { tmdb: 603 } },
    { ...mdblistMovieFixture, imdb_id: 'tt9999999' },
    { ...mdblistMovieFixture, error: 'Daily API limit exceeded!' },
    { ...mdblistMovieFixture, error: { message: 'Unknown service failure' } },
    { error: 'Invalid API key: offline-key' },
  ])(
    'rejects invalid or service-error payloads without further requests: %j',
    async (payload) => {
      const context = createContext({
        request: vi.fn(async () => Response.json(payload)),
      })
      await expect(scrape(context)).rejects.toThrow()
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it('accepts an explicitly empty keyword array', () => {
    expect(
      normalizeMdblistPayload({ ...mdblistMovieFixture, keywords: [] })
        .normalized.tags,
    ).toEqual([])
  })

  it('does not echo service error content', async () => {
    const context = createContext({
      request: vi.fn(async () =>
        Response.json({ error: 'Invalid API key: offline-key' }),
      ),
    })
    await expect(scrape(context)).rejects.toThrow(
      'MDBList returned a service error.',
    )
  })

  it('tests credentials with one gateway lookup and no account/list requests', async () => {
    if (!mdblistPlugin.testConnection)
      throw new Error('Missing connection hook')
    const context = createContext()
    await mdblistPlugin.testConnection(context)
    expect(context.request).toHaveBeenCalledExactlyOnceWith(
      new URL(
        'https://api.mdblist.com/imdb/movie/tt0133093/?apikey=offline-key&append_to_response=keyword',
      ),
      undefined,
      { notFoundOn404: true },
    )
  })

  it('registers the same conservative manifest and environment-backed credential in the catalog', () => {
    const catalog = getBuiltinProviderCatalog().find(
      (entry) => entry.id === 'mdblist',
    )
    expect(getBuiltinScrapePlugin('mdblist')).toBe(mdblistPlugin)
    expect(listBuiltinScrapePlugins()).toContain(mdblistPlugin)
    expect(catalog).toEqual({
      ...mdblistPlugin.manifest,
      surface: 'provider',
      supportsScrape: true,
      supportsLegacyImport: false,
      pluginPath: null,
    })
    expect(catalog?.rateLimit).toEqual({
      maxConcurrent: 3,
      concurrentRequests: true,
      minTimeMs: 350,
      fixedWindow: { durationMs: 300000, reads: 1000, writes: 300 },
      requestBudget: { period: 'day', limit: 10000 },
      configurableRequestBudget: true,
      respectRateLimitHeaders: true,
      retryAfterIsAuthoritative: true,
      rateLimitCooldownMs: 300000,
    })
    expect(catalog?.identifierTypes).toEqual(['imdb', 'tmdb'])
    const descriptors = catalog?.secrets ?? []
    vi.stubEnv('MDBLIST_API_KEY', ' env-key ')
    expect(
      isProviderSecretConfigured('mdblist', 'apiKey', [], descriptors),
    ).toBe(true)
    expect(resolveProviderSecrets('mdblist', [], descriptors)).toEqual({
      apiKey: 'env-key',
    })
    const rows = [
      {
        id: 'secret-1',
        provider: 'mdblist',
        key: 'apiKey',
        encryptedValue: encryptSecretValue('stored-key'),
        lastVerifiedAt: null,
        lastVerifiedStatus: null,
        lastUpdatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    expect(resolveProviderSecrets('mdblist', rows, descriptors)).toEqual({
      apiKey: 'stored-key',
    })
    vi.stubEnv('MDBLIST_API_KEY', ' ')
    expect(
      isProviderSecretConfigured('mdblist', 'apiKey', [], descriptors),
    ).toBe(false)
  })
})
