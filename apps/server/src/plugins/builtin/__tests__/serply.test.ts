import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MediaPluginManifestSchema,
  PluginDiagnosticSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { extractSerplyAlbumTags, serplyPlugin } from '../serply'
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

const hexalogy = {
  link: 'https://rateyourmusic.com/release/comp/nujabes-feat-shing02/luv_sic-hexalogy/',
  title: 'Luv(sic) Hexalogy by Nujabes feat. Shing02 (Compilation, Jazz Rap)',
  description:
    'Luv(sic) Hexalogy, a Compilation of songs by Nujabes feat. Shing02. Released 9 December 2015 on Hydeout (catalog no. HPD-18; CD).',
  metadata: { rating: '4.3', reviews: '8,321', published_time: 'Dec 9, 2015' },
}
const fabricMix = {
  link: 'https://rateyourmusic.com/release/djmix/pretty-girl/fabric-presents/',
  title:
    'fabric Presents by Pretty Girl (DJ Mix, Deep House) - Rate Your Music',
  description:
    'Genres: Deep House, Progressive House. Rating 3.15 / 5.00.5 from 12 ratings Ranked #293 for 2025, #7,223 overall Genres Deep House, Progressive ...',
  metadata: { rating: '3.2', reviews: '12', published_time: 'Jun 20, 2025' },
}
const dumb = {
  link: 'https://rateyourmusic.com/release/album/emma-louise-flume/dumb/',
  title: 'Dumb by Emma Louise & Flume (Album, Future Bass)',
  description:
    'Dumb, an Album by Emma Louise & Flume. Released 22 August 2025 on n/a. Genres: Future Bass, Alt-Pop, Alternative R&B.',
  metadata: { rating: '3.0', reviews: '550', published_time: 'Aug 22, 2025' },
}

function replies(...payloads: unknown[]) {
  let index = 0
  return vi.fn<MediaPluginScrapeContext['request']>(async (input, init) => {
    if (index >= 6) throw new Error('Exceeded six-search request bound')
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
  it('evaluates the fresh date-prefixed One Battle result with six exact-query responses and no stale rating', async () => {
    const title =
      'One Battle After Another (Original Motion Picture Soundtrack)'
    const link =
      'https://rateyourmusic.com/release/album/jonny-greenwood/one-battle-after-another/'
    const fresh = {
      link,
      title: 'One Battle After Another by Jonny Greenwood',
      description:
        'Sep 26, 2025 — One Battle After Another, an Album by Jonny Greenwood. Released 26 September 2025 on Nonesuch. Genres: Film Score, Modern Classical.',
      metadata: {},
    }
    const expected = [
      `site:rateyourmusic.com Jonny Greenwood ${title}`,
      `site:${link}`,
      `site:rateyourmusic.com/release/ Jonny Greenwood ${title}`,
      `site:rateyourmusic.com/release/ "Jonny Greenwood" "${title}"`,
      `Jonny Greenwood ${title} Rate Your Music rating genres`,
      'Jonny Greenwood One Battle After Another Rate Your Music rating genres',
    ]
    const responses = new Map(
      expected.map((query) => [
        query,
        { results: query === `site:${link}` ? [fresh] : [] },
      ]),
    )
    const request = vi.fn<MediaPluginScrapeContext['request']>(
      async (input) => {
        const query = new URL(input).searchParams.get('q')
        const response = query ? responses.get(query) : undefined
        if (!response) throw new Error(`Unexpected query: ${query}`)
        return Response.json(response)
      },
    )
    const output = await scrape(
      context(undefined, {
        media: {
          title,
          artists: ['Jonny Greenwood'],
          releaseDate: '2025-09-26',
        },
        existingReferences: [
          {
            referenceType: 'rym-url',
            externalId: link,
            metadata: { sourceProvider: 'google-custom-search' },
            isPrimary: false,
          },
        ],
        request,
      }),
    )
    expect(
      request.mock.calls.map(([url]) => new URL(url).searchParams.get('q')),
    ).toEqual(expected)
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      matchStatus: 'genres-only',
      identityEvidence: 'soundtrack-role',
      sourceUrl: link,
      ratingSourceUrl: null,
    })
    expect(output.normalized.tags.map((tag) => tag.name)).toEqual([
      'Film Score',
      'Modern Classical',
    ])
    expect(output.payload).toMatchObject({
      searches: expect.arrayContaining([
        { query: `site:${link}`, response: { results: [fresh] } },
      ]),
    })
  })
  it.each([
    'Feb 30, 2025 — ',
    'Feb 29, 2025 — ',
    'Sep 32, 2025 — ',
    'Sep 26, 2025 ',
    'On Sep 26, 2025 — ',
    'Reviewed recently — ',
    'Septemberish 26, 2025 — ',
  ])('does not strip an invalid date or prose prefix: %s', async (prefix) => {
    await expect(
      scrape(
        context(
          {
            results: [
              {
                link: 'https://rateyourmusic.com/release/album/jonny-greenwood/one-battle-after-another/',
                title: 'One Battle After Another by Jonny Greenwood',
                description: `${prefix}One Battle After Another, an Album by Jonny Greenwood. Released 26 September 2025. Genres: Film Score.`,
              },
            ],
          },
          {
            media: {
              title:
                'One Battle After Another (Original Motion Picture Soundtrack)',
              artists: ['Jonny Greenwood'],
              releaseDate: '2025-09-26',
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it.each([
    'Live',
    'Deluxe Edition',
    'Remastered',
    'Remix',
    'Karaoke',
    'Instrumental',
  ])(
    'keeps %s substantive when the requested bilingual title is already native',
    async (qualifier) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: 'https://rateyourmusic.com/release/album/fixture-artist/%E5%A4%9C/',
                  title: `夜 [${qualifier}] by Fixture Artist (Album, Pop)`,
                  description: `夜 [${qualifier}], an Album by Fixture Artist. Released 6 September 2010. Genres: Pop.`,
                  metadata: { rating: 4, reviews: 100 },
                },
              ],
            },
            {
              media: {
                title: '夜',
                artists: ['Fixture Artist'],
                releaseDate: '2010-09-06',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each(['Deluxe Edition', 'Remastered', 'Live'])(
    'does not treat the qualifier %s as a bilingual title',
    async (title) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: 'https://rateyourmusic.com/release/album/fixture-artist/%E5%A4%9C/',
                  title: `夜 [${title}] by Fixture Artist (Album, Pop)`,
                  description: `夜 [${title}], an Album by Fixture Artist. Released 6 September 2010. Genres: Pop.`,
                  metadata: { rating: 4, reviews: 100 },
                },
              ],
            },
            {
              media: {
                title,
                artists: ['Fixture Artist'],
                releaseDate: '2010-09-06',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each(['before', 'after', 'later-query'])(
    'blocks the Dopamine untyped review when matching single evidence appears %s',
    async (order) => {
      const review = {
        link: 'https://rateyourmusic.com/music-review/Fastro/robyn/dopamine/271554843',
        title: 'Review for Dopamine - Robyn by Fastro - Rate Your Music',
        description: 'The song does not lift off.',
        metadata: { rating: '1.0' },
      }
      const single = {
        link: 'https://rateyourmusic.com/release/single/robyn/dopamine/',
        title: 'Dopamine by Robyn (Single, Dance-Pop) - Rate Your Music',
        description:
          'Dopamine, a Single by Robyn. Released 12 November 2025 on Young. Genres: Dance-Pop, Synthpop.',
        metadata: { rating: '3.6', reviews: '552' },
      }
      const request =
        order === 'later-query'
          ? replies({ results: [review] }, { results: [single] })
          : replies({
              results: order === 'before' ? [single, review] : [review, single],
            })
      await expect(
        scrape(
          context(undefined, {
            media: {
              title: 'Dopamine',
              artists: ['Robyn'],
              releaseDate: '2025-11-12',
            },
            request,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each([
    'Fixture Release, an Album by Fixture Artist. Released 6 September 2010. 3.39 from 297 ratings',
    '3.39 from 297 ratings',
  ])(
    'rejects an explicit Single review header despite description: %s',
    async (description) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: 'https://rateyourmusic.com/music-review/fixture/fixture-artist/fixture-release/123',
                  title:
                    'Fixture Release by Fixture Artist (Single, Electropop)',
                  description,
                  metadata: { rating: 4.5 },
                },
              ],
            },
            {
              media: {
                title: 'Fixture Release',
                artists: ['Fixture Artist'],
                releaseDate: '2010-09-06',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each([
    {
      title: 'DJ-Kicks: Other',
      artist: 'Modeselektor',
      date: '2025-09-12',
      kind: 'djmix',
    },
    {
      title: 'DJ-Kicks: Modeselektor',
      artist: 'Modeselektor',
      date: '2025-09-13',
      kind: 'djmix',
    },
    {
      title: 'DJ-Kicks: Modeselektor',
      artist: 'Modeselektor',
      date: undefined,
      kind: 'djmix',
    },
    {
      title: 'DJ-Kicks: Modeselektor (Live)',
      artist: 'Modeselektor',
      date: '2025-09-12',
      kind: 'djmix',
    },
    {
      title: 'DJ-Kicks: Modeselektor',
      artist: 'Modeselektor',
      date: '2025-09-12',
      kind: 'album',
    },
  ])(
    'keeps bare DJ mix composition bounded: %j',
    async ({ title, artist, date, kind }) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: `https://rateyourmusic.com/release/${kind}/modeselektor/dj-kicks/`,
                  title: `DJ-Kicks by Modeselektor (${kind === 'djmix' ? 'DJ Mix' : 'Album'}, IDM)`,
                  description: '',
                  metadata: {
                    rating: 3.4,
                    reviews: 100,
                    published_time: 'Sep 12, 2025',
                  },
                },
              ],
            },
            { media: { title, artists: [artist], releaseDate: date } },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each([
    ['Fixture (Part Two) (Deluxe Version)', 'Fixture (Part Two)'],
    ['Fixture - Other Album (2023 Remaster)', 'Fixture - Other Album'],
    ['Fixture (Deluxe Version) (Live)', 'Fixture (Deluxe Version) (Live)'],
    ['Fixture [Deluxe Version]', 'Fixture'],
    ['Fixture - Deluxe Version', 'Fixture'],
    ['(Deluxe Version)', '(Deluxe Version)'],
  ])(
    'preserves semantic title structure while cleaning: %s',
    async (title, cleaned) => {
      const request = replies({ results: [] })
      await expect(
        scrape(
          context(undefined, {
            media: { title, artists: ['Artist'] },
            request,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
      expect(
        request.mock.calls.map(([url]) => new URL(url).searchParams.get('q')),
      ).toContain(`site:rateyourmusic.com/release/ Artist ${cleaned}`)
    },
  )
  it('round-trips the exact owned typed EP review reference', async () => {
    const payload = {
      results: [
        {
          link: 'https://rateyourmusic.com/music-review/Iai/pariah/safehouses-ep/33541137',
          title: 'Review for Safehouses EP - Pariah by Iai',
          description:
            'Safehouses EP, an EP by Pariah. Released 6 September 2010. 3.39 from 297 ratings',
          metadata: { rating: 3.5 },
        },
      ],
    }
    const media = {
      title: 'Safehouses EP',
      artists: ['Pariah'],
      releaseDate: '2010-09-06',
    }
    const first = await scrape(context(payload, { media }))
    const second = await scrape(
      context(payload, {
        media,
        existingReferences: first.normalized.references.map((ref) => ({
          ...ref,
          metadata: { sourceProvider: 'serply' },
        })),
      }),
    )
    expect(second.normalized.mediaPatch?.metadata?.['browse']).toEqual(
      first.normalized.mediaPatch?.metadata?.['browse'],
    )
    expect(second.normalized.references).toEqual(first.normalized.references)
  })
  it.each([
    [
      'Let It Bleed (50th Anniversary Edition / Remastered 2019)',
      'Let It Bleed',
    ],
    [
      'More Songs About Buildings and Food (Deluxe Version)',
      'More Songs About Buildings and Food',
    ],
    ['Epoch (Deluxe Version)', 'Epoch'],
    [
      'Keep It Unreal (10th Anniversary Analogue Remaster Edition)',
      'Keep It Unreal',
    ],
    [
      'SMASH – The Singles 1985 – 2020 (2023 Remaster)',
      'SMASH – The Singles 1985 – 2020',
    ],
    ['Elaenia (10 Year Anniversary)', 'Elaenia'],
  ])(
    'cleans the reviewed edition label in fallback queries: %s',
    async (title, cleaned) => {
      const request = replies({ results: [] })
      await expect(
        scrape(
          context(undefined, {
            media: { title, artists: ['Artist'] },
            request,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
      const queries = request.mock.calls.map(([url]) =>
        new URL(url).searchParams.get('q'),
      )
      expect(queries[0]).toBe(`site:rateyourmusic.com Artist ${title}`)
      expect(queries).toContain(
        `site:rateyourmusic.com/release/ Artist ${cleaned}`,
      )
      expect(request.mock.calls.length).toBeLessThanOrEqual(5)
    },
  )
  it.each([
    'Anniversary Edition / Live',
    'Deluxe Version / Karaoke Version',
    '50th Anniversary Edition / Remastered 2019 / Live',
    'Deluxe Live Version',
    '10th Anniversary Analogue Live Edition',
    '2025',
    '10 Year Anniversary Live',
  ])('preserves unsupported edition-like qualifiers: %s', async (label) => {
    const title = `Fixture (${label})`
    const request = replies({ results: [] })
    await expect(
      scrape(
        context(undefined, { media: { title, artists: ['Artist'] }, request }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(
      request.mock.calls.map(([url]) => new URL(url).searchParams.get('q')),
    ).toContain(`site:rateyourmusic.com/release/ Artist ${title}`)
  })
  it('matches an exact typed DJ mix title/artist composition without a DJ Mix suffix', async () => {
    const output = await scrape(
      context(
        {
          results: [
            {
              link: 'https://rateyourmusic.com/release/djmix/modeselektor/dj-kicks/',
              title: 'DJ-Kicks by Modeselektor (DJ Mix, IDM)',
              description:
                'DJ-Kicks, a DJ Mix by Modeselektor. Released 12 September 2025 on !K7.',
              metadata: { rating: 3.4, reviews: 100 },
            },
          ],
        },
        {
          media: {
            title: 'DJ-Kicks: Modeselektor',
            artists: ['Modeselektor'],
            releaseDate: '2025-09-12',
          },
        },
      ),
    )
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({ identityEvidence: 'djmix-title-composition' })
  })
  it.each([
    {
      title: 'Lazarus (Adult Swim Original Series Soundtrack)',
      queryTitle: 'Lazarus',
    },
    {
      title: 'fabric presents Pretty Girl (DJ Mix)',
      queryTitle: 'fabric presents Pretty Girl',
    },
    { title: 'Lazarus (Live)', queryTitle: 'Lazarus (Live)' },
  ])(
    'simplifies only known search-only role suffixes: $title',
    async ({ title, queryTitle }) => {
      const request = replies({ results: [] })
      await expect(
        scrape(
          context(undefined, {
            media: { title, artists: ['Artist'] },
            request,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
      const queries = request.mock.calls.map(([url]) =>
        new URL(url).searchParams.get('q'),
      )
      expect(queries[0]).toBe(`site:rateyourmusic.com Artist ${title}`)
      expect(queries).toContain(
        `site:rateyourmusic.com/release/ "Artist" "${title}"`,
      )
      expect(queries).toContain(`Artist ${title} Rate Your Music rating genres`)
      expect(queries).toContain(
        `Artist ${queryTitle} Rate Your Music rating genres`,
      )
      expect(request.mock.calls.length).toBeLessThanOrEqual(5)
    },
  )
  it('keeps an explicit EP override while withholding a review personal rating', async () => {
    const link =
      'https://rateyourmusic.com/music-review/Iai/pariah/safehouses-ep/33541137'
    const root = 'https://rateyourmusic.com/release/ep/pariah/safehouses-ep/'
    const output = await scrape(
      context(
        {
          results: [
            {
              link,
              title: 'Review for Safehouses EP - Pariah by Iai',
              description:
                'The only frustrating thing is that it really feels like an EP.',
              metadata: { rating: 3.5 },
            },
          ],
        },
        {
          media: { title: 'Safehouses', artists: ['Pariah'] },
          existingReferences: [
            {
              referenceType: 'rym-url',
              externalId: root,
              isPrimary: true,
              metadata: { sourceProvider: 'serply', manualOverride: true },
            },
          ],
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      releaseUrl: root,
      releaseKind: 'ep',
      matchStatus: 'identity-only',
    })
  })
  it('does not resolve an explicitly typed EP review to a conflicting owned album', async () => {
    await expect(
      scrape(
        context(
          {
            results: [
              {
                link: 'https://rateyourmusic.com/music-review/Iai/pariah/safehouses-ep/33541137',
                title: 'Review for Safehouses EP - Pariah by Iai',
                description:
                  'Safehouses EP, an EP by Pariah. Released 6 September 2010. 3.39 from 297 ratings',
              },
            ],
          },
          {
            media: { title: 'Safehouses EP', artists: ['Pariah'] },
            existingReferences: [
              {
                referenceType: 'rym-url',
                externalId:
                  'https://rateyourmusic.com/release/album/pariah/safehouses-ep/',
                isPrimary: true,
                metadata: { sourceProvider: 'serply', manualOverride: true },
              },
            ],
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it.each(['single', 'song'])(
    'does not reinterpret a %s URL via a bilingual title',
    async (kind) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: `https://rateyourmusic.com/${kind === 'song' ? 'song' : 'release/single'}/%E6%98%8E%E6%97%A5%E3%81%AE%E5%8F%99%E6%99%AF/think-of-you/`,
                  title:
                    'Think of You by 明日の叙景 [Asunojokei] - Rate Your Music',
                  description:
                    'Think of You, an Album by 明日の叙景. Released 6 August 2025.',
                  metadata: { rating: 3.6, reviews: 1906 },
                },
              ],
            },
            {
              media: {
                title: 'Think of You',
                artists: ['Asunojokei'],
                releaseDate: '2025-08-06',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it('does not infer release kind merely from an EP title suffix', async () => {
    const link =
      'https://rateyourmusic.com/music-review/Iai/pariah/safehouses-ep/33541137'
    const output = await scrape(
      context(
        {
          results: [
            {
              link,
              title: 'Review for Safehouses EP - Pariah by Iai',
              description: '3.39 from 297 ratings',
              metadata: { rating: 3.5 },
            },
          ],
        },
        { media: { title: 'Safehouses EP', artists: ['Pariah'] } },
      ),
    )
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({ releaseUrl: `${link}/`, releaseKind: null })
  })
  it.each(['Film Score', 'Modern Classical'])(
    'requires explicit Film Score role, not merely classical music: %s',
    async (genre) => {
      const ctx = context(
        {
          results: [
            {
              link: 'https://rateyourmusic.com/release/album/jonny-greenwood/one-battle-after-another/',
              title: `One Battle After Another by Jonny Greenwood (Album, ${genre})`,
              description:
                'Track listing ; 1 One Battle After Another 3:09 ; 2 The French 75 1:30.',
              metadata: {
                rating: '3.8',
                reviews: '748',
                published_time: 'Sep 26, 2025',
              },
            },
          ],
        },
        {
          media: {
            title:
              'One Battle After Another (Original Motion Picture Soundtrack)',
            artists: ['Jonny Greenwood'],
            releaseDate: '2025-09-26',
          },
        },
      )
      if (genre !== 'Film Score') {
        await expect(scrape(ctx)).rejects.toBeInstanceOf(
          ProviderItemNotFoundError,
        )
        return
      }
      const output = await scrape(ctx)
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.8,
        ratingRymVotes: 748,
      })
    },
  )
  it('does not infer soundtrack identity from a fresh track listing alone', async () => {
    await expect(
      scrape(
        context(
          {
            results: [
              {
                link: 'https://rateyourmusic.com/release/album/floating-points/lazarus/',
                title: 'Lazarus by Floating Points - Rate Your Music',
                description:
                  'Track listing · 1 Mirror Pursuit 8:45. feat. Zongamin, Valentina Magaletti, Miriam Adefris · 2 Total Eclipse 3:25.',
                metadata: {
                  rating: '3.4',
                  reviews: '295',
                  published_time: 'Apr 11, 2025',
                },
              },
            ],
          },
          {
            media: {
              title: 'Lazarus (Adult Swim Original Series Soundtrack)',
              artists: ['Floating Points'],
              releaseDate: '2025-04-11',
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it.each([
    {
      title: 'Think of You',
      artist: 'Asunojokei',
      date: '2025-08-06',
      pathArtist: '明日の叙景',
      pathTitle: 'think-of-you',
      header: 'Think of You by 明日の叙景 [Asunojokei] - Rate Your Music',
      description:
        'Think of You, an Album by 明日の叙景. Released 6 August 2025. Genres: Post-Hardcore, Shimokita-kei.',
      rating: 3.6,
      votes: 1906,
    },
    {
      title: 'ANTICYCLONE',
      artist: '稲葉曇',
      date: '2019-11-17',
      pathArtist: '稲葉曇',
      pathTitle: 'アンチサイクロン',
      header: 'アンチサイクロン by 稲葉曇 [inabakumori] - RYM',
      description:
        'アンチサイクロン [Anticyclone], an Album by 稲葉曇 [inabakumori]. Released 17 November 2019 (catalog no. INBK-0001; CD).',
      rating: 3.6,
      votes: 1794,
    },
    {
      title: 'Honest Feeling Album',
      artist: 'Hakushi Hasegawa',
      date: '2026-08-28',
      pathArtist: '長谷川白紙',
      pathTitle: '素直な気持ちアルバム',
      header: 'By 長谷川白紙 - Honest Feeling Album - Rate Your Music',
      description:
        '素直な気持ちアルバム [Honest Feeling Album], an Album by 長谷川白紙 [Hakushi Hasegawa]. Released 28 August 2026 on Brainfeeder (catalog no.',
      rating: 3.6,
      votes: 2148,
    },
    {
      title: 'Laini Tani',
      artist: 'Nadah El Shazly',
      date: '2025-06-06',
      pathArtist: 'ندى-الشاذلي',
      pathTitle: 'لاقيني-تاني',
      header:
        'لاقيني تاني by ندى الشاذلي [Nadah el Shazly] (Album, Art Pop): Reviews ...',
      description:
        'لاقيني تاني [Laini tani], an Album by ندى الشاذلي [Nadah el Shazly]. Released 6 June 2025 on One Little Independent.',
      rating: 3.5,
      votes: 842,
    },
  ])(
    'uses explicit same-result bilingual evidence for $title',
    async (fixture) => {
      const link = `https://rateyourmusic.com/release/album/${encodeURIComponent(fixture.pathArtist)}/${encodeURIComponent(fixture.pathTitle)}/`
      const output = await scrape(
        context(
          {
            results: [
              {
                link,
                title: fixture.header,
                description: fixture.description,
                metadata: { rating: fixture.rating, reviews: fixture.votes },
              },
            ],
          },
          {
            media: {
              title: fixture.title,
              artists: [fixture.artist],
              releaseDate: fixture.date,
            },
          },
        ),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: fixture.rating,
        ratingRymVotes: fixture.votes,
      })
      expect(
        output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
      ).toMatchObject({
        identityEvidence: 'explicit-bilingual',
        sourceUrl: link,
      })
    },
  )
  it.each([
    {
      artist: 'Other',
      slug: '明日の叙景',
      pair: '明日の叙景 [Asunojokei]',
      date: '2025-08-06',
    },
    {
      artist: 'Asunojokei',
      slug: '別の名前',
      pair: '明日の叙景 [Asunojokei]',
      date: '2025-08-06',
    },
    {
      artist: 'Asunojokei',
      slug: '明日の叙景',
      pair: '明日の叙景 [Asunojokei]',
      date: '2025-08-07',
    },
    {
      artist: 'Asunojokei',
      slug: '明日の叙景',
      pair: '明日の叙景 [Asunojokei]',
      date: undefined,
    },
    {
      artist: 'Asunojokei',
      slug: '明日の叙景',
      pair: '明日の叙景 (Asunojokei)',
      date: '2025-08-06',
    },
    {
      artist: 'Asunojokei',
      slug: '明日の叙景',
      pair: '明日の叙景 [Asunojokei] [Other]',
      date: '2025-08-06',
    },
    {
      artist: 'Asunojokei',
      slug: 'another-band',
      pair: 'Another Band [Asunojokei]',
      date: '2025-08-06',
    },
  ])(
    'rejects uncorroborated bilingual evidence: %j',
    async ({ artist, slug, pair, date }) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: `https://rateyourmusic.com/release/album/${encodeURIComponent(slug)}/think-of-you/`,
                  title: `Think of You by ${pair} - Rate Your Music`,
                  description:
                    'Think of You, an Album by 明日の叙景. Released 6 August 2025.',
                  metadata: { rating: 3.6, reviews: 1906 },
                },
              ],
            },
            {
              media: {
                title: 'Think of You',
                artists: [artist],
                releaseDate: date,
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each([
    { label: 'conflicting translated title', translation: 'Other Album' },
    { label: 'conflicting native title', nativeTitle: '別の作品' },
    { label: 'conflicting native artist', nativeArtist: '別の名前' },
    { label: 'conflicting Latin artist', latinArtist: 'Other Artist' },
    { label: 'different date', date: '2026-08-29' },
    { label: 'missing date', date: '' },
    { label: 'different release kind', kind: 'EP' },
    {
      label: 'incomplete title pair',
      description:
        '素直な気持ちアルバム [Honest Feeling Album, an Album by 長谷川白紙 [Hakushi Hasegawa]. Released 28 August 2026.',
    },
    {
      label: 'incomplete artist pair',
      description:
        '素直な気持ちアルバム [Honest Feeling Album], an Album by 長谷川白紙 [Hakushi Hasegawa. Released 28 August 2026.',
    },
    {
      label: 'translation only in adjacent discography prose',
      description:
        'Previous in discography: 素直な気持ちアルバム [Honest Feeling Album], an Album by 長谷川白紙 [Hakushi Hasegawa]. Released 28 August 2026.',
    },
    {
      label: 'Latin-only artist header',
      header: 'By Hakushi Hasegawa - Honest Feeling Album - Rate Your Music',
    },
    {
      label: 'unrecognized header prefix',
      header: 'Related: By 長谷川白紙 - Honest Feeling Album - Rate Your Music',
    },
    {
      label: 'edition label',
      translation: 'Deluxe Edition',
      input: 'Deluxe Edition',
    },
    { label: 'performance label', translation: 'Live', input: 'Live' },
    { label: 'remaster label', translation: 'Remastered', input: 'Remastered' },
  ])('rejects reversed bilingual header with $label', async (fixture) => {
    const title = fixture.input ?? 'Honest Feeling Album'
    const nativeTitle = fixture.nativeTitle ?? '素直な気持ちアルバム'
    const nativeArtist = fixture.nativeArtist ?? '長谷川白紙'
    const latinArtist = fixture.latinArtist ?? 'Hakushi Hasegawa'
    const translation = fixture.translation ?? title
    await expect(
      scrape(
        context(
          {
            results: [
              {
                link: `https://rateyourmusic.com/release/album/${encodeURIComponent('長谷川白紙')}/${encodeURIComponent('素直な気持ちアルバム')}/`,
                title:
                  fixture.header ??
                  `By 長谷川白紙 - ${title} - Rate Your Music`,
                description:
                  fixture.description ??
                  `${nativeTitle} [${translation}], an ${fixture.kind ?? 'Album'} by ${nativeArtist} [${latinArtist}]. Released 28 August 2026.`,
                metadata: { rating: '3.6', reviews: '2,148' },
              },
            ],
          },
          {
            media: {
              title,
              artists: ['Hakushi Hasegawa'],
              releaseDate: fixture.date ?? '2026-08-28',
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it.each([
    'アンチサイクロン [Other Album], an Album by 稲葉曇 [inabakumori]. Released 17 November 2019.',
    '別の作品 [Anticyclone], an Album by 稲葉曇 [inabakumori]. Released 17 November 2019.',
    'アンチサイクロン [Anticyclone], an Album by 別の名前 [inabakumori]. Released 17 November 2019.',
    'アンチサイクロン [Anticyclone], an Album by 稲葉曇 [Other Artist]. Released 17 November 2019.',
    'アンチサイクロン [Anticyclone, an Album by 稲葉曇 [inabakumori]. Released 17 November 2019.',
    'Previous in discography: アンチサイクロン [Anticyclone], an Album by 稲葉曇 [inabakumori]. Released 17 November 2019.',
  ])(
    'rejects conflicting or incomplete - RYM evidence: %s',
    async (description) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: `https://rateyourmusic.com/release/album/${encodeURIComponent('稲葉曇')}/${encodeURIComponent('アンチサイクロン')}/`,
                  title: 'アンチサイクロン by 稲葉曇 [inabakumori] - RYM',
                  description,
                  metadata: { rating: '3.6', reviews: '1,794' },
                },
              ],
            },
            {
              media: {
                title: 'ANTICYCLONE',
                artists: ['稲葉曇'],
                releaseDate: '2019-11-17',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each(['10,000 Days', '10000 Days'])(
    'matches complete numeric grouping for %s without changing dates',
    async (title) => {
      const link = 'https://rateyourmusic.com/release/album/tool/10_000-days/'
      const output = await scrape(
        context(
          {
            results: [
              {
                link,
                title: '10000 Days by Tool (Album, Alternative Metal)',
                description:
                  '10000 Days, an Album by Tool. Released 2 May 2006. Genres: Alternative Metal, Progressive Metal.',
                metadata: { rating: 3.8, reviews: 24911 },
              },
            ],
          },
          { media: { title, artists: ['TOOL'], releaseDate: '2006-04-28' } },
        ),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.8,
        ratingRymVotes: 24911,
      })
      expect(output.normalized.mediaPatch?.releaseDate).toBeUndefined()
    },
  )
  it.each([
    '10 000 Days',
    '10,00 Days',
    '10_00 Days',
    '10001 Days',
    '10.000 Days',
    '10,000.5 Days',
    '10-000 Days',
  ])(
    'does not concatenate malformed or substantive numeric tokens: %s',
    async (title) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: 'https://rateyourmusic.com/release/album/tool/10000-days/',
                  title: '10000 Days by Tool (Album)',
                  metadata: { rating: 3.8, reviews: 24911 },
                },
              ],
            },
            { media: { title, artists: ['TOOL'] } },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it('does not invent an album root for an unknown-kind music review', async () => {
    const output = await scrape(
      context(
        { results: [souvlakiReview] },
        { media: { title: 'Souvlaki', artists: ['Slowdive'] } },
      ),
    )
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({ releaseUrl: `${souvlakiReview.link}/` })
  })
  it.each([false, true])(
    'resolves an EP review from coherent description or an owned EP URL: %s',
    async (owned) => {
      const link =
        'https://rateyourmusic.com/music-review/Iai/pariah/safehouses-ep/33541137'
      const root = 'https://rateyourmusic.com/release/ep/pariah/safehouses-ep/'
      const output = await scrape(
        context(
          {
            results: [
              {
                link,
                title: 'Review for Safehouses EP - Pariah by Iai',
                description: `${owned ? '' : 'Safehouses EP, an EP by Pariah. Released 6 September 2010. '}3.39 from 297 ratings`,
                metadata: { rating: 3.5 },
              },
            ],
          },
          {
            media: {
              title: 'Safehouses EP',
              artists: ['Pariah'],
              releaseDate: '2010-09-06',
            },
            existingReferences: owned
              ? [
                  {
                    referenceType: 'rym-url',
                    externalId: root,
                    isPrimary: true,
                    metadata: { sourceProvider: 'serply' },
                  },
                ]
              : [],
          },
        ),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.39,
        ratingRymVotes: 297,
      })
      expect(
        output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
      ).toMatchObject({ releaseUrl: root, ratingSourceUrl: link })
      expect(output.normalized.references[0]?.externalId).toBe(link)
    },
  )
  it.each(['Single', 'Song'])(
    'does not accept an unowned %s review as an album',
    async (kind) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: 'https://rateyourmusic.com/music-review/Iai/pariah/safehouses/33541137',
                  title: 'Review for Safehouses - Pariah by Iai',
                  description: `Safehouses, a ${kind} by Pariah. Released 6 September 2010. 3.39 from 297 ratings`,
                  metadata: { rating: 3.5 },
                },
              ],
            },
            {
              media: {
                title: 'Safehouses',
                artists: ['Pariah'],
                releaseDate: '2010-09-06',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it.each([
    { link: dumb.link, date: undefined },
    { link: dumb.link, date: '2025-08-23' },
    {
      link: dumb.link.replace('emma-louise-flume', 'emma-louise-unknown'),
      date: '2025-08-22',
    },
  ])(
    'requires the full joint-credit slug and date: %j',
    async ({ link, date }) => {
      await expect(
        scrape(
          context(
            { results: [{ ...dumb, link }] },
            {
              media: {
                title: 'DUMB',
                artists: ['Emma Louise', 'Flume'],
                releaseDate: date,
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )
  it('does not choose between different fully corroborated featured credits', async () => {
    const competing = {
      ...hexalogy,
      link: hexalogy.link.replace('shing02', 'other'),
      title: hexalogy.title.replace('Shing02', 'Other'),
      description: hexalogy.description.replace('Shing02', 'Other'),
    }
    await expect(
      scrape(
        context(
          { results: [hexalogy, competing] },
          {
            media: {
              title: 'Luv(sic) Hexalogy',
              artists: ['Nujabes'],
              releaseDate: '2015-12-09',
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it('does not discard additional supplied credits using a primary featured artist', async () => {
    await expect(
      scrape(
        context(
          { results: [hexalogy] },
          {
            media: {
              title: 'Luv(sic) Hexalogy',
              artists: ['Nujabes', 'Unknown'],
              releaseDate: '2015-12-09',
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it('does not take a DJ mix issue rating as the underlying release rating', async () => {
    await expect(
      scrape(
        context(
          {
            results: [
              {
                ...fabricMix,
                title: fabricMix.title.replace('(DJ Mix,', '(DJ Mix;'),
              },
            ],
          },
          {
            media: {
              title: 'fabric presents Pretty Girl (DJ Mix)',
              artists: ['Pretty Girl'],
              releaseDate: '2025-06-20',
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it('matches DUMB only with both explicitly supplied artists and the exact date', async () => {
    const output = await scrape(
      context(
        { results: [dumb] },
        {
          media: {
            title: 'DUMB',
            artists: ['Emma Louise', 'Flume'],
            releaseDate: '2025-08-22',
          },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 3,
      ratingRymVotes: 550,
    })
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      identityEvidence: 'combined-credits',
      corroboratedIdentity: {
        inputArtists: ['Emma Louise', 'Flume'],
        sourceArtist: 'Emma Louise & Flume',
      },
    })
  })
  it.each([
    ['Emma Louise'],
    ['Flume'],
    ['Emma Louise', 'Unknown'],
    ['Emma Louise', 'Flume', 'Unknown'],
  ])('does not infer missing joint credits from %j', async (...artists) => {
    await expect(
      scrape(
        context(
          { results: [dumb] },
          { media: { title: 'DUMB', artists, releaseDate: '2025-08-22' } },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })
  it('normalizes the captured 30 Year Anniversary Remastered suffix, not the vinyl qualifier', async () => {
    const canonical = {
      link: 'https://rateyourmusic.com/release/album/stars-of-the-lid/music-for-nitrous-oxide/',
      title:
        'Music for Nitrous Oxide by Stars of the Lid (Album, Drone) - Rate Your Music',
      description:
        'Released, 1995 ; Recorded, August 1993 - September 1994 ; RYM Rating, 3.36 / 5.00.5 from 1,926 ratings ; Ranked, #647 for 1995 ; Genres. Drone, Ambient',
      metadata: { rating: '3.4', reviews: '1,926' },
    }
    const output = await scrape(
      context(
        {
          results: [
            {
              ...canonical,
              link: canonical.link.replace(/\/$/, '-translucent-red-1/'),
              title:
                'Music for Nitrous Oxide [translucent red] by Stars of the Lid (Album)',
              metadata: { rating: '4.5', reviews: '1' },
            },
            canonical,
          ],
        },
        {
          media: {
            title: 'Music for Nitrous Oxide (30 Year Anniversary Remastered)',
            artists: ['Stars Of The Lid'],
            releaseDate: '2025-07-25',
          },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.36,
      ratingRymVotes: 1926,
    })
  })
  it.each([
    {
      inputTitle: 'Lazarus (Adult Swim Original Series Soundtrack)',
      artist: 'Floating Points',
      date: '2025-04-11',
      link: 'https://rateyourmusic.com/release/album/floating-points/lazarus/',
      title: 'Lazarus by Floating Points - Rate Your Music',
      description:
        'Type, Album ; Released, 11 April 2025 ; RYM Rating, 3.39 / 5.00.5 from 295 ratings ; Ranked, #1,087 for soundtracks ; Genres. Television Music, ...',
      published: 'Apr 11, 2025',
      rating: 3.39,
      votes: 295,
    },
    {
      inputTitle: 'TAKKUUK (Original Soundtrack)',
      artist: 'Bicep',
      date: '2025-07-25',
      link: 'https://rateyourmusic.com/release/album/bicep/takkuuk-original-soundtrack/',
      title: 'Takkuuk by Bicep (Album, Soundtrack) - Rate Your Music',
      description:
        'Track listing · 1 Alit 3:17. feat. Niilas · 2 Taarsitillugu 5:28.',
      published: 'Jul 25, 2025',
      rating: 3.4,
      votes: 102,
    },
  ])(
    'matches the captured soundtrack role only with corroboration: $inputTitle',
    async (fixture) => {
      const output = await scrape(
        context(
          {
            results: [
              {
                link: fixture.link,
                title: fixture.title,
                description: fixture.description,
                metadata: {
                  rating: fixture.rating,
                  reviews: fixture.votes,
                  published_time: fixture.published,
                },
              },
            ],
          },
          {
            media: {
              title: fixture.inputTitle,
              artists: [fixture.artist],
              releaseDate: fixture.date,
            },
          },
        ),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: fixture.rating,
        ratingRymVotes: fixture.votes,
      })
      expect(
        output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
      ).toMatchObject({
        identityEvidence: 'soundtrack-role',
        corroboratedIdentity: { inputTitle: fixture.inputTitle },
      })
    },
  )
  it.each([
    {
      title: 'TAKKUUK (Live)',
      artist: 'Bicep',
      date: '2025-07-25',
      genre: 'Soundtrack',
    },
    {
      title: 'TAKKUUK (Original Soundtrack)',
      artist: 'Other Composer',
      date: '2025-07-25',
      genre: 'Soundtrack',
    },
    {
      title: 'TAKKUUK (Original Soundtrack)',
      artist: 'Bicep',
      date: '2025-07-24',
      genre: 'Soundtrack',
    },
    {
      title: 'TAKKUUK (Original Soundtrack)',
      artist: 'Bicep',
      date: '2025-07-25',
      genre: 'Ambient',
    },
    {
      title: 'TAKKUUK (Original Soundtrack)',
      artist: 'Bicep',
      date: undefined,
      genre: 'Soundtrack',
    },
  ])(
    'does not erase soundtrack/other qualifiers without corroboration: %j',
    async ({ title, artist, date, genre }) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: 'https://rateyourmusic.com/release/album/bicep/takkuuk/',
                  title: `Takkuuk by Bicep (Album, ${genre})`,
                  description: '',
                  metadata: {
                    rating: 3.4,
                    reviews: 102,
                    published_time: 'Jul 25, 2025',
                  },
                },
              ],
            },
            { media: { title, artists: [artist], releaseDate: date } },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it('accepts the captured full featured credit only for its exact primary artist/title/date', async () => {
    const output = await scrape(
      context(
        { results: [hexalogy] },
        {
          media: {
            title: 'Luv(sic) Hexalogy',
            artists: ['Nujabes'],
            releaseDate: '2015-12-09',
          },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 4.3,
      ratingRymVotes: 8321,
    })
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      identityEvidence: 'featured-credit',
      corroboratedIdentity: {
        sourceArtist: 'Nujabes feat. Shing02',
        sourceDate: '2015-12-09',
      },
    })
  })

  it.each([
    { title: 'Luv(sic) Hexalogy', artist: 'Shing02', date: '2015-12-09' },
    { title: 'Luv(sic) Hexalogy', artist: 'Nujabes', date: '2014-12-09' },
    { title: 'Luv(sic) Hexalogy', artist: 'Nujabes', date: '2015-12-08' },
    { title: 'Luv(sic) Hexalogy', artist: 'Nujabes', date: undefined },
    { title: 'Luv Hexalogy', artist: 'Nujabes', date: '2015-12-09' },
    {
      title: 'Luv(sic) Hexalogy (Live)',
      artist: 'Nujabes',
      date: '2015-12-09',
    },
  ])(
    'rejects uncorroborated featured-credit input $title/$artist/$date',
    async ({ title, artist, date }) => {
      await expect(
        scrape(
          context(
            { results: [hexalogy] },
            { media: { title, artists: [artist], releaseDate: date } },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it.each([
    {
      title:
        'Luv(sic) Hexalogy by Shing02 feat. Nujabes (Compilation, Jazz Rap)',
      slug: 'shing02-feat-nujabes',
    },
    {
      title: 'Luv(sic) Hexalogy by Nujabes & Shing02 (Compilation, Jazz Rap)',
      slug: 'nujabes-and-shing02',
    },
    { title: hexalogy.title, slug: 'unrelated-artist' },
    {
      title:
        'Luv(sic) Hexalogy by Nujabes feat. Shing02 (Compilation; Hydeout)',
      slug: 'nujabes-feat-shing02',
    },
  ])(
    'rejects a different primary credit, unmarked collaboration or issue: $title',
    async ({ title, slug }) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  ...hexalogy,
                  title,
                  link: `https://rateyourmusic.com/release/comp/${slug}/luv_sic-hexalogy/`,
                },
              ],
            },
            {
              media: {
                title: 'Luv(sic) Hexalogy',
                artists: ['Nujabes'],
                releaseDate: '2015-12-09',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it('matches the captured explicit DJ mix title composition without stripping other qualifiers', async () => {
    const output = await scrape(
      context(
        { results: [fabricMix] },
        {
          media: {
            title: 'fabric presents Pretty Girl (DJ Mix)',
            artists: ['Pretty Girl'],
            releaseDate: '2025-06-20',
          },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.15,
      ratingRymVotes: 12,
    })
    expect(output.normalized.tags.map((tag) => tag.name)).toEqual([
      'Deep House',
      'Progressive House',
    ])
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      identityEvidence: 'djmix-title-composition',
      ratingSourceUrl: fabricMix.link,
    })
  })

  it.each([
    {
      title: 'fabric presents Pretty Girl (DJ Mix)',
      artist: 'Shygirl',
      date: '2025-06-20',
    },
    {
      title: 'fabric presents Pretty Girl (DJ Mix)',
      artist: 'Pretty Girl',
      date: '2025-06-21',
    },
    {
      title: 'fabric presents Pretty Girl (DJ Mix)',
      artist: 'Pretty Girl',
      date: undefined,
    },
    {
      title: 'fabric presents Pretty Girl (Mixed)',
      artist: 'Pretty Girl',
      date: '2025-06-20',
    },
    {
      title: 'fabric presents Pretty Girl (Live)',
      artist: 'Pretty Girl',
      date: '2025-06-20',
    },
    {
      title: 'RA.1043 Pretty Girl (DJ Mix)',
      artist: 'Pretty Girl',
      date: '2025-06-20',
    },
  ])(
    'rejects uncorroborated DJ mix input $title/$artist/$date',
    async ({ title, artist, date }) => {
      await expect(
        scrape(
          context(
            { results: [fabricMix] },
            { media: { title, artists: [artist], releaseDate: date } },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it.each(['album', 'comp'])(
    'does not substitute a %s for an explicit DJ mix',
    async (kind) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  ...fabricMix,
                  link: fabricMix.link.replace('/djmix/', `/${kind}/`),
                  title: fabricMix.title.replace(
                    'DJ Mix',
                    kind === 'album' ? 'Album' : 'Compilation',
                  ),
                },
              ],
            },
            {
              media: {
                title: 'fabric presents Pretty Girl (DJ Mix)',
                artists: ['Pretty Girl'],
                releaseDate: '2025-06-20',
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it.each([
    { provider: 'serply', manualOverride: true, accepted: true },
    { provider: 'serply', manualOverride: false, accepted: false },
    { provider: 'serply', manualOverride: 'true', accepted: false },
    { provider: 'google-custom-search', manualOverride: true, accepted: false },
  ])(
    'only a boolean manual owned reference authorizes artist/year conflicts: $provider $manualOverride',
    async ({ provider, manualOverride, accepted }) => {
      const link =
        'https://rateyourmusic.com/release/album/the-rockwood-escape-plan/dreamcast-summer-songs/'
      const ctx = context(
        {
          results: [
            {
              link,
              title:
                'Dreamcast Summer Songs by The Rockwood Escape Plan (Album, Instrumental Hip Hop)',
              description:
                'Dreamcast Summer Songs, an Album by The Rockwood Escape Plan. Released 27 February 2012. RYM Rating 3.88 from 8,937 ratings. Genres: Instrumental Hip Hop.',
              metadata: {
                rating: '3.9',
                reviews: '8,937',
                published_time: 'Feb 27, 2012',
              },
            },
          ],
        },
        {
          media: {
            title: 'Dreamcast Summer Songs',
            artists: ['Devon Hendryx'],
            releaseDate: '2009-01-01',
          },
          existingReferences: [
            {
              referenceType: 'rym-url',
              externalId: link,
              isPrimary: true,
              metadata: { sourceProvider: provider, manualOverride },
            },
          ],
        },
      )
      if (!accepted) {
        await expect(scrape(ctx)).rejects.toBeInstanceOf(
          ProviderItemNotFoundError,
        )
        return
      }
      const output = await scrape(ctx)
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.88,
        ratingRymVotes: 8937,
      })
      expect(
        output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
      ).toMatchObject({
        identityEvidence: 'manual-reference',
        yearEvidence: 'manual-reference-year-conflict',
        ratingSourceUrl: link,
        manualReference: {
          referenceUrl: link,
          libraryArtist: 'Devon Hendryx',
          libraryReleaseDate: '2009-01-01',
          sourceArtistSlug: 'the-rockwood-escape-plan',
          sourceYear: 2012,
          sourcePublishedTime: 'Feb 27, 2012',
          identityConflict: true,
          yearConflict: true,
        },
      })
      expect(output.normalized.mediaPatch).not.toHaveProperty('title')
      expect(output.normalized.mediaPatch).not.toHaveProperty('releaseDate')
      expect(ctx.media).toEqual({
        title: 'Dreamcast Summer Songs',
        artists: ['Devon Hendryx'],
        releaseDate: '2009-01-01',
      })
    },
  )

  it.each([false, true])(
    'only manual references permit a year conflict when names agree: %s',
    async (manualOverride) => {
      const ctx = context(undefined, {
        media: {
          title: 'Pripyat',
          artists: ['Marina Herlop'],
          releaseDate: '1997-01-01',
        },
        existingReferences: [
          {
            referenceType: 'rym-url',
            externalId: pripyatUrl,
            isPrimary: true,
            metadata: { sourceProvider: 'serply', manualOverride },
          },
        ],
      })
      if (manualOverride)
        expect(
          (await scrape(ctx)).normalized.mediaPatch?.metadata?.[
            'plugin.serply.provenance'
          ],
        ).toMatchObject({ yearEvidence: 'manual-reference-year-conflict' })
      else
        await expect(scrape(ctx)).rejects.toBeInstanceOf(
          ProviderItemNotFoundError,
        )
    },
  )

  it.each([
    {
      link: pripyatUrl.replace('/pripyat/', '/other/'),
      title: 'Pripyat by Marina Herlop (Album)',
    },
    {
      link: pripyatUrl.replace('/album/', '/single/'),
      title: 'Pripyat by Marina Herlop (Single)',
    },
    { link: pripyatUrl, title: 'Pripyat by Marina Herlop (Album; PAN)' },
  ])(
    'manual reference never authorizes an unrelated URL or edition: $link $title',
    async (result) => {
      await expect(
        scrape(
          context(
            { results: [{ ...pripyat, ...result }] },
            {
              existingReferences: [
                {
                  referenceType: 'rym-url',
                  externalId: pripyatUrl,
                  isPrimary: true,
                  metadata: { sourceProvider: 'serply', manualOverride: true },
                },
              ],
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it('manual reference does not publish an individual review score', async () => {
    const output = await scrape(
      context(
        {
          results: [
            {
              ...souvlakiReview,
              description: 'I give this album five stars.',
              metadata: { rating: 5, reviews: 1 },
            },
          ],
        },
        {
          media: {
            title: 'Souvlaki',
            artists: ['Different credit'],
            releaseDate: '2025-01-01',
          },
          existingReferences: [
            {
              referenceType: 'rym-url',
              externalId: souvlakiUrl,
              isPrimary: true,
              metadata: { sourceProvider: 'serply', manualOverride: true },
            },
          ],
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      identityEvidence: 'manual-reference',
      ratingSourceUrl: null,
    })
  })

  // Public album fields reduced from the failed 2026-11-03 responses.
  it.each([
    {
      title: 'caroline 2',
      artist: 'caroline',
      date: '2025-05-30',
      link: 'https://rateyourmusic.com/release/album/caroline/caroline-2-1/',
      resultTitle:
        'caroline 2 by caroline (Album, Post-Rock) - Rate Your Music',
      description:
        'Ranked #237 for 2025 Genres Post-Rock, Avant-Folk Progressive Folk, Experimental Rock, Indie Folk',
      value: 3.6,
      votes: 6218,
    },
    {
      title: 'Details (20th Anniversary Edition)',
      artist: 'Frou Frou',
      date: '2022-10-28',
      link: 'https://rateyourmusic.com/release/album/frou-frou/details/',
      resultTitle:
        'Details by Frou Frou (Album, Indietronica) - Rate Your Music',
      description:
        '20th Anniversary Edition Anniversary Edition, Bonus Tracks, Digital file, Streaming 2022 Lossless. Bonus Tracks, Colored Vinyl, Exclusive, ...',
      value: 3.9,
      votes: 7924,
    },
  ])('recovers the canonical indexed rating for $title', async (fixture) => {
    const output = await scrape(
      context(
        {
          results: [
            {
              link: fixture.link,
              title: fixture.resultTitle,
              description: fixture.description,
              metadata: { rating: fixture.value, reviews: fixture.votes },
            },
          ],
        },
        {
          media: {
            title: fixture.title,
            artists: [fixture.artist],
            releaseDate: fixture.date,
          },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: fixture.value,
      ratingRymVotes: fixture.votes,
    })
  })

  it.each([
    '(2011 Remaster)',
    '[Remastered 2011]',
    ' - Remastered',
    '(Deluxe Edition)',
    '(Deluxe)',
    '(Super Deluxe Edition)',
    '(Remastered Version)',
    '(20th Anniversary Edition)',
  ])('normalizes only recognized input suffixes: %s', async (suffix) => {
    const output = await scrape(
      context(undefined, {
        media: {
          title: `Pripyat ${suffix}`,
          artists: ['Marina Herlop'],
          releaseDate: '2025-01-01',
        },
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
    })
  })

  it.each([
    '(Live)',
    '(Acoustic)',
    '(Part Two)',
    "(Taylor's Version)",
    ' - Other Album',
  ])('does not strip meaningful title content: %s', async (suffix) => {
    await expect(
      scrape(
        context(undefined, {
          media: { title: `Pripyat ${suffix}`, artists: ['Marina Herlop'] },
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('matches diacritics, encoded paths and slug punctuation without changing names', async () => {
    const output = await scrape(
      context(
        {
          results: [
            {
              ...pripyat,
              link: 'https://rateyourmusic.com/release/album/bjork/debut/',
              title: 'Debut by Björk (Album, Art Pop)',
              description: '',
              metadata: { rating: 3.8, reviews: 500 },
            },
          ],
        },
        { media: { title: 'Debut', artists: ['Björk'] } },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.8,
    })
  })

  it('matches ampersands to their spelled-out slug without fuzzy artist matching', async () => {
    const output = await scrape(
      context(
        {
          results: [
            {
              link: 'https://rateyourmusic.com/release/album/rhythm-and-sound/with-the-artists/',
              title: 'With the Artists by Rhythm & Sound (Album, Dub)',
              description: 'Genres: Dub.',
              metadata: { rating: 4, reviews: 100 },
            },
          ],
        },
        { media: { title: 'With the Artists', artists: ['Rhythm & Sound'] } },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 4,
    })
  })

  it('recovers the captured W/ the Artists album without selecting the different compilation', async () => {
    const link =
      'https://rateyourmusic.com/release/album/rhythm-and-sound/w-the-artists/'
    const output = await scrape(
      context(
        {
          results: [
            {
              link: 'https://rateyourmusic.com/release/comp/rhythm-and-sound/rhythm-and-sound-w-the-artists-1/',
              title:
                'Rhythm & Sound W/ the Artists - Burial Mix; BMLP-2 - Rate Your Music',
              description:
                'Genres Dub, Ambient Dub Roots Reggae, Dub Techno Descriptors mellow, atmospheric, repetitive, hypnotic',
              metadata: { rating: '4.0', reviews: '59' },
            },
            {
              link,
              title:
                'W/ the Artists by Rhythm & Sound (Album, Dub) - Rate Your Music',
              description:
                'Rhythm & Sound w/ the Artists is a compilation of the vocal tracks they released on a series of eight ten-inch singles between 2001 and 2003 (the instrumental B ...',
              metadata: { rating: '3.8', reviews: '2,850' },
            },
            {
              link: `${link}lists/4/`,
              title:
                'Lists with W/ the Artists by Rhythm & Sound (Album, Dub) [Page 4 ...',
              description:
                'W/ the Artists, an Album by Rhythm & Sound. Released in September 2003 on Burial Mix (catalog no. BMD-2; CD). Genres: Dub, Ambient Dub.',
            },
          ],
        },
        {
          media: {
            title: 'With the Artists',
            artists: ['Rhythm & Sound'],
            releaseDate: '2003-01-01',
          },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.8,
      ratingRymVotes: 2850,
    })
    expect(output.normalized.tags.map((tag) => tag.name)).toEqual([
      'Dub',
      'Ambient Dub',
    ])
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      ratingSourceUrl: link,
      identityEvidence: 'corroborated-display-title',
    })
  })

  it.each([
    { title: 'W the Artists', slug: 'w-the-artists', type: 'Album, Dub' },
    { title: 'With the Artists', slug: 'w-the-artists', type: 'Album, Dub' },
    { title: 'W/ the Artists', slug: 'wrong-the-artists', type: 'Album, Dub' },
    { title: 'SW/ the Artists', slug: 'sw-the-artists', type: 'Album, Dub' },
    {
      title: 'W/ the Artists',
      slug: 'w-the-artists',
      type: 'Album; Burial Mix',
    },
  ])(
    'does not infer an uncorroborated abbreviation or edition from $title ($slug; $type)',
    async ({ title, slug, type }) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  link: `https://rateyourmusic.com/release/album/rhythm-and-sound/${slug}/`,
                  title: `${title} by Rhythm & Sound (${type})`,
                  description: '',
                  metadata: { rating: 4, reviews: 59 },
                },
              ],
            },
            {
              media: { title: 'With the Artists', artists: ['Rhythm & Sound'] },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it.each([
    {
      title: 'Loner',
      artist: "Barry Can't Swim",
      path: 'barry-cant-swim/loner',
    },
    {
      title: "DON'T TAP THE GLASS",
      artist: 'Tyler, The Creator',
      path: 'tyler-the-creator/dont-tap-the-glass',
    },
    {
      title: "A Grand Don't Come for Free",
      artist: 'The Streets',
      path: 'the-streets/a-grand-dont-come-for-free',
    },
    {
      title: "IT'S THE LONG GOODBYE",
      artist: 'The Twilight Sad',
      path: 'the-twilight-sad/its-the-long-goodbye',
    },
    { title: 'Kairos', artist: "O'Flynn", path: 'oflynn/kairos' },
    {
      title: 'She’s the Best',
      artist: 'Troye Sivan',
      path: 'troye-sivan/shes-the-best',
    },
  ])(
    'matches the captured apostrophe/slug identity for $title without a saved reference',
    async ({ title, artist, path }) => {
      const link = `https://rateyourmusic.com/release/album/${path}/`
      const output = await scrape(
        context(
          {
            results: [
              {
                link,
                title: `${title.replaceAll('’', "'")} by ${artist} (Album)`,
                description: '',
                metadata: { rating: 3.5, reviews: 100 },
              },
            ],
          },
          { media: { title, artists: [artist] } },
        ),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.5,
        ratingRymVotes: 100,
      })
      expect(output.normalized.references[0]?.externalId).toBe(link)
    },
  )

  it.each([
    { title: "Can't Stop", resultTitle: 'Can T Stop', path: 'cant-stop' },
    { title: 'Can T Stop', resultTitle: "Can't Stop", path: 'can-t-stop' },
    { title: 'A Part', resultTitle: 'Apart', path: 'a-part' },
  ])(
    'does not merge real word boundaries when normalizing $title',
    async ({ title, resultTitle, path }) => {
      await expect(
        scrape(
          context(
            {
              results: [
                {
                  ...pripyat,
                  link: `https://rateyourmusic.com/release/album/marina-herlop/${path}/`,
                  title: `${resultTitle} by Marina Herlop (Album)`,
                  description: '',
                },
              ],
            },
            { media: { title, artists: ['Marina Herlop'] } },
          ),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it('keeps a corrected reference constraint after apostrophe normalization', async () => {
    await expect(
      scrape(
        context(
          {
            results: [
              {
                ...pripyat,
                link: 'https://rateyourmusic.com/release/album/oflynn/kairos/',
                title: "Kairos by O'Flynn (Album)",
                description: '',
              },
            ],
          },
          {
            media: { title: 'Kairos', artists: ["O'Flynn"] },
            existingReferences: [
              {
                referenceType: 'rym-url',
                externalId:
                  'https://rateyourmusic.com/release/album/oflynn/other-album/',
                isPrimary: true,
                metadata: { sourceProvider: 'serply' },
              },
            ],
          },
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it.each([
    {
      title: 'The Passionate Ones',
      artist: 'Nourished by Time',
      slug: 'nourished-by-time/the-passionate-ones',
      resultTitle:
        'The Passionate Ones by Nourished by Time (Album, Bedroom Pop)',
      resultSuffix: '/',
      rating: 3.7,
      votes: 7915,
    },
    {
      title: 'Compact Objects',
      artist: 'Swardy',
      slug: 'swardy/compact-objects',
      resultTitle:
        'Compact Objects by Swardy (Album): Reviews, Ratings, Credits, Song list',
      resultSuffix: '.p/',
      rating: 3.5,
      votes: 74,
    },
  ])('preserves observed canonical .p evidence for $title', async (fixture) => {
    const base = `https://rateyourmusic.com/release/album/${fixture.slug}`
    const link = `${base}${fixture.resultSuffix}`
    const output = await scrape(
      context(
        {
          results: [
            {
              link,
              title: fixture.resultTitle,
              description: '',
              metadata: { rating: fixture.rating, reviews: fixture.votes },
            },
          ],
        },
        {
          media: { title: fixture.title, artists: [fixture.artist] },
          existingReferences: [
            {
              referenceType: 'rym-url',
              externalId: `${base}.p/`,
              isPrimary: true,
              metadata: { sourceProvider: 'serply' },
            },
          ],
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: fixture.rating,
      ratingRymVotes: fixture.votes,
    })
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      releaseUrl: `${base}/`,
      ratingSourceUrl: link,
      ratingScope: fixture.resultSuffix === '.p/' ? 'primary-issue' : 'release',
    })
    expect(output.normalized.references[0]?.externalId).toBe(link)
  })

  it.each(['plain-first', 'primary-first', 'primary-first-query'])(
    'prefers the independently matched plain release rating: %s',
    async (order) => {
      const link =
        'https://rateyourmusic.com/release/album/nourished-by-time/the-passionate-ones/'
      const plain = {
        link,
        title: 'The Passionate Ones by Nourished by Time (Album, Bedroom Pop)',
        description: 'Genres: Bedroom Pop.',
        metadata: { rating: '3.7', reviews: '7,915' },
      }
      const primary = {
        ...plain,
        link: link.replace(/\/$/, '.p/'),
        metadata: { rating: '4.2', reviews: '73' },
      }
      const request =
        order === 'primary-first-query'
          ? replies({ results: [primary] }, { results: [plain] })
          : replies({
              results:
                order === 'plain-first' ? [plain, primary] : [primary, plain],
            })
      const output = await scrape(
        context(undefined, {
          request,
          media: {
            title: 'The Passionate Ones',
            artists: ['Nourished by Time'],
          },
        }),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.7,
        ratingRymVotes: 7915,
      })
      expect(
        output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
      ).toMatchObject({ ratingSourceUrl: link, ratingScope: 'release' })
      expect(request).toHaveBeenCalledTimes(
        order === 'primary-first-query' ? 2 : 1,
      )
    },
  )

  it('does not borrow the primary-issue count for a preferred plain release score', async () => {
    const output = await scrape(
      context({
        results: [
          {
            ...pripyat,
            link: pripyatUrl.replace(/\/$/, '.p/'),
            metadata: { rating: 4.5, reviews: 70 },
          },
          { ...pripyat, metadata: { rating: 3.4 } },
        ],
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.4,
      ratingRymVotes: null,
    })
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({ ratingSourceUrl: pripyatUrl, ratingScope: 'release' })
  })

  it.each([{ path: 'comp', type: 'Compilation' }])(
    'accepts an identified $type release',
    async ({ path, type }) => {
      const output = await scrape(
        context({
          results: [
            {
              ...pripyat,
              link: pripyatUrl.replace('/album/', `/${path}/`),
              title: `Pripyat by Marina Herlop (${type}, Glitch Pop)`,
              description: 'Genres: Glitch Pop.',
            },
          ],
        }),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
        ratingRymValue: 3.4,
      })
    },
  )

  it.each([false, true])(
    'selects the Radiosoul album, not its same-name single (later query: %s)',
    async (later) => {
      const single = {
        link: 'https://rateyourmusic.com/release/single/alfie-templeman/radiosoul/',
        title:
          'Radiosoul by Alfie Templeman (Single, Pop Soul): Reviews, Ratings ...',
        description:
          'Released, 8 March 2024 ; RYM Rating, 3.40 / 5.00.5 from 12 ratings ; Genres. Pop Soul, Smooth Soul',
      }
      const album = {
        link: 'https://rateyourmusic.com/release/album/alfie-templeman/radiosoul/',
        title: 'Radiosoul by Alfie Templeman - Rate Your Music',
        description:
          'Radiosoul, an Album by Alfie Templeman. Released 7 June 2024 on Chess Club. Genres: Dance-Pop.',
        metadata: { rating: '3.2', reviews: '156' },
      }
      const request = later
        ? replies({ results: [single] }, { results: [album] })
        : replies({ results: [single, album] })
      const output = await scrape(
        context(undefined, {
          request,
          media: {
            title: 'Radiosoul',
            artists: ['Alfie Templeman'],
            releaseDate: '2024-06-07',
          },
        }),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
        ratingRymValue: 3.2,
        ratingRymVotes: 156,
      })
      expect(
        output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
      ).toMatchObject({ ratingSourceUrl: album.link })
      expect(request).toHaveBeenCalledTimes(later ? 2 : 1)
    },
  )

  it.each([false, true])(
    'requires an owned reference to select a single (owned: %s)',
    async (owned) => {
      const link = pripyatUrl.replace('/album/', '/single/')
      const ctx = context(
        {
          results: [
            {
              ...pripyat,
              link,
              title: 'Pripyat by Marina Herlop (Single, Glitch Pop)',
            },
          ],
        },
        {
          existingReferences: [
            {
              referenceType: 'rym-url',
              externalId: link,
              isPrimary: true,
              metadata: {
                sourceProvider: owned ? 'serply' : 'google-custom-search',
              },
            },
          ],
        },
      )
      if (owned)
        expect(
          (await scrape(ctx)).normalized.mediaPatch?.metadata?.['browse'],
        ).toMatchObject({ ratingRymValue: 3.4 })
      else
        await expect(scrape(ctx)).rejects.toBeInstanceOf(
          ProviderItemNotFoundError,
        )
    },
  )

  it.each(['reviews/', 'lists/', 'reviews/2/', 'lists/3/'])(
    'accepts %s without using structured personal ratings',
    async (suffix) => {
      const output = await scrape(
        context({
          results: [
            {
              ...pripyat,
              link: `${pripyatUrl}${suffix}`,
              title: 'Reviews of Pripyat by Marina Herlop (Album)',
              description: '',
              metadata: { rating: 5, reviews: 1 },
            },
          ],
        }),
      )
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    },
  )

  it('allows an explicitly truncated title only when the exact path corroborates it', async () => {
    const output = await scrape(
      context({
        results: [
          { ...pripyat, title: 'Prip... by Marina Herlop (Album, Glitch Pop)' },
        ],
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
    })
    await expect(
      scrape(
        context({
          results: [
            {
              ...pripyat,
              title: 'Wrong... by Marina Herlop (Album, Glitch Pop)',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('requires title corroboration for numeric disambiguation', async () => {
    await expect(
      scrape(
        context({
          results: [
            {
              ...pripyat,
              link: pripyatUrl.replace('/pripyat/', '/pripyat-1/'),
              title: 'Rate Your Music',
              description: '',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it.each(['pripyat.p', 'pripyat-2'])(
    'never publishes an edition aggregate: %s',
    async (slug) => {
      await expect(
        scrape(
          context({
            results: [
              {
                ...pripyat,
                link: pripyatUrl.replace('/pripyat/', `/${slug}/`),
                title: 'Pripyat by Marina Herlop (Album; PAN)',
                description: 'RYM Rating 5 from 2 ratings Genres: Rock.',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    },
  )

  it('rejects a contradictory path despite an exact title and artist', async () => {
    await expect(
      scrape(
        context({
          results: [
            {
              ...pripyat,
              link: pripyatUrl.replace('/pripyat/', '/other-album/'),
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('does not merge genres from a distinct corroborated release identity', async () => {
    const output = await scrape(
      context({
        results: [
          {
            ...pripyat,
            title: 'Pripyat by Marina Herlop (Album)',
            description: '',
          },
          {
            ...pripyat,
            link: pripyatUrl.replace('/pripyat/', '/pripyat-1/'),
            title: 'Pripyat by Marina Herlop (Album)',
            description: 'Genres: Wrong Genre.',
            metadata: {},
          },
        ],
      }),
    )
    expect(output.normalized.tags).toEqual([])
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({ ratingSourceUrl: pripyatUrl, genresSourceUrl: null })
  })

  it('treats legacy references as hints, but never overrides an owned correction', async () => {
    const stale = pripyatUrl.replace('/pripyat/', '/other-album/')
    const legacy = {
      referenceType: 'rym-url',
      isPrimary: true,
      externalId: stale,
      metadata: { sourceProvider: 'google-custom-search' },
    }
    const output = await scrape(
      context(undefined, { existingReferences: [legacy] }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
    })
    await expect(
      scrape(
        context(undefined, {
          existingReferences: [
            { ...legacy, metadata: { sourceProvider: 'serply' } },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('honors the first corrected reference ahead of a stale owned reference', async () => {
    const output = await scrape(
      context(undefined, {
        existingReferences: [
          {
            referenceType: 'rym-url',
            externalId: pripyatUrl,
            isPrimary: true,
            metadata: { sourceProvider: 'serply' },
          },
          {
            referenceType: 'rym-url',
            externalId: pripyatUrl.replace('/pripyat/', '/other/'),
            isPrimary: true,
            metadata: { sourceProvider: 'serply' },
          },
        ],
      }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
    })
  })

  it('finds an album on the fourth distinct fallback without exceeding the bound', async () => {
    const request = replies(
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [pripyat] },
    )
    const output = await scrape(
      context(undefined, {
        request,
        media: {
          title: 'Pripyat (Deluxe Edition)',
          artists: ['Marina Herlop'],
        },
      }),
    )
    expect(request).toHaveBeenCalledTimes(4)
    expect(
      request.mock.calls.map(([input]) => new URL(input).searchParams.get('q')),
    ).toEqual([
      'site:rateyourmusic.com Marina Herlop Pripyat (Deluxe Edition)',
      'site:rateyourmusic.com/release/ Marina Herlop Pripyat',
      'site:rateyourmusic.com/release/ "Marina Herlop" "Pripyat"',
      'Marina Herlop Pripyat Rate Your Music rating genres',
    ])
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingRymValue: 3.4,
    })
  })

  it.each([20, 100])(
    'retains all bounded large responses with explicit field truncation (%s results)',
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
      expect(request).toHaveBeenCalledTimes(4)
      const entries = diagnostics
        .snapshot()
        .map((entry) => PluginDiagnosticSchema.parse(entry))
      expect(entries.slice(0, 4).map((entry) => entry.stage)).toEqual([
        'serply.response',
        'serply.search',
        'serply.response',
        'serply.search',
      ])
      expect(
        entries.filter((entry) => entry.stage === 'serply.response'),
      ).toHaveLength(4)
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
        320 * 1024,
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

  it('retains actual JSON for bounded failed searches through the job collector', async () => {
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
    expect(responses).toHaveLength(4)
    expect(responses.slice(0, 2)).toEqual([
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
          query: 'site:rateyourmusic.com/release/ Marina Herlop Pripyat',
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
    expect(ctx.request).toHaveBeenCalledTimes(4)
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
    'uses a release-restricted query when the first search has no eligible URL',
    async (first) => {
      const request = replies(first, { results: [pripyat] })
      const output = await scrape(context(undefined, { request }))
      expect(request).toHaveBeenCalledTimes(2)
      expect(
        new URL(String(request.mock.calls[1]?.[0])).searchParams.get('q'),
      ).toBe('site:rateyourmusic.com/release/ Marina Herlop Pripyat')
      expect(output.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
        ratingRymValue: 3.4,
      })
    },
  )

  it('records unsuccessful searches and throws a typed miss after four distinct queries', async () => {
    const recordDiagnostic =
      vi.fn<NonNullable<MediaPluginScrapeContext['recordDiagnostic']>>()
    const request = replies(
      { results: [] },
      { results: [{ ...pripyat, link: 'https://unrelated.invalid/' }] },
    )
    await expect(
      scrape(context(undefined, { request, recordDiagnostic })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(4)
    expect(recordDiagnostic).toHaveBeenCalledTimes(9)
    expect(recordDiagnostic).toHaveBeenLastCalledWith({
      stage: 'serply.selection',
      evidence: { reason: 'no-match', searchCount: 4 },
    })
    expect(
      new Set(
        request.mock.calls.map(([input]) =>
          new URL(input).searchParams.get('q'),
        ),
      ).size,
    ).toBe(4)
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

  it.each(['serply', 'google'])(
    'preserves an observed .p URL in the site query for a %s reference',
    async (sourceProvider) => {
      const link = pripyatUrl.replace(/\/$/, '.p/')
      const request = replies({ results: [] })
      await expect(
        scrape(
          context(undefined, {
            request,
            existingReferences: [
              {
                referenceType: 'rym-url',
                externalId: link,
                isPrimary: true,
                metadata: { sourceProvider },
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
      const queries = request.mock.calls.map(([input]) =>
        new URL(input).searchParams.get('q'),
      )
      expect(queries[1]).toBe(`site:${link}`)
      expect(queries).not.toContain(`site:${pripyatUrl}`)
      expect(queries).toHaveLength(5)
      expect(new Set(queries).size).toBe(5)
    },
  )

  it('uses the observed .p URL from a selected result without inventing a plain root query', async () => {
    const link = pripyatUrl.replace(/\/$/, '.p/')
    const request = replies({ results: [{ ...pripyat, link }] })
    const output = await scrape(context(undefined, { request }))
    const queries = request.mock.calls.map(([input]) =>
      new URL(input).searchParams.get('q'),
    )
    expect(queries[1]).toBe(`site:${link}`)
    expect(queries).not.toContain(`site:${pripyatUrl}`)
    expect(queries).toHaveLength(5)
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      releaseUrl: pripyatUrl,
      sourceUrl: link,
      ratingSourceUrl: link,
      ratingScope: 'primary-issue',
    })
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.4,
      ratingRymVotes: 1836,
    })
  })

  it('queries the exact manual One Match Left .p URL without claiming an uncaptured response', async () => {
    const link =
      'https://rateyourmusic.com/release/album/brooks-nielsen/one-match-left.p/'
    // Query behavior only: no saved response proves this .p search succeeds.
    const request = replies({ results: [] })
    await expect(
      scrape(
        context(undefined, {
          request,
          media: {
            title: 'One Match Left',
            artists: ['Brooks Nielsen'],
            releaseDate: '2022-06-03',
          },
          existingReferences: [
            {
              referenceType: 'rym-url',
              externalId: link,
              isPrimary: true,
              metadata: { sourceProvider: 'serply', manualOverride: true },
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    const queries = request.mock.calls.map(([input]) =>
      new URL(input).searchParams.get('q'),
    )
    expect(queries[1]).toBe(`site:${link}`)
    expect(queries).not.toContain(`site:${link.replace('.p/', '/')}`)
    expect(queries).toHaveLength(5)
  })

  it('persists identity-only matches with provenance and preserves the five-search cap', async () => {
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
    const output = await scrape(
      context(undefined, { request, recordDiagnostic }),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      matchStatus: 'identity-only',
      sourceUrl: pripyatUrl,
      ratingSourceUrl: null,
    })
    expect(request).toHaveBeenCalledTimes(5)
    expect(recordDiagnostic.mock.calls[1]?.[0]).toMatchObject({
      evidence: {
        reasons: { 'identity-only': 1 },
        candidates: [
          { reason: 'identity-only', response: { link: pripyatUrl } },
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
        requestTimeoutMs: 120000,
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

  it('extracts complete genre and descriptor labels from an aggregate header', async () => {
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
      'Choral',
      'Deconstructed Club',
      'Art Pop',
      'avant-garde',
      'female vocalist',
      'suspenseful',
    ])
  })

  it('replays only exact-scope album headers, with evidence for each tag', () => {
    const root = {
      ...pripyat,
      description: 'Genres: Progressive Electronic.',
      title: 'Pripyat by Marina Herlop (Album)',
    }
    const review = {
      link: 'https://rateyourmusic.com/music-review/listener/marina-herlop/pripyat/1122',
      title: 'Review for Pripyat - Marina Herlop by listener',
      description:
        '3.86 from 7,730 ratings Genres Progressive Electronic Berlin School, Minimalism, Krautrock, Minimal Techno. My favorite is Disco.',
    }
    const other = { ...root, description: 'Genres: Disco.' }
    const results = [
      root,
      review,
      review,
      { ...other, link: pripyatUrl.replace('pripyat/', 'pripyat.p/') },
      { ...other, link: pripyatUrl.replace('pripyat/', 'pripyat-1/') },
      { ...other, link: pripyatUrl.replace('/album/', '/ep/') },
      {
        ...review,
        description:
          'In my opinion Genres Disco, House Descriptors funky, bright.',
      },
    ]
    const payload = { searches: [{ response: { results } }] }
    expect(extractSerplyAlbumTags(payload, root.link)).toEqual(
      [
        'Progressive Electronic',
        'Berlin School',
        'Minimalism',
        'Krautrock',
        'Minimal Techno',
      ].map((name, index) => ({
        name,
        rawName: name,
        kind: 'genre',
        source: 'rym',
        sourceUrl: index === 0 ? root.link : review.link,
      })),
    )
    expect(
      extractSerplyAlbumTags(
        payload,
        'https://example.org/release/album/marina-herlop/pripyat/',
      ),
    ).toEqual([])
    expect(extractSerplyAlbumTags({}, root.link)).toEqual([])
  })

  it('does not import a truncated descriptor or use review stars for album metadata', async () => {
    const review = {
      link: 'https://rateyourmusic.com/music-review/listener/marina-herlop/pripyat/1122',
      title: 'Review for Pripyat - Marina Herlop by listener',
      description:
        '3.94 from 543 ratings Genres Afrobeat, Afro-Funk Highlife, Jùjú, Psychedelic Rock Descriptors female vocalist, rhythmic, eclectic, male ...',
      metadata: { rating: '1', reviews: '1' },
    }
    const root = {
      ...pripyat,
      title: 'Pripyat by Marina Herlop (Album)',
      description: 'Genres: Afrobeat.',
    }
    const request = replies({ results: [root, review] })
    const output = await scrape(context(undefined, { request }))
    expect(request).toHaveBeenCalledTimes(1)
    expect(output.normalized.mediaPatch?.metadata?.browse).toEqual({
      ratingRymValue: 3.4,
      ratingRymVotes: 1836,
    })
    expect(
      output.normalized.tags.map(({ name, kind }) => [name, kind]),
    ).toEqual([
      ['Afrobeat', 'genre'],
      ['Jùjú', 'genre'],
      ['Psychedelic Rock', 'genre'],
      ['female vocalist', 'descriptor'],
      ['rhythmic', 'descriptor'],
      ['eclectic', 'descriptor'],
    ])
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({
      genresSourceUrl: root.link,
      ratingSourceUrl: root.link,
      tagSources: expect.arrayContaining([
        { name: 'rhythmic', kind: 'descriptor', sourceUrl: review.link },
      ]),
    })
  })

  it.each([
    [
      '3.5 from 100 ratings Genres Descriptors Languages French, English Track listing',
      [],
    ],
    ['Genres Descriptors Track listing 1 Song 3:43.', []],
    [
      'Genres: Trip Hop, Downtempo, Contemporary melodic, nocturnal, mellow, introspective, psychedelic ...',
      ['Trip Hop', 'Downtempo'],
    ],
    [
      'Genres: Trip Hop, Downtempo, Contemporary R&amp;B.',
      ['Trip Hop', 'Downtempo', 'Contemporary R&B'],
    ],
    [
      '3.5 from 100 ratings. Genres. IDM · Ambient Techno, Downtempo. Descriptors. melancholic, rhythmic, cold. Personal review.',
      ['IDM', 'Ambient Techno', 'Downtempo', 'melancholic', 'rhythmic', 'cold'],
    ],
    [
      '3.5 from 100 ratings Genres IDM Descriptors rhythmic, dense, female',
      ['IDM', 'rhythmic', 'dense'],
    ],
    [
      '3.5 from 100 ratings Genres IDM. The review mentions Descriptors ecstatic, energetic.',
      ['IDM'],
    ],
  ])('preserves field boundaries in %s', (description, expected) => {
    const result = {
      ...pripyat,
      title: 'Pripyat by Marina Herlop (Album)',
      description,
    }
    const payload = { searches: [{ response: { results: [result] } }] }
    expect(
      extractSerplyAlbumTags(payload, result.link).map(({ name }) => name),
    ).toEqual(expected)
  })

  it('retains observed compound labels only when the vocabulary supports the boundary', () => {
    const result = {
      ...pripyat,
      title: 'Pripyat by Marina Herlop (Album)',
      description:
        '3.5 from 100 ratings Genres Example Genre Other Style, Afro-Funk Highlife Descriptors rhythmic, ...',
    }
    const payload = { searches: [{ response: { results: [result] } }] }
    const vocab = new Set([
      'Afro-Funk',
      'Highlife',
      'Example Genre',
      'Other Style',
      'Example',
      'Genre Other Style',
      'Never Mentioned',
    ])
    expect(
      extractSerplyAlbumTags(payload, result.link, vocab).map(
        ({ name }) => name,
      ),
    ).toEqual(['Afro-Funk', 'Highlife', 'rhythmic'])
    expect(
      extractSerplyAlbumTags(payload, result.link).map(({ name }) => name),
    ).toEqual(['rhythmic'])
  })

  it('does not keep a clipped prefix when the same source identifies the complete title genre', () => {
    const result = {
      ...pripyat,
      title: 'Pripyat by Marina Herlop (Album, Nouvelle chanson française)',
      description:
        'Genres: Nouvelle. Genres Nouvelle chanson française, Art Pop, Art ...',
    }
    expect(
      extractSerplyAlbumTags(
        { searches: [{ response: { results: [result] } }] },
        result.link,
      ).map(({ name }) => name),
    ).toEqual(['Nouvelle chanson française'])
  })

  it.each([
    ['656 ratings', ['IDM', 'rhythmic']],
    ['Marina Herlop ratings', ['IDM', 'rhythmic']],
    ['Another artist ratings', []],
  ])('checks abbreviated review header anchor %s', (prefix, expected) => {
    const result = {
      title: 'Review for Pripyat - Marina Herlop by listener',
      link: 'https://rateyourmusic.com/music-review/listener/marina-herlop/pripyat/1122',
      description: prefix + ' Genres IDM Descriptors rhythmic, female',
    }
    expect(
      extractSerplyAlbumTags(
        { searches: [{ response: { results: [result] } }] },
        result.link,
      ).map(({ name }) => name),
    ).toEqual(expected)
  })

  it('retains alternate header snippets for the exact same bilingual source title', () => {
    const root = {
      link: pripyatUrl,
      title: 'Pripyat by Marina Herlop [Alias] (Album, House)',
      description: '',
    }
    const other = {
      ...root,
      description:
        '2.57 from 836 ratings Genres House, Techno Descriptors deadpan, ...',
    }
    const conflict = {
      ...root,
      description: 'Other Record, an Album by Other Band. Genres: Punk.',
    }
    expect(
      extractSerplyAlbumTags(
        { searches: [{ response: { results: [root, other, conflict] } }] },
        root.link,
      ).map(({ name }) => name),
    ).toEqual(['House', 'Techno', 'deadpan'])
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

  it('keeps a predecessor aggregate separate from its unrated sequel', async () => {
    const original =
      'https://rateyourmusic.com/release/album/clark/steep-stims/'
    const sequel =
      'https://rateyourmusic.com/release/album/clark/steep-stims-ii/'
    const payload = {
      results: [
        {
          link: original,
          title: 'Steep Stims by Clark (Album, IDM)',
          description: 'Steep Stims, an Album by Clark. Genres: IDM.',
          metadata: { rating: '3.4', reviews: '470' },
        },
        {
          link: sequel,
          title: 'Steep Stims II by Clark (Album, IDM)',
          description:
            'Steep Stims II, an Album by Clark. Genres: IDM, Techno.',
          metadata: {},
        },
        {
          link: 'https://rateyourmusic.com/music-review/BarnabyNutt/clark/steep-stims/271016868',
          title: 'Review for Steep Stims - Clark by BarnabyNutt',
          metadata: {
            rating: '3.5',
            attributes: ['Rating', 'Review by BarnabyNutt'],
          },
        },
      ],
    }
    for (const { title, sourceUrl, browse, ratingSourceUrl } of [
      {
        title: 'Steep Stims',
        sourceUrl: original,
        browse: { ratingRymValue: 3.4, ratingRymVotes: 470 },
        ratingSourceUrl: original,
      },
      {
        title: 'Steep Stims II',
        sourceUrl: sequel,
        browse: {},
        ratingSourceUrl: null,
      },
    ]) {
      const output = await scrape(
        context(payload, { media: { title, artists: ['Clark'] } }),
      )
      const metadata = output.normalized.mediaPatch?.metadata
      expect(metadata?.['browse']).toEqual(browse)
      expect(metadata?.['plugin.serply.provenance']).toMatchObject({
        sourceUrl,
        ratingSourceUrl,
      })
    }
  })

  it('does not mistake a personal review score for an aggregate', async () => {
    const output = await scrape(
      context(
        {
          results: [
            {
              ...souvlakiReview,
              description: 'I give this record 4.5 stars. My favourite album.',
              metadata: { rating: 4.5, reviews: 1 },
            },
          ],
        },
        {
          media: { title: 'Souvlaki', artists: ['Slowdive'] },
        },
      ),
    )
    expect(output.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(
      output.normalized.mediaPatch?.metadata?.['plugin.serply.provenance'],
    ).toMatchObject({ matchStatus: 'identity-only', ratingSourceUrl: null })
  })

  it('reports a validated empty search as a benign miss', async () => {
    const request = replies({ results: [] })
    await expect(
      scrape(context(undefined, { request })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request.mock.calls.length).toBeLessThanOrEqual(5)
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
    expect(diagnostics.snapshot()).toEqual([
      {
        stage: 'serply.response',
        evidence: {
          query: 'site:rateyourmusic.com Marina Herlop Pripyat',
          status: null,
          responseUnavailable: 'request-failed',
        },
      },
    ])
  })

  it('retains the failed query on timeout without retaining the error text or retrying', async () => {
    const diagnostics = createJobDiagnostics(['offline-key'])
    const error = new DOMException(
      'offline-key transport details',
      'TimeoutError',
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
    expect(diagnostics.snapshot()).toEqual([
      {
        stage: 'serply.response',
        evidence: {
          query: 'site:rateyourmusic.com Marina Herlop Pripyat',
          status: null,
          responseUnavailable: 'request-failed',
        },
      },
    ])
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('offline-key')
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(
      'transport details',
    )
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
