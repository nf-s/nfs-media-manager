import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { z } from 'zod'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { SONOVAULT_SIMILAR_LOOKUP_TASK } from '@repo/schemas/sonovault'
import { SPOTIFY_SIMILAR_LOOKUP_TASK } from '@repo/schemas/tidal'
import { env } from '@/env'
import { clearTidalTokenCache } from '@/lib/tidal-api'
import { sonovaultPlugin } from '@/plugins/builtin/sonovault'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { tidalPlugin } from '@/plugins/builtin/tidal'
import {
  sonovaultBulkFixture,
  sonovaultLinksFixture,
  sonovaultMatchedLine,
  sonovaultMissLine,
  sonovaultTrackFixture,
} from '@/plugins/builtin/__tests__/fixtures/sonovault'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import * as schema from '@/schemas/db'

const database = `sonovault_similar_${randomUUID().replaceAll('-', '')}`
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
const sonovaultSecrets: Record<string, string> = {}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'tidal'
      ? tidalPlugin
      : id === 'spotify'
        ? spotifyPlugin
        : id === 'sonovault'
          ? sonovaultPlugin
          : null,
  listLoadedScrapePlugins: async () => [
    tidalPlugin,
    spotifyPlugin,
    sonovaultPlugin,
  ],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: (provider: string) =>
    provider === 'tidal'
      ? {
          clientId: 'offline-fixture-client',
          clientSecret: 'offline-fixture-secret',
        }
      : provider === 'sonovault'
        ? { ...sonovaultSecrets }
        : {
            clientId: 'offline-spotify-client',
            clientSecret: 'offline-spotify-secret',
            market: 'AU',
          },
}))

import { getJob, processQueuedJobs } from '@/services/jobs'
import { readProviderResponseAttempt } from '@/services/provider-response-history'
import { queueSonovaultRefresh } from '@/services/sonovault-album-lookup'
import {
  getSonovaultSummary,
  removeSonovaultData,
} from '@/services/sonovault-track-lookup'
import {
  getTidalSimilar,
  refreshTidalSimilar,
  suggestionsNeedingSpotify,
} from '@/services/tidal-similar'

const userId = 'fixture-owner'
const trackId = 'track-seed'
const apiKey = 'offline-fixture-sonovault-key'
const spotifyId = (n: number) => `fixturespotify${String(n).padStart(8, '0')}`
const isrc = (n: number) => `QZFX2${2800000 + n}`
const TIDAL_DURATION_SEC = 348

const artist = (id: string, name: string) => ({
  id,
  type: 'artists',
  attributes: { name },
})
const tidalTrack = (id: string, title: string, code: string) => ({
  id,
  type: 'tracks',
  attributes: {
    title,
    isrc: code,
    duration: 'PT5M48S',
    externalLinks: [
      {
        href: `https://tidal.com/browse/track/${id}`,
        meta: { type: 'TIDAL_SHARING' },
      },
    ],
  },
  relationships: { artists: { data: [{ id: '700001', type: 'artists' }] } },
})
// One in the library by ISRC, one Sonovault maps, one whose Sonovault record
// is another version, one neither service has, one without a Spotify link.
const titles = [
  'Glass Arcade',
  'Afterhours Telex',
  'Halogen',
  'Lantern Code',
  'Quiet Relay',
]
const tidalTracks = titles.map((title, index) =>
  tidalTrack(String(820001 + index), title, isrc(index + 1)),
)
const similarTracks = {
  data: tidalTracks.map(({ id, type }) => ({ id, type })),
  included: [...tidalTracks, artist('700001', 'Halcyon Grid')],
  links: { self: '/similar' },
}

const sonovaultLines = new Map([
  [
    isrc(2),
    sonovaultMatchedLine(
      isrc(2),
      sonovaultTrackFixture(2, {
        title: 'Afterhours Telex',
        duration: TIDAL_DURATION_SEC + 2,
        isrc: isrc(2),
      }),
      sonovaultLinksFixture(2, spotifyId(20)),
    ),
  ],
  [
    isrc(3),
    // The extended mix's record on the radio edit's ISRC.
    sonovaultMatchedLine(
      isrc(3),
      sonovaultTrackFixture(3, {
        title: 'Halogen (Extended Mix)',
        duration: 512,
        isrc: isrc(3),
      }),
      sonovaultLinksFixture(3, spotifyId(30)),
    ),
  ],
  [isrc(4), sonovaultMissLine(isrc(4))],
  [
    isrc(5),
    sonovaultMatchedLine(
      isrc(5),
      sonovaultTrackFixture(5, {
        title: 'Quiet Relay',
        duration: TIDAL_DURATION_SEC,
        isrc: isrc(5),
      }),
      sonovaultLinksFixture(5, spotifyId(50)).filter(
        ({ source }) => source !== 'spotify',
      ),
    ),
  ],
])
const ResolveBodySchema = z.object({
  input_type: z.literal('isrc'),
  items: z.array(z.string()),
})

const spotifyTrack = (n: number, code: string) => ({
  type: 'track',
  id: spotifyId(n),
  name: `Spotify ${n}`,
  duration_ms: TIDAL_DURATION_SEC * 1000,
  artists: [{ id: spotifyId(900), name: 'Halcyon Grid' }],
  album: {
    id: spotifyId(n + 100),
    name: `Release ${n}`,
    album_type: 'album',
    release_date: '2021-01-01',
    images: [{ url: `https://i.scdn.co/image/fixture${n}` }],
  },
  external_ids: { isrc: code },
})
const trackSearches = new Map<string, unknown[]>([
  [isrc(2), [spotifyTrack(21, isrc(2))]],
  [isrc(3), [spotifyTrack(31, isrc(3))]],
  [isrc(4), []],
  [isrc(5), [spotifyTrack(51, isrc(5))]],
])

function mockProviders() {
  request.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === 'https://auth.tidal.com/v1/oauth2/token')
      return Response.json({
        access_token: 'offline-fixture-token',
        expires_in: 14400,
        token_type: 'Bearer',
      })
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === '/v2/tracks/800002/relationships/similarTracks')
      return Response.json(similarTracks)
    if (url.href === 'https://api.sonovault.now/v1/tracks/resolve') {
      if (new Headers(init?.headers).get('x-api-key') !== apiKey)
        return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const body = ResolveBodySchema.parse(JSON.parse(String(init?.body)))
      return Response.json(
        sonovaultBulkFixture(
          body.items.map(
            (item) => sonovaultLines.get(item) ?? sonovaultMissLine(item),
          ),
          31000,
        ),
      )
    }
    if (url.href.startsWith('https://api.spotify.com/v1/search')) {
      const [field, code = ''] = (url.searchParams.get('q') ?? '').split(':')
      if (field === 'isrc' && trackSearches.has(code))
        return Response.json({
          tracks: { items: trackSearches.get(code), offset: 0, total: 1 },
        })
    }
    throw new Error(`Unexpected request ${url.href}`)
  })
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient
    .insert(schema.user)
    .values({ id: userId, name: 'Fixture Owner', email: 'owner@example.test' })
})
beforeEach(async () => {
  clearTidalTokenCache()
  for (const key of Object.keys(sonovaultSecrets)) delete sonovaultSecrets[key]
  sonovaultSecrets['apiKey'] = apiKey
  request.mockReset()
  mockProviders()
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.spotifyCodeLookup)
  await databaseClient.delete(schema.providerResponse)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values(
    [
      [trackId, 'Signal Fade'],
      ['track-library', 'Glass Arcade'],
    ].map(([id, title]) => ({
      id,
      slug: id,
      title,
      mediaType: 'track' as const,
    })),
  )
  await databaseClient
    .insert(schema.libraryTrack)
    .values([
      { mediaItemId: trackId },
      { mediaItemId: 'track-library', spotifyTrackId: spotifyId(11) },
    ])
  await databaseClient.insert(schema.providerReference).values([
    {
      id: 'r1',
      mediaItemId: trackId,
      provider: 'tidal',
      referenceType: 'track',
      externalId: '800002',
      metadata: {},
    },
    {
      id: 'r2',
      mediaItemId: 'track-library',
      provider: 'spotify',
      referenceType: 'isrc',
      externalId: isrc(1),
      metadata: {},
    },
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

/** Runs queued jobs, waiting out each provider's request spacing. */
async function runQueued() {
  for (let round = 0; round < 20; round += 1) {
    const [queued] = await databaseClient
      .select({ provider: schema.scrapeJob.provider })
      .from(schema.scrapeJob)
      .where(eq(schema.scrapeJob.status, 'queued'))
      .limit(1)
    if (!queued) return
    const [gate] = await databaseClient
      .select({ nextAllowedAt: schema.providerRequestState.nextAllowedAt })
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, queued.provider))
    const wait = (gate?.nextAllowedAt?.getTime() ?? 0) - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 50))
    await processQueuedJobs()
  }
  throw new Error('Queued jobs did not finish')
}

const requested = () =>
  request.mock.calls.flatMap(([input, init]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/v1/search')
      return [`spotify ${url.searchParams.get('q') ?? ''}`]
    if (url.hostname === 'api.sonovault.now')
      return [
        `sonovault ${ResolveBodySchema.parse(JSON.parse(String(init?.body))).items.join(',')}`,
      ]
    return []
  })

async function storedLookups() {
  return databaseClient
    .select({
      code: schema.spotifyCodeLookup.code,
      spotifyId: schema.spotifyCodeLookup.spotifyId,
      source: schema.spotifyCodeLookup.source,
      responseId: schema.spotifyCodeLookup.responseId,
      scrapeJobId: schema.spotifyCodeLookup.scrapeJobId,
    })
    .from(schema.spotifyCodeLookup)
    .orderBy(schema.spotifyCodeLookup.code)
}

async function jobsByTask(task: string) {
  return databaseClient
    .select({
      id: schema.scrapeJob.id,
      provider: schema.scrapeJob.provider,
      status: schema.scrapeJob.status,
      options: schema.scrapeJob.options,
    })
    .from(schema.scrapeJob)
    .where(sql`${schema.scrapeJob.options}->>'task' = ${task}`)
}

describe('SONO-26: similar tracks mapped to Spotify through Sonovault', () => {
  it('maps verified records through one bulk call and leaves the rest to Spotify search', async () => {
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()

    // The library track is not sent; one Sonovault request for the other
    // four, then a Spotify search only for the three it did not map.
    expect(requested()).toEqual([
      `sonovault ${[2, 3, 4, 5].map(isrc).join(',')}`,
      `spotify isrc:${isrc(3)}`,
      `spotify isrc:${isrc(4)}`,
      `spotify isrc:${isrc(5)}`,
    ])

    const [sonovaultJob] = await jobsByTask(SONOVAULT_SIMILAR_LOOKUP_TASK)
    const [spotifyJob] = await jobsByTask(SPOTIFY_SIMILAR_LOOKUP_TASK)
    if (!sonovaultJob || !spotifyJob) throw new Error('Missing jobs')
    expect(sonovaultJob).toMatchObject({
      provider: 'sonovault',
      status: 'succeeded',
      options: {
        itemId: trackId,
        sent: 4,
        mapped: 1,
        notFound: 1,
        noSpotify: 1,
        unverified: 1,
        skipped: 0,
        creditsUsed: 4,
        creditsRemaining: 31000,
      },
    })
    expect(spotifyJob).toMatchObject({
      provider: 'spotify',
      status: 'succeeded',
      options: { codes: [isrc(3), isrc(4), isrc(5)] },
    })
    expect((await getJob(sonovaultJob.id))?.scope).toEqual({
      mediaType: 'track',
      mediaItemIds: [trackId],
      limit: 1,
    })

    // The response is stored with its job, without the key.
    const captures = await readProviderResponseAttempt({
      jobId: sonovaultJob.id,
      attempt: 1,
    })
    expect(captures.map(({ capture }) => capture.request.url)).toEqual([
      'https://api.sonovault.now/v1/tracks/resolve',
    ])
    expect(JSON.stringify(captures)).not.toContain(apiKey)
    const [response] = await databaseClient
      .select({
        id: schema.providerResponse.id,
        provider: schema.providerResponse.provider,
      })
      .from(schema.providerResponse)
      .where(eq(schema.providerResponse.jobId, sonovaultJob.id))
    expect(response?.provider).toBe('sonovault')

    expect(await storedLookups()).toEqual([
      {
        code: isrc(2),
        spotifyId: spotifyId(20),
        source: 'sonovault',
        responseId: response?.id,
        scrapeJobId: sonovaultJob.id,
      },
      {
        code: isrc(3),
        spotifyId: spotifyId(31),
        source: 'spotify',
        responseId: null,
        scrapeJobId: spotifyJob.id,
      },
      {
        code: isrc(4),
        spotifyId: null,
        source: 'spotify',
        responseId: null,
        scrapeJobId: spotifyJob.id,
      },
      {
        code: isrc(5),
        spotifyId: spotifyId(51),
        source: 'spotify',
        responseId: null,
        scrapeJobId: spotifyJob.id,
      },
    ])

    const result = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(result.lookupJob).toMatchObject({
      jobId: spotifyJob.id,
      status: 'succeeded',
    })
    expect(result.items.map(({ state }) => state)).toEqual([
      'library',
      'spotify',
      'spotify',
      'none',
      'spotify',
    ])
    expect(result.items[1]?.spotify).toEqual({
      spotifyId: spotifyId(20),
      url: `https://open.spotify.com/track/${spotifyId(20)}`,
      title: 'Afterhours Telex',
      artists: ['Fixture Artist'],
      albumName: null,
      spotifyAlbumId: null,
      artworkUrl: null,
      durationSec: TIDAL_DURATION_SEC + 2,
      trackCount: null,
    })

    // The credits it reported are the provider's latest.
    expect((await getSonovaultSummary()).credits.remaining).toBe(31000)

    // SONO-10: a match older than the refresh interval is due again, and the
    // refresh removes it.
    await databaseClient
      .update(schema.spotifyCodeLookup)
      .set({ searchedAt: sql`now() - interval '12 months'` })
      .where(eq(schema.spotifyCodeLookup.code, isrc(2)))
    const due = await suggestionsNeedingSpotify(
      databaseClient,
      'track',
      result.items,
    )
    expect(due.map(({ key }) => key)).toEqual([isrc(2)])
    await queueSonovaultRefresh(userId)
    expect((await storedLookups()).map(({ code }) => code)).toEqual([
      isrc(3),
      isrc(4),
      isrc(5),
    ])
  }, 30000)

  it('removes its matches with the rest of Sonovault data', async () => {
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()
    const removal = await removeSonovaultData()
    expect(removal.lookups).toBe(1)
    expect(removal.responses).toBe(1)
    expect(
      (await storedLookups()).every(({ source }) => source === 'spotify'),
    ).toBe(true)
    const result = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(result.items[1]?.state).toBe('unsearched')
  }, 30000)

  it('searches Spotify for every suggestion when Sonovault is not configured', async () => {
    delete sonovaultSecrets['apiKey']
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()
    expect(requested()).toEqual(
      [2, 3, 4, 5].map((n) => `spotify isrc:${isrc(n)}`),
    )
    expect(await jobsByTask(SONOVAULT_SIMILAR_LOOKUP_TASK)).toEqual([])
    expect(
      (await storedLookups()).every(({ source }) => source === 'spotify'),
    ).toBe(true)
  }, 30000)

  it('falls back to Spotify search when the credit reserve would be crossed', async () => {
    sonovaultSecrets['monthlyCredits'] = '2003'
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()
    expect(requested()).toEqual(
      [2, 3, 4, 5].map((n) => `spotify isrc:${isrc(n)}`),
    )
    const [sonovaultJob] = await jobsByTask(SONOVAULT_SIMILAR_LOOKUP_TASK)
    expect(sonovaultJob?.status).toBe('succeeded')
    expect(sonovaultJob?.options).toMatchObject({ mapped: 0, sent: 0 })
  }, 30000)
})
