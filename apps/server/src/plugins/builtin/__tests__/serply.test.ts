import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MediaPluginManifestSchema,
  PluginDiagnosticSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { serplyPlugin } from '../serply'
import { getBuiltinScrapePlugin } from '../index'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import { createJobDiagnostics } from '@/lib/job-diagnostics'

const pripyatUrl =
  'https://rateyourmusic.com/release/album/marina-herlop/pripyat/'
const souvlakiUrl = 'https://rateyourmusic.com/release/album/slowdive/souvlaki/'
const bonIverUrl =
  'https://rateyourmusic.com/release/album/bon-iver/for-emma-forever-ago/'

// Reduced indexed results: the Pripyat example was supplied by the user;
// Bon Iver and Souvlaki headers come from the 2026-10-28 Serply captures.
const pripyat = {
  link: pripyatUrl,
  title: 'Pripyat by Marina Herlop (Album, Glitch Pop) - Rate Your Music',
  description:
    'Pripyat, an Album by Marina Herlop. Released 20 May 2022. Genres: Glitch Pop, Avant-Folk. blend glitch-pop and folktronica',
  metadata: {
    rating: '3.4',
    reviews: '1,836',
    published_time: 'May 20, 2022',
  },
}
const bonIver = {
  link: bonIverUrl,
  title:
    'For Emma, Forever Ago by Bon Iver (Album, Indie Folk) - Rate Your Music',
  description:
    'RYM Rating 3.82 / 5.00.5 from 28,461 ratings Ranked #9 for 2007, #880 overall Genres Indie Folk, Singer-Songwriter Psychedelic Folk Descriptors ...',
  metadata: { rating: '3.8', reviews: '28,461' },
}
const souvlakiReview = {
  link: 'https://rateyourmusic.com/music-review/duncanreviews/slowdive/souvlaki/132161755',
  title: 'Review for Souvlaki - Slowdive by duncanreviews',
  description:
    'Slowdive 4.15 from 63,727 ratings Genres Dream Pop, Shoegaze Space Rock Revival, Post-Rock Descriptors melancholic, ethereal, atmospheric, mellow, romantic, ...',
  metadata: {},
}

function replies(...payloads: unknown[]) {
  let index = 0
  return vi.fn<MediaPluginScrapeContext['request']>(async (input, init) => {
    if (index >= 2) throw new Error('Exceeded two-search request bound')
    const url = new URL(input)
    expect(url.origin).toBe('https://api.serply.io')
    expect(url.pathname).toBe('/v1/search/')
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe('offline-key')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(url.searchParams.get('gl')).toBe('us')
    expect(url.searchParams.get('num')).toBe('10')
    const payload = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    return Response.json(payload)
  })
}

function context(
  payload: unknown = { results: [pripyat] },
  overrides: Partial<MediaPluginScrapeContext> = {},
): MediaPluginScrapeContext {
  return {
    mediaItemId: 'offline-serply-album',
    mediaType: 'album',
    media: { title: 'Pripyat', artists: ['Marina Herlop'] },
    existingReferences: [],
    secrets: { apiKey: 'offline-key' },
    request: replies(payload),
    log: vi.fn(async () => undefined),
    ...overrides,
  }
}

function scrape(ctx: MediaPluginScrapeContext) {
  if (!serplyPlugin.scrapeMediaItem) throw new Error('Missing Serply scraper')
  return serplyPlugin.scrapeMediaItem(ctx)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Live HTTP is forbidden')
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Serply indexed RYM provider', () => {
  it.each([20, 100])(
    'retains both large responses with explicit truncation when needed (%s results)',
    async (count) => {
      const diagnostics = createJobDiagnostics(['offline-key'])
      const payload = {
        results: Array.from({ length: count }, (_, index) => ({
          ...pripyat,
          link: `https://unrelated.invalid/${index}?token=never-retain`,
          description: `offline-key ${'text '.repeat(240)}`,
          metadata: {
            ...pripyat.metadata,
            extra: Array.from({ length: 12 }, (_, value) => value),
            token: 'nested-secret',
          },
        })),
      }
      const request = replies(payload, payload)
      await expect(
        scrape(
          context(undefined, {
            request,
            recordDiagnostic: diagnostics.recordDiagnostic,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
      expect(request).toHaveBeenCalledTimes(2)
      const entries = diagnostics
        .snapshot()
        .map((entry) => PluginDiagnosticSchema.parse(entry))
      expect(entries.map((entry) => entry.stage)).toEqual([
        'serply.response',
        'serply.search',
        'serply.response',
        'serply.search',
      ])
      for (const entry of entries.filter(
        (entry) => entry.stage === 'serply.response',
      )) {
        const serialized = JSON.stringify(entry)
        expect(Buffer.byteLength(serialized)).toBeGreaterThan(16 * 1024)
        expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(48 * 1024)
        expect(serialized).toContain('published_time')
        expect(serialized).toContain('[REDACTED]')
        for (const secret of ['offline-key', 'never-retain', 'nested-secret'])
          expect(serialized).not.toContain(secret)
        if (count === 100) expect(serialized).toContain('[truncated]')
        else {
          expect(serialized).not.toContain('[truncated]')
          expect(serialized).toContain('https://unrelated.invalid/19')
        }
      }
      expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThanOrEqual(
        128 * 1024,
      )
      expect(payload.results[0]?.description).toContain('offline-key')
    },
  )

  it.each([{}, { results: null }, [], null, 'unexpected'])(
    'retains malformed JSON envelopes before validation fails: %j',
    async (payload) => {
      const diagnostics = createJobDiagnostics([])
      await expect(
        scrape(
          context(payload, { recordDiagnostic: diagnostics.recordDiagnostic }),
        ),
      ).rejects.not.toBeInstanceOf(ProviderItemNotFoundError)
      expect(diagnostics.snapshot()[0]).toEqual({
        stage: 'serply.response',
        evidence: {
          query: 'site:rateyourmusic.com Marina Herlop Pripyat',
          status: 200,
          response: payload,
        },
      })
    },
  )

  it.each([401, 403, 429, 503])(
    'retains sanitized HTTP %s error JSON without changing classification or retry time',
    async (status) => {
      const diagnostics = createJobDiagnostics(['offline-key'])
      const request = vi.fn<MediaPluginScrapeContext['request']>(async () =>
        Response.json(
          {
            message: 'offline-key unavailable',
            detail: { reason: 'quota', authorization: 'private-value' },
          },
          { status, headers: { 'retry-after': '120' } },
        ),
      )
      await expect(
        scrape(
          context(undefined, {
            request,
            recordDiagnostic: diagnostics.recordDiagnostic,
          }),
        ),
      ).rejects.toMatchObject({
        name: 'ProviderRequestError',
        code:
          status === 429
            ? 'rate-limit'
            : status === 401 || status === 403
              ? 'access-denied'
              : 'request-failed',
        retryAt: status === 429 ? Date.now() + 120000 : null,
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(diagnostics.snapshot()).toEqual([
        {
          stage: 'serply.response',
          evidence: {
            query: 'site:rateyourmusic.com Marina Herlop Pripyat',
            status,
            response: {
              message: '[REDACTED] unavailable',
              detail: { reason: 'quota', authorization: '[REDACTED]' },
            },
          },
        },
      ])
    },
  )

  it.each(['not JSON', JSON.stringify({ detail: 'x'.repeat(20000) }), 'null'])(
    'marks unavailable HTTP error JSON honestly without affecting failure',
    async (body) => {
      const diagnostics = createJobDiagnostics([])
      const request = vi.fn<MediaPluginScrapeContext['request']>(
        async () => new Response(body, { status: 503 }),
      )
      await expect(
        scrape(
          context(undefined, {
            request,
            recordDiagnostic: diagnostics.recordDiagnostic,
          }),
        ),
      ).rejects.toMatchObject({ code: 'request-failed' })
      expect(diagnostics.snapshot()).toEqual([
        {
          stage: 'serply.response',
          evidence: {
            query: 'site:rateyourmusic.com Marina Herlop Pripyat',
            status: 503,
            responseUnavailable: 'null-invalid-unreadable-or-over-16384-bytes',
          },
        },
      ])
    },
  )

  it('marks non-JSON success bodies unavailable without inventing response data', async () => {
    const diagnostics = createJobDiagnostics([])
    const request = vi.fn<MediaPluginScrapeContext['request']>(
      async () => new Response('<html>Not JSON</html>'),
    )
    await expect(
      scrape(
        context(undefined, {
          request,
          recordDiagnostic: diagnostics.recordDiagnostic,
        }),
      ),
    ).rejects.toBeInstanceOf(SyntaxError)
    expect(diagnostics.snapshot()).toEqual([
      {
        stage: 'serply.response',
        evidence: {
          query: 'site:rateyourmusic.com Marina Herlop Pripyat',
          status: 200,
          responseUnavailable: 'invalid-or-unreadable-json',
        },
      },
    ])
  })

  it('retains actual JSON for both failed searches through the job collector', async () => {
    const diagnostics = createJobDiagnostics(['offline-key'])
    const first = { results: [], search_information: { total_results: 0 } }
    const second = {
      results: [{ ...pripyat, link: 'https://unrelated.invalid/' }],
      custom_field: { preserved: true, api_key: 'private-value' },
    }
    await expect(
      scrape(
        context(undefined, {
          request: replies(first, second),
          recordDiagnostic: diagnostics.recordDiagnostic,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    const responses = diagnostics
      .snapshot()
      .filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry['stage'] === 'serply.response',
      )
    expect(responses).toEqual([
      {
        stage: 'serply.response',
        evidence: {
          query: 'site:rateyourmusic.com Marina Herlop Pripyat',
          status: 200,
          response: first,
        },
      },
      {
        stage: 'serply.response',
        evidence: {
          query: 'Marina Herlop Pripyat Rate Your Music rating genres',
          status: 200,
          response: {
            ...second,
            custom_field: { preserved: true, api_key: '[REDACTED]' },
          },
        },
      },
    ])
  })

  it.each([
    { error: { message: 'Quota exhausted', token: 'private-value' } },
    { detail: 'offline-key unavailable' },
  ])(
    'retains HTTP 200 service-error JSON before throwing: %j',
    async (payload) => {
      const diagnostics = createJobDiagnostics(['offline-key'])
      const request = replies(payload)
      await expect(
        scrape(
          context(undefined, {
            request,
            recordDiagnostic: diagnostics.recordDiagnostic,
          }),
        ),
      ).rejects.toMatchObject({
        name: 'ProviderRequestError',
        code: 'request-failed',
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(diagnostics.snapshot()).toEqual([
        expect.objectContaining({
          stage: 'serply.response',
          evidence: expect.objectContaining({
            status: 200,
            response: expect.any(Object),
          }),
        }),
      ])
      const serialized = JSON.stringify(diagnostics.snapshot())
      expect(serialized).toContain('[REDACTED]')
      expect(serialized).not.toContain('offline-key')
      expect(serialized).not.toContain('private-value')
    },
  )

  it('retains candidate rejection evidence before a typed miss without adding requests', async () => {
    const recordDiagnostic =
      vi.fn<NonNullable<MediaPluginScrapeContext['recordDiagnostic']>>()
    const ctx = context(
      {
        results: [
          { ...pripyat, link: 'https://unrelated.invalid/album/' },
          { ...pripyat, title: 'Other by Marina Herlop (Album, Pop)' },
          pripyat,
        ],
      },
      {
        recordDiagnostic,
        media: {
          title: 'Pripyat',
          artists: ['Marina Herlop'],
          releaseDate: '1997-01-01',
        },
      },
    )
    await expect(scrape(ctx)).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(ctx.request).toHaveBeenCalledTimes(2)
    expect(recordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'serply.search',
        evidence: expect.objectContaining({
          resultCount: 3,
          candidates: [
            expect.objectContaining({ reason: 'invalid-url' }),
            expect.objectContaining({ reason: 'title-identity-mismatch' }),
            expect.objectContaining({ reason: 'year-mismatch' }),
          ],
        }),
      }),
    )
  })

  it.each([
    { results: [] },
    { results: [{ ...pripyat, link: 'https://unrelated.invalid/album/' }] },
  ])(
    'uses the second search for a natural query when the site query has no eligible URL',
    async (first) => {
      const request = replies(first, { results: [pripyat] })
      const output = await scrape(context(undefined, { request }))
      expect(request).toHaveBeenCalledTimes(2)
      expect(
        new URL(String(request.mock.calls[1]?.[0])).searchParams.get('q'),
      ).toBe('Marina Herlop Pripyat Rate Your Music rating genres')
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
        ratingRymValue: 3.4,
      })
    },
  )

  it('retains both unsuccessful searches and still throws a typed miss after two queries', async () => {
    const recordDiagnostic =
      vi.fn<NonNullable<MediaPluginScrapeContext['recordDiagnostic']>>()
    const request = replies(
      { results: [] },
      { results: [{ ...pripyat, link: 'https://unrelated.invalid/' }] },
    )
    await expect(
      scrape(context(undefined, { request, recordDiagnostic })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(2)
    expect(recordDiagnostic).toHaveBeenCalledTimes(4)
    expect(recordDiagnostic.mock.calls[1]?.[0]).toMatchObject({
      evidence: { resultCount: 0 },
    })
    expect(recordDiagnostic.mock.calls[3]?.[0]).toMatchObject({
      evidence: { reasons: { 'invalid-url': 1 } },
    })
  })

  it('keeps the exact-URL second query when a saved reference exists, even after an empty result', async () => {
    const request = replies({ results: [] }, { results: [pripyat] })
    await scrape(
      context(undefined, {
        request,
        existingReferences: [
          {
            referenceType: 'rym-url',
            externalId: pripyatUrl,
            isPrimary: true,
          },
        ],
      }),
    )
    expect(request).toHaveBeenCalledTimes(2)
    expect(
      new URL(String(request.mock.calls[1]?.[0])).searchParams.get('q'),
    ).toBe(`site:${pripyatUrl}`)
  })

  it('records missing usable fields separately from identity rejection and preserves the two-search cap', async () => {
    const recordDiagnostic =
      vi.fn<NonNullable<MediaPluginScrapeContext['recordDiagnostic']>>()
    const request = replies({
      results: [
        {
          link: pripyatUrl,
          title: 'Pripyat by Marina Herlop (Album)',
          description: '',
        },
      ],
    })
    await expect(
      scrape(context(undefined, { request, recordDiagnostic })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(2)
    expect(recordDiagnostic.mock.calls[1]?.[0]).toMatchObject({
      evidence: {
        reasons: { 'no-rating-or-genres': 1 },
        candidates: [
          { reason: 'no-rating-or-genres', response: { link: pripyatUrl } },
        ],
      },
    })
  })

  it('bounds and redacts indexed response samples while retaining full rejection counts', async () => {
    const recordDiagnostic =
      vi.fn<NonNullable<MediaPluginScrapeContext['recordDiagnostic']>>()
    const payload = {
      results: Array.from({ length: 100 }, () => ({
        ...pripyat,
        link: 'https://unrelated.invalid/path?token=never-retain',
        description: `offline-key ${'text '.repeat(150)}`,
        metadata: { rating: 'offline-key', password: 'private-metadata' },
        headers: { Authorization: 'private-header' },
      })),
    }
    await expect(
      scrape(context(payload, { recordDiagnostic })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    const diagnostic = recordDiagnostic.mock.calls[1]?.[0]
    expect(diagnostic).toMatchObject({
      evidence: { resultCount: 100, reasons: { 'invalid-url': 100 } },
    })
    const serialized = JSON.stringify(diagnostic)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192)
    for (const secret of [
      'offline-key',
      'never-retain',
      'private-metadata',
      'private-header',
    ])
      expect(serialized).not.toContain(secret)
    expect(serialized).toContain('[REDACTED]')
  })

  it('cannot change lookup classification when recording diagnostics fails', async () => {
    const recordDiagnostic = () => {
      throw new Error('Diagnostic sink failed')
    }
    await expect(
      scrape(context({ results: [] }, { recordDiagnostic })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    await expect(
      scrape(context({}, { recordDiagnostic })),
    ).rejects.not.toBeInstanceOf(ProviderItemNotFoundError)
    await expect(
      scrape(context({ error: 'Service unavailable' }, { recordDiagnostic })),
    ).rejects.toMatchObject({
      name: 'ProviderRequestError',
      code: 'request-failed',
    })
    const request = vi.fn<MediaPluginScrapeContext['request']>(async () =>
      Response.json({ message: 'Service unavailable' }, { status: 429 }),
    )
    await expect(
      scrape(context(undefined, { request, recordDiagnostic })),
    ).rejects.toMatchObject({
      name: 'ProviderRequestError',
      code: 'rate-limit',
    })
  })

  it('registers the searchable album provider and its API-key credential', () => {
    expect(
      MediaPluginManifestSchema.parse(serplyPlugin.manifest),
    ).toMatchObject({
      id: 'serply',
      mediaTypes: ['album'],
      identifierTypes: ['rym-url'],
      supportsNameLookup: true,
      rateLimit: {
        maxConcurrent: 2,
        concurrentRequests: true,
        minTimeMs: 250,
        configurableRequestBudget: true,
      },
    })
    expect(serplyPlugin.manifest.secrets).toEqual([
      expect.objectContaining({
        key: 'apiKey',
        required: true,
        envVars: ['SERPLY_API_KEY'],
      }),
    ])
    expect(getBuiltinScrapePlugin('serply')).toBe(serplyPlugin)
    expect(
      getBuiltinProviderCatalog().find((entry) => entry.id === 'serply'),
    ).toMatchObject({
      supportsScrape: true,
      supportsLegacyImport: false,
    })
    expect(serplyPlugin.testConnection).toBeUndefined()
  })

  it('imports the supplied Pripyat rich result through the search gateway', async () => {
    const request = replies({ results: [pripyat] })
    const output = await scrape(context(undefined, { request }))
    expect(
      new URL(String(request.mock.calls[0]?.[0])).searchParams.get('q'),
    ).toBe('site:rateyourmusic.com Marina Herlop Pripyat')
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
      ratingRymVotes: 1836,
    })
    expect(
      output.normalized.tags
        .filter((tag) => tag.kind === 'genre')
        .map((tag) => tag.name),
    ).toEqual(['Glitch Pop', 'Avant-Folk'])
    expect(output.normalized.links).toContainEqual(
      expect.objectContaining({ url: pripyatUrl }),
    )
    expect(output.normalized.mediaPatch?.title).toBeUndefined()
    expect(JSON.stringify(output)).not.toContain('offline-key')
    expect(request.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it.each(['4', '3.4', 3.4])(
    'accepts a valid rich-result score without requiring two decimals: %s',
    async (rating) => {
      const output = await scrape(
        context({
          results: [{ ...pripyat, metadata: { rating, reviews: '1,836' } }],
        }),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
        ratingRymValue: Number(rating),
        ratingRymVotes: 1836,
      })
    },
  )

  it('keeps a supported score when its vote count is unknown', async () => {
    const output = await scrape(
      context({ results: [{ ...pripyat, metadata: { rating: '3.4' } }] }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
      ratingRymVotes: null,
    })
  })

  it('accepts explicit genres without requiring a score or descriptors', async () => {
    const output = await scrape(
      context({ results: [{ ...pripyat, metadata: {} }] }),
    )
    expect(
      output.normalized.tags
        .filter((tag) => tag.kind === 'genre')
        .map((tag) => tag.name),
    ).toEqual(['Glitch Pop', 'Avant-Folk'])
    expect(JSON.stringify(output.normalized)).not.toContain('folktronica')
  })

  it('accepts an explicitly bounded title genre when the snippet has none', async () => {
    const output = await scrape(
      context({ results: [{ ...pripyat, description: '', metadata: {} }] }),
    )
    expect(
      output.normalized.tags
        .filter((tag) => tag.kind === 'genre')
        .map((tag) => tag.name),
    ).toEqual(['Glitch Pop'])
  })

  it.each(['...', '…'])(
    'does not turn a truncated genre into a tag: %s',
    async (ellipsis) => {
      const output = await scrape(
        context({
          results: [
            {
              ...pripyat,
              description: `Pripyat, an Album by Marina Herlop. Genres: Glitch Pop, Avant${ellipsis}`,
            },
          ],
        }),
      )
      expect(
        output.normalized.tags
          .filter((tag) => tag.kind === 'genre')
          .map((tag) => tag.name),
      ).toEqual(['Glitch Pop'])
    },
  )

  it.each(['-1', '5.1', 'not-a-rating'])(
    'keeps usable genres without publishing an invalid score: %s',
    async (rating) => {
      const output = await scrape(
        context({
          results: [
            {
              ...pripyat,
              metadata: { rating, reviews: '1,836' },
            },
          ],
        }),
      )
      expect(
        output.normalized.mediaPatch?.metadata?.['browse'],
      ).not.toHaveProperty('ratingRymValue')
      expect(output.normalized.tags).toContainEqual(
        expect.objectContaining({ name: 'Glitch Pop', kind: 'genre' }),
      )
    },
  )

  it('does not let an undecodable candidate URL hide a later valid result', async () => {
    const output = await scrape(
      context({
        results: [
          {
            ...pripyat,
            link: 'https://rateyourmusic.com/release/album/marina-herlop/%E0%A4%A/',
          },
          pripyat,
        ],
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
      ratingRymVotes: 1836,
    })
  })

  it('prefers the explicit Bon Iver aggregate over rounded metadata', async () => {
    const output = await scrape(
      context(
        { results: [bonIver] },
        {
          media: { title: 'For Emma, Forever Ago', artists: ['Bon Iver'] },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.82,
      ratingRymVotes: 28461,
    })
    expect(output.normalized.tags.map((tag) => tag.name)).not.toContain(
      'Singer-Songwriter Psychedelic Folk',
    )
  })

  it('accepts a review-page aggregate while withholding merged genre text', async () => {
    const output = await scrape(
      context(
        { results: [souvlakiReview] },
        {
          media: { title: 'Souvlaki', artists: ['Slowdive'] },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 4.15,
      ratingRymVotes: 63727,
    })
    expect(output.normalized.tags.map((tag) => tag.name)).not.toContain(
      'Shoegaze Space Rock Revival',
    )
    expect(output.normalized.tags.map((tag) => tag.name)).toContain('Dream Pop')
    expect(output.normalized.links).toContainEqual(
      expect.objectContaining({ url: souvlakiReview.link }),
    )
    expect(output.normalized.references).toContainEqual(
      expect.objectContaining({
        referenceType: 'rym-url',
        externalId: souvlakiReview.link,
      }),
    )
  })

  it('retains the complete first genre from the live Pripyat indexed header', async () => {
    const output = await scrape(
      context({
        results: [
          {
            title: 'Review for Pripyat - Marina Herlop by ListigSpindel',
            link: 'https://rateyourmusic.com/music-review/ListigSpindel/marina-herlop/pripyat/234264299',
            description:
              '3.44 from 1,799 ratings Genres Glitch Pop, Avant-Folk Folktronica, Choral, Deconstructed Club, Art Pop Descriptors avant-garde, female vocalist, suspenseful, ...',
            metadata: {},
          },
        ],
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.44,
      ratingRymVotes: 1799,
    })
    expect(output.normalized.tags.map((tag) => tag.name)).toEqual([
      'Glitch Pop',
    ])
  })

  it('keeps the first matching review rating and count together', async () => {
    const output = await scrape(
      context(
        {
          results: [
            souvlakiReview,
            {
              ...souvlakiReview,
              link: 'https://rateyourmusic.com/music-review/NoahIsCool/slowdive/souvlaki/43098687',
              title: 'Review for Souvlaki - Slowdive by NoahIsCool',
              description: 'Slowdive 4.16 from 64,000 ratings',
            },
          ],
        },
        {
          media: { title: 'Souvlaki', artists: ['Slowdive'] },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 4.15,
      ratingRymVotes: 63727,
    })
  })

  it('prefers the canonical album over earlier edition results', async () => {
    const edition = {
      ...bonIver,
      link: bonIverUrl.replace('forever-ago/', 'forever-ago-6/'),
      title:
        'For Emma, Forever Ago by Bon Iver (Album; Rogue) - Rate Your Music',
      description: 'Rating 4.13 / 5.00.5 from 428 ratings',
      metadata: { rating: '4.1', reviews: '428' },
    }
    const output = await scrape(
      context(
        { results: [edition, bonIver] },
        {
          media: { title: 'For Emma, Forever Ago', artists: ['Bon Iver'] },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.82,
      ratingRymVotes: 28461,
    })
    expect(output.normalized.links).toContainEqual(
      expect.objectContaining({ url: bonIverUrl }),
    )
  })

  it('recovers explicit genres with one bounded canonical-site search', async () => {
    const canonical = {
      link: souvlakiUrl,
      title: 'Souvlaki by Slowdive (Album) - Rate Your Music',
      description: 'RYM Rating 4.15 from 63,727 ratings',
      metadata: {},
    }
    const request = replies(
      { results: [canonical] },
      {
        results: [
          {
            ...canonical,
            link: `${souvlakiUrl}reviews/54/`,
            title: 'Reviews of Souvlaki by Slowdive (Album, Dream Pop) ...',
            description:
              'Souvlaki, an Album by Slowdive. Released 1 June 1993. Genres: Dream Pop, Shoegaze. Rated #2 in the best albums of ...',
          },
        ],
      },
    )
    const output = await scrape(
      context(undefined, {
        media: { title: 'Souvlaki', artists: ['Slowdive'] },
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(2)
    expect(
      new URL(String(request.mock.calls[1]?.[0])).searchParams.get('q'),
    ).toBe(`site:${souvlakiUrl}`)
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 4.15,
      ratingRymVotes: 63727,
    })
    expect(
      output.normalized.tags
        .filter((tag) => tag.kind === 'genre')
        .map((tag) => tag.name),
    ).toEqual(['Dream Pop', 'Shoegaze'])
  })

  it.each([
    'https://rateyourmusic.com.evil.example/release/album/marina-herlop/pripyat/',
    'https://www.google.com/goto?url=opaque-target',
    'https://rateyourmusic.com/~a-reviewer',
    'https://rateyourmusic.com/song/marina-herlop/as-meigas/',
    'https://retailer.example/pripyat',
  ])(
    'ignores a matching-looking result with an ineligible URL: %s',
    async (link) => {
      await expect(
        scrape(context({ results: [{ ...pripyat, link }] })),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it('does not accept a different album behind a matching URL', async () => {
    await expect(
      scrape(
        context({
          results: [
            {
              ...pripyat,
              title:
                'Dja Dja by Marina Herlop (Album, Avant-Folk) - Rate Your Music',
              description:
                'Dja Dja, an Album by Marina Herlop. Genres: Avant-Folk.',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it.each([false, true])(
    'rejects a contradictory result title even when its URL matches, saved reference=%s',
    async (saved) => {
      const ctx = context(
        {
          results: [
            {
              ...pripyat,
              title:
                'Dja Dja by Marina Herlop (Album, Avant-Folk) - Rate Your Music',
              description:
                'RYM Rating 3.4 from 1,836 ratings Genres: Avant-Folk.',
            },
          ],
        },
        {
          existingReferences: saved
            ? [
                {
                  referenceType: 'rym-url',
                  externalId: pripyatUrl,
                  isPrimary: true,
                  metadata: { sourceProvider: 'serply' },
                },
              ]
            : [],
        },
      )
      await expect(scrape(ctx)).rejects.toBeInstanceOf(
        ProviderItemNotFoundError,
      )
    },
  )

  it('withholds a known conflicting release year', async () => {
    await expect(
      scrape(
        context(undefined, {
          media: {
            title: 'Pripyat',
            artists: ['Marina Herlop'],
            releaseDate: '1997-01-01',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('accepts matching release years without requiring exact date precision', async () => {
    const output = await scrape(
      context(undefined, {
        media: {
          title: 'Pripyat',
          artists: ['Marina Herlop'],
          releaseDate: '2022-01-01',
        },
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
      ratingRymVotes: 1836,
    })
  })

  it('does not mistake a personal review score for an aggregate', async () => {
    await expect(
      scrape(
        context(
          {
            results: [
              {
                ...souvlakiReview,
                description:
                  'I give this record 4.5 stars. My favourite album.',
              },
            ],
          },
          {
            media: { title: 'Souvlaki', artists: ['Slowdive'] },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('reports a validated empty search as a benign miss', async () => {
    const request = replies({ results: [] })
    await expect(
      scrape(context(undefined, { request })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it.each([{}, { results: null }, { results: 'invalid' }])(
    'does not treat malformed search envelopes as benign misses: %j',
    async (payload) => {
      let failure: unknown
      try {
        await scrape(context(payload))
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it.each([
    { status: 401, code: 'access-denied' },
    { status: 429, code: 'rate-limit' },
    { status: 503, code: 'request-failed' },
  ])(
    'preserves HTTP $status failures without a fallback request',
    async ({ status, code }) => {
      const request = vi.fn<MediaPluginScrapeContext['request']>(async () =>
        Response.json({ message: 'Service unavailable' }, { status }),
      )
      await expect(
        scrape(context(undefined, { request })),
      ).rejects.toMatchObject({
        name: 'ProviderRequestError',
        code,
      })
      expect(request).toHaveBeenCalledTimes(1)
    },
  )

  it('preserves gateway errors and their retry time', async () => {
    const diagnostics = createJobDiagnostics([])
    const error = new ProviderRequestError(
      'Shared budget exhausted',
      'rate-limit',
      1793156460000,
    )
    const request = vi.fn<MediaPluginScrapeContext['request']>(async () => {
      throw error
    })
    await expect(
      scrape(
        context(undefined, {
          request,
          recordDiagnostic: diagnostics.recordDiagnostic,
        }),
      ),
    ).rejects.toBe(error)
    expect(request).toHaveBeenCalledTimes(1)
    expect(diagnostics.snapshot()).toEqual([])
  })

  it.each([429, 503])(
    'propagates an optional second-search HTTP %s error after a usable partial result',
    async (status) => {
      const diagnostics = createJobDiagnostics([])
      let calls = 0
      const request = vi.fn<MediaPluginScrapeContext['request']>(async () => {
        calls += 1
        if (calls === 1) return Response.json({ results: [souvlakiReview] })
        return Response.json({ message: 'Service unavailable' }, { status })
      })
      await expect(
        scrape(
          context(undefined, {
            media: { title: 'Souvlaki', artists: ['Slowdive'] },
            request,
            recordDiagnostic: diagnostics.recordDiagnostic,
          }),
        ),
      ).rejects.toMatchObject({
        name: 'ProviderRequestError',
        code: status === 429 ? 'rate-limit' : 'request-failed',
      })
      expect(request).toHaveBeenCalledTimes(2)
      const responses = diagnostics
        .snapshot()
        .map((entry) => PluginDiagnosticSchema.parse(entry))
        .filter((entry) => entry.stage === 'serply.response')
      expect(responses).toHaveLength(2)
      expect(responses[0]).toMatchObject({
        evidence: { status: 200, response: { results: [souvlakiReview] } },
      })
      expect(responses[1]).toMatchObject({
        evidence: { status, response: { message: 'Service unavailable' } },
      })
    },
  )
})
