import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { CreateJobSchema } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { serplyPlugin } from '@/plugins/builtin/serply'

const database = `serply_jobs_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
// Keep explicit disposable-test connection settings isolated from local overrides.
vi.mock('@/lib/load-workspace-env', () => ({ loadWorkspaceEnv: () => {} }))
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'serply' ? serplyPlugin : null,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({ apiKey: 'offline-fixture-key' }),
}))

const sourceUrl =
  'https://rateyourmusic.com/release/album/marina-herlop/pripyat/'
const albumQuery = 'site:rateyourmusic.com Marina Herlop Pripyat'
const siteQuery = `site:${sourceUrl}`
const fallbackQueries = [
  'site:rateyourmusic.com/release/ Marina Herlop Pripyat',
  'site:rateyourmusic.com/release/ "Marina Herlop" "Pripyat"',
  'Marina Herlop Pripyat Rate Your Music rating genres',
]
// Reduced indexed metadata from the user-supplied Pripyat example.
const pripyat = {
  link: sourceUrl,
  title: 'Pripyat by Marina Herlop (Album, Glitch Pop) - Rate Your Music',
  description:
    'Pripyat, an Album by Marina Herlop. Released 20 May 2022. Genres: Glitch Pop, Avant-Folk.',
  metadata: {
    rating: '3.4',
    reviews: '1,836',
    published_time: 'May 20, 2022',
  },
}
const indexed = { results: [pripyat] }

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.tagIdentity)
  await databaseClient.delete(schema.tag)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'album-fixture',
    slug: 'album-fixture',
    title: 'Pripyat',
    mediaType: 'album',
    releaseDate: new Date('2022-05-20T00:00:00Z'),
  })
  await databaseClient
    .insert(schema.album)
    .values({ mediaItemId: 'album-fixture' })
  await databaseClient
    .insert(schema.artist)
    .values({ id: 'artist-fixture', name: 'Marina Herlop' })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: 'album-fixture',
    artistId: 'artist-fixture',
    role: 'artist',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function runJob(...payloads: unknown[]) {
  for (const payload of payloads)
    request.mockResolvedValueOnce(Response.json(payload))
  const { createJob, processQueuedJobs, getJob } =
    await import('@/services/jobs')
  const job = await createJob(
    CreateJobSchema.parse({
      provider: 'serply',
      scope: { mediaItemIds: ['album-fixture'], mediaType: 'album' },
    }),
    null,
  )
  await processQueuedJobs()
  expect(request).toHaveBeenCalledTimes(payloads.length)
  expect(request.mock.calls.length).toBeLessThanOrEqual(6)
  for (const [input, init] of request.mock.calls) {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe('https://api.serply.io')
    expect(url.pathname).toBe('/v1/search/')
    expect(url.searchParams.get('gl')).toBe('us')
    expect(url.searchParams.get('num')).toBe('10')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe(
      'offline-fixture-key',
    )
  }
  const events = await databaseClient.select().from(schema.providerRequestEvent)
  expect(events).toHaveLength(payloads.length)
  expect(events.every((event) => event.provider === 'serply')).toBe(true)
  expect(events.every((event) => event.requestClass === 'read')).toBe(true)
  return getJob(job.id)
}

function requestedQueries() {
  return request.mock.calls.map(([input]) =>
    new URL(
      input instanceof Request ? input.url : String(input),
    ).searchParams.get('q'),
  )
}

describe('Serply indexed metadata through the queue, with offline HTTP', () => {
  it('uses six bounded soundtrack searches and persists the fresh date-prefixed result without a rating', async () => {
    const title =
      'One Battle After Another (Original Motion Picture Soundtrack)'
    const url =
      'https://rateyourmusic.com/release/album/jonny-greenwood/one-battle-after-another/'
    await databaseClient
      .update(schema.mediaItem)
      .set({ title, releaseDate: new Date('2025-09-26T00:00:00Z') })
      .where(eq(schema.mediaItem.id, 'album-fixture'))
    await databaseClient
      .update(schema.artist)
      .set({ name: 'Jonny Greenwood' })
      .where(eq(schema.artist.id, 'artist-fixture'))
    await databaseClient.insert(schema.externalLink).values({
      id: 'soundtrack-hint',
      mediaItemId: 'album-fixture',
      provider: 'google-custom-search',
      label: 'Rate Your Music',
      url,
    })
    const fresh = {
      results: [
        {
          link: url,
          title: 'One Battle After Another by Jonny Greenwood',
          description:
            'Sep 26, 2025 — One Battle After Another, an Album by Jonny Greenwood. Released 26 September 2025 on Nonesuch. Genres: Film Score, Modern Classical.',
          metadata: {},
        },
      ],
    }
    const empty = { results: [] }
    const job = await runJob(empty, fresh, empty, empty, empty, empty)
    expect(job?.status).toBe('succeeded')
    const queries = [
      `site:rateyourmusic.com Jonny Greenwood ${title}`,
      `site:${url}`,
      `site:rateyourmusic.com/release/ Jonny Greenwood ${title}`,
      `site:rateyourmusic.com/release/ "Jonny Greenwood" "${title}"`,
      `Jonny Greenwood ${title} Rate Your Music rating genres`,
      'Jonny Greenwood One Battle After Another Rate Your Music rating genres',
    ]
    expect(requestedQueries()).toEqual(queries)
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata?.['plugin.serply.provenance']).toMatchObject({
      matchStatus: 'genres-only',
      ratingSourceUrl: null,
      identityEvidence: 'soundtrack-role',
    })
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.payload).toEqual({
      searches: queries.map((query, index) => ({
        query,
        response: index === 1 ? fresh : empty,
      })),
    })
  })
  it('overlaps two Serply requests while preserving spacing and the concurrency cap', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    let active = 0
    let peak = 0
    const starts: number[] = []
    request.mockImplementation(async () => {
      starts.push(Date.now())
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 600))
      active--
      return Response.json(indexed)
    })
    const gated = createProviderRequest(serplyPlugin)
    await Promise.all(
      Array.from({ length: 4 }, () =>
        gated('https://api.serply.io/v1/search/?q=fixture'),
      ),
    )
    expect(peak).toBe(2)
    expect(starts).toHaveLength(4)
    for (let index = 1; index < starts.length; index++) {
      const previous = starts[index - 1]
      const current = starts[index]
      if (previous === undefined || current === undefined)
        throw new Error('Missing request start')
      expect(current - previous).toBeGreaterThanOrEqual(200)
    }
  })

  it('persists the indexed payload, rating and RYM genre provenance', async () => {
    expect((await runJob(indexed))?.status).toBe('succeeded')
    const payload = {
      searches: [{ query: albumQuery, response: indexed }],
    }
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.provider).toBe('serply')
    expect(snapshot?.payload).toEqual(payload)
    const [current] = await databaseClient
      .select()
      .from(schema.providerCurrentState)
    expect(current?.payload).toEqual(payload)
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata).toMatchObject({
      browse: { ratingRymValue: 3.4, ratingRymVotes: 1836 },
      'plugin.serply.provenance': {
        source: 'rym',
        retrievalProvider: 'serply',
        sourceUrl,
        matchStatus: 'rated',
      },
    })
    const tags = await databaseClient.select().from(schema.tag)
    expect(tags.map((tag) => tag.name).sort()).toEqual([
      'Avant-Folk',
      'Glitch Pop',
    ])
    expect(tags.every((tag) => tag.mediaType === 'album')).toBe(true)
    const origins = await databaseClient.select().from(schema.tagOccurrence)
    expect(origins).toHaveLength(2)
    expect(
      origins.every(
        (origin) => origin.provider === 'serply' && origin.source === 'rym',
      ),
    ).toBe(true)
    const references = await databaseClient
      .select()
      .from(schema.providerReference)
    expect(references).toEqual([
      expect.objectContaining({
        provider: 'serply',
        referenceType: 'rym-url',
        externalId: sourceUrl,
      }),
    ])
    expect(JSON.stringify(snapshot?.payload)).not.toContain(
      'offline-fixture-key',
    )
  })

  it('uses one release-specific search when the first result lacks a rating', async () => {
    const partial = { results: [{ ...pripyat, metadata: {} }] }
    expect((await runJob(partial, indexed))?.status).toBe('succeeded')
    expect(requestedQueries()).toEqual([albumQuery, siteQuery])
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.payload).toEqual({
      searches: [
        { query: albumQuery, response: partial },
        { query: siteQuery, response: indexed },
      ],
    })
  })

  it('persists a match from the fourth name-query fallback', async () => {
    const empty = { results: [] }
    expect((await runJob(empty, empty, empty, indexed))?.status).toBe(
      'succeeded',
    )
    expect(requestedQueries()).toEqual([albumQuery, ...fallbackQueries])
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.payload).toEqual({
      searches: [
        { query: albumQuery, response: empty },
        ...fallbackQueries.map((query, index) => ({
          query,
          response: index === 2 ? indexed : empty,
        })),
      ],
    })
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.4,
      ratingRymVotes: 1836,
    })
  })

  it.each([false, true])(
    'treats a legacy external URL as a foreign hint while respecting a manual override (override: %s)',
    async (manualOverride) => {
      const legacyUrl = sourceUrl.replace('/pripyat/', '/wrong-album/')
      await databaseClient.insert(schema.externalLink).values({
        id: 'legacy-rym-link',
        mediaItemId: 'album-fixture',
        provider: 'google-custom-search',
        label: 'Rate Your Music',
        url: legacyUrl,
      })
      if (manualOverride)
        await databaseClient.insert(schema.providerReferenceOverride).values({
          id: 'manual-rym-url',
          mediaItemId: 'album-fixture',
          provider: 'serply',
          referenceType: 'rym-url',
          externalId: sourceUrl,
        })
      const empty = { results: [] }
      const wrong = {
        results: [
          {
            ...pripyat,
            link: legacyUrl,
            title: 'Wrong Album by Marina Herlop (Album)',
            description: '',
          },
        ],
      }
      const scrape = vi.spyOn(serplyPlugin, 'scrapeMediaItem')
      try {
        const job = manualOverride
          ? await runJob(empty, indexed)
          : await runJob(empty, wrong, empty, empty, indexed)
        expect(job?.status).toBe('succeeded')
        expect(scrape).toHaveBeenCalledTimes(1)
        expect(scrape).toHaveBeenCalledWith(
          expect.objectContaining({
            existingReferences: [
              manualOverride
                ? {
                    referenceType: 'rym-url',
                    externalId: sourceUrl,
                    isPrimary: true,
                    metadata: {
                      sourceProvider: 'serply',
                      manualOverride: true,
                    },
                  }
                : {
                    referenceType: 'rym-url',
                    externalId: legacyUrl,
                    isPrimary: false,
                    metadata: {
                      sourceProvider: 'google-custom-search',
                      searchHint: true,
                    },
                  },
            ],
          }),
        )
        expect(requestedQueries()).toEqual(
          manualOverride
            ? [albumQuery, siteQuery]
            : [albumQuery, `site:${legacyUrl}`, ...fallbackQueries],
        )
        if (manualOverride)
          expect(requestedQueries()).not.toContain(`site:${legacyUrl}`)
        const [item] = await databaseClient.select().from(schema.mediaItem)
        expect(item?.metadata?.['browse']).toEqual({
          ratingRymValue: 3.4,
          ratingRymVotes: 1836,
        })
        expect(item?.metadata?.['plugin.serply.provenance']).toMatchObject({
          ratingSourceUrl: sourceUrl,
          matchStatus: 'rated',
        })
        expect(
          await databaseClient.select().from(schema.providerReference),
        ).toEqual([
          expect.objectContaining({
            provider: 'serply',
            referenceType: 'rym-url',
            externalId: sourceUrl,
          }),
        ])
        expect(
          await databaseClient
            .select()
            .from(schema.externalLink)
            .where(eq(schema.externalLink.id, 'legacy-rym-link')),
        ).toEqual([
          expect.objectContaining({
            provider: 'google-custom-search',
            url: legacyUrl,
          }),
        ])
        if (manualOverride)
          expect(
            await databaseClient
              .select()
              .from(schema.providerReferenceOverride),
          ).toEqual([
            expect.objectContaining({
              id: 'manual-rym-url',
              provider: 'serply',
              externalId: sourceUrl,
            }),
          ])
      } finally {
        scrape.mockRestore()
      }
    },
  )

  it.each([false, true])(
    'only a persisted manual override authorizes indexed artist/year conflicts (manual: %s)',
    async (manual) => {
      const url = sourceUrl.replace('marina-herlop', 'indexed-artist')
      const reference = {
        id: 'conflicting-rym-url',
        mediaItemId: 'album-fixture',
        provider: 'serply',
        referenceType: 'rym-url',
        externalId: url,
      }
      if (manual)
        await databaseClient
          .insert(schema.providerReferenceOverride)
          .values({ ...reference, note: 'Reviewed indexed identity' })
      else
        await databaseClient
          .insert(schema.providerReference)
          .values({ ...reference, isPrimary: true })
      const payload = {
        results: [
          {
            ...pripyat,
            link: url,
            title: 'Pripyat by Indexed Artist (Album, Glitch Pop)',
            description:
              'Pripyat, an Album by Indexed Artist. Released 1 June 1997. Genres: Glitch Pop, Avant-Folk.',
            metadata: {
              rating: '3.4',
              reviews: '1,836',
              published_time: 'Jun 1, 1997',
            },
          },
        ],
      }
      const job = manual
        ? await runJob(payload)
        : await runJob(payload, payload, payload, payload, payload)
      expect(job?.status).toBe(manual ? 'succeeded' : 'failed')
      const [item] = await databaseClient.select().from(schema.mediaItem)
      expect(item?.title).toBe('Pripyat')
      expect(item?.releaseDate).toEqual(new Date('2022-05-20T00:00:00Z'))
      const [artist] = await databaseClient.select().from(schema.artist)
      expect(artist?.name).toBe('Marina Herlop')
      if (manual) {
        expect(item?.metadata?.['plugin.serply.provenance']).toMatchObject({
          identityEvidence: 'manual-reference',
          yearEvidence: 'manual-reference-year-conflict',
          ratingSourceUrl: url,
          manualReference: {
            referenceUrl: url,
            libraryArtist: 'Marina Herlop',
            sourceArtistSlug: 'indexed-artist',
            sourceYear: 1997,
            yearConflict: true,
            identityConflict: true,
          },
        })
        expect(item?.metadata?.['browse']).toEqual({
          ratingRymValue: 3.4,
          ratingRymVotes: 1836,
        })
        const [snapshot] = await databaseClient
          .select()
          .from(schema.providerSnapshot)
        expect(snapshot?.payload).toEqual({
          searches: [{ query: albumQuery, response: payload }],
        })
      } else {
        expect(item?.metadata).toBeNull()
        expect(
          await databaseClient.select().from(schema.providerSnapshot),
        ).toEqual([])
      }
    },
  )

  it('persists identity-only success after five searches without inventing a rating or tags', async () => {
    const identity = {
      results: [
        {
          link: sourceUrl,
          title: 'Pripyat by Marina Herlop (Album)',
          description: '',
        },
      ],
    }
    const job = await runJob(identity, identity, identity, identity, identity)
    expect(job?.status).toBe('succeeded')
    expect(requestedQueries()).toEqual([
      albumQuery,
      siteQuery,
      ...fallbackQueries,
    ])
    expect(job?.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('identity only'),
        }),
      ]),
    )
    const payload = {
      searches: [albumQuery, siteQuery, ...fallbackQueries].map((query) => ({
        query,
        response: identity,
      })),
    }
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    const [current] = await databaseClient
      .select()
      .from(schema.providerCurrentState)
    expect(snapshot?.payload).toEqual(payload)
    expect(current?.payload).toEqual(payload)
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata).toMatchObject({
      'plugin.serply.provenance': {
        matchStatus: 'identity-only',
        sourceUrl,
        releaseUrl: sourceUrl,
        ratingSourceUrl: null,
        ratingField: null,
        genresSourceUrl: null,
        genresField: null,
      },
    })
    expect(item?.metadata?.['browse'] ?? {}).not.toHaveProperty(
      'ratingRymValue',
    )
    expect(item?.metadata?.['browse'] ?? {}).not.toHaveProperty(
      'ratingRymVotes',
    )
    expect(await databaseClient.select().from(schema.tag)).toEqual([])
    expect(
      await databaseClient.select().from(schema.providerReference),
    ).toEqual([
      expect.objectContaining({
        provider: 'serply',
        referenceType: 'rym-url',
        externalId: sourceUrl,
      }),
    ])
    expect(await databaseClient.select().from(schema.externalLink)).toEqual([
      expect.objectContaining({ provider: 'serply', url: sourceUrl }),
    ])
  })

  it('keeps an existing score/count pair unchanged when only release identity is indexed', async () => {
    await databaseClient
      .update(schema.mediaItem)
      .set({
        metadata: { browse: { ratingRymValue: 3.2, ratingRymVotes: 1500 } },
      })
      .where(eq(schema.mediaItem.id, 'album-fixture'))
    const identity = {
      results: [
        {
          link: sourceUrl,
          title: 'Pripyat by Marina Herlop (Album)',
          description: '',
        },
      ],
    }
    expect(
      (await runJob(identity, identity, identity, identity, identity))?.status,
    ).toBe('succeeded')
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.2,
      ratingRymVotes: 1500,
    })
    expect(item?.metadata?.['plugin.serply.provenance']).toMatchObject({
      matchStatus: 'identity-only',
      ratingSourceUrl: null,
    })
  })

  it('clears an older vote count when a new score has no known count', async () => {
    await databaseClient
      .update(schema.mediaItem)
      .set({
        metadata: {
          browse: { ratingRymValue: 3.2, ratingRymVotes: 1500, scrobbles: 42 },
        },
      })
      .where(eq(schema.mediaItem.id, 'album-fixture'))
    const payload = {
      results: [{ ...pripyat, metadata: { rating: '3.4' } }],
    }
    expect((await runJob(payload))?.status).toBe('succeeded')
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata?.['browse']).toEqual({
      ratingRymValue: 3.4,
      ratingRymVotes: null,
      scrobbles: 42,
    })
  })

  it('does not publish data or penalize the provider after a valid miss', async () => {
    const empty = { results: [] }
    const job = await runJob(empty, empty, empty, empty)
    expect(job?.status).toBe('failed')
    expect(requestedQueries()).toEqual([albumQuery, ...fallbackQueries])
    expect(
      job?.logs.find((log) => log.level === 'error')?.metadata,
    ).toMatchObject({
      diagnostics: expect.arrayContaining([
        {
          stage: 'serply.selection',
          evidence: { reason: 'no-match', searchCount: 4 },
        },
      ]),
    })
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toEqual([])
    expect(
      await databaseClient.select().from(schema.providerReference),
    ).toEqual([])
    expect(await databaseClient.select().from(schema.tag)).toEqual([])
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata).toBeNull()
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety).toMatchObject({
      failureCount: 0,
      cooldownUntil: null,
      halted: false,
    })
  })
})
