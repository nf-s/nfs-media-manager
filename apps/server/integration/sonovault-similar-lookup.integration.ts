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
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_TASK,
} from '@repo/schemas/tidal'
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
import { sonovaultReleaseFixture } from '@/plugins/builtin/__tests__/fixtures/sonovault/releases'
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

import { createTaskJob, processQueuedJobs, retryJob } from '@/services/jobs'
import { readProviderResponseAttempt } from '@/services/provider-response-history'
import {
  ProviderTaskReplayStepsSchema,
  replayProviderTask,
} from '@/services/provider-task-replay'
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
const albumId = 'album-seed'
const barcode = '0123456789012'
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

const externalAlbum = {
  id: '830001',
  type: 'albums',
  attributes: { title: 'Quiet Transmissions', barcodeId: barcode },
  relationships: { artists: { data: [{ id: '700002', type: 'artists' }] } },
}
const missingAlbum = {
  ...externalAlbum,
  id: '830002',
  attributes: { title: 'Missing Edition', barcodeId: '1123456789012' },
}
const similarAlbums = {
  data: [externalAlbum, missingAlbum].map(({ id, type }) => ({ id, type })),
  included: [
    externalAlbum,
    missingAlbum,
    artist('700002', 'External Fixture Artist'),
  ],
}
const releaseForAlbum = (edition: number | null) => {
  const release = sonovaultReleaseFixture({
    id: 301,
    title: externalAlbum.attributes.title,
    editions: [
      {
        id: 310,
        source: 'spotify',
        externalId: spotifyId(301),
        barcode,
      },
    ],
    tracks: [
      { id: 302, title: 'Night Radio', duration: 300, number: 1 },
      { id: 303, title: 'Bonus Track', duration: 270 },
    ],
    edition,
    digitalUpc: barcode,
  })
  return {
    ...release,
    tracks: release.tracks.map((track) => ({
      ...track,
      genre: track.id === 302 ? ['Ambient'] : ['Rock'],
      subgenre: track.id === 302 ? ['Dark Ambient'] : [],
    })),
  }
}

const sonovaultLines = new Map([
  [
    isrc(2),
    sonovaultMatchedLine(
      isrc(2),
      {
        ...sonovaultTrackFixture(2, {
          title: 'Afterhours Telex',
          duration: TIDAL_DURATION_SEC + 2,
          isrc: isrc(2),
        }),
        genre: [' House ', 'house'],
        subgenre: ['Acid House'],
      },
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
      {
        ...sonovaultTrackFixture(5, {
          title: 'Quiet Relay',
          duration: TIDAL_DURATION_SEC,
          isrc: isrc(5),
        }),
        genre: ['Electronic'],
        subgenre: [],
      },
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
    if (url.pathname === '/v2/albums/800001/relationships/similarAlbums')
      return Response.json(similarAlbums)
    if (url.pathname === `/v1/releases/upc/${barcode}`)
      return Response.json({
        upc: barcode,
        results: [
          {
            id: 301,
            title: externalAlbum.attributes.title,
            artist: { id: 7001, name: 'External Fixture Artist' },
            label: null,
            release_date: null,
            digital_upc: barcode,
            formats: ['digital'],
          },
        ],
      })
    if (
      url.pathname === `/v1/releases/upc/${missingAlbum.attributes.barcodeId}`
    )
      return Response.json(
        { message: 'No release for this barcode' },
        { status: 404 },
      )
    if (url.pathname === '/v1/releases/301')
      return Response.json(
        releaseForAlbum(url.searchParams.has('edition') ? 310 : null),
      )
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
      if (field === 'upc') return Response.json({ albums: { items: [] } })
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

async function sonovaultGate(values: {
  nextAllowedAt?: Date
  cooldownUntil?: Date
  halted?: boolean
}) {
  await databaseClient
    .insert(schema.providerRequestState)
    .values({ provider: 'sonovault', ...values })
    .onConflictDoUpdate({
      target: schema.providerRequestState.provider,
      set: values,
    })
}

const sonovaultEvents = () =>
  databaseClient
    .select({
      requestedAt: schema.providerRequestEvent.requestedAt,
      requestClass: schema.providerRequestEvent.requestClass,
    })
    .from(schema.providerRequestEvent)
    .where(eq(schema.providerRequestEvent.provider, 'sonovault'))

/** The last line a job logged: its result message. */
async function lastLog(jobId: string) {
  const logs = await databaseClient
    .select({ message: schema.scrapeJobLog.message })
    .from(schema.scrapeJobLog)
    .where(eq(schema.scrapeJobLog.jobId, jobId))
    .orderBy(schema.scrapeJobLog.createdAt)
  return logs.at(-1)?.message ?? ''
}

/** The TIDAL similar read's job, which also made the Sonovault request. */
async function readJob() {
  const [job] = await jobsByTask(TIDAL_SIMILAR_TASK)
  if (!job) throw new Error('Missing TIDAL similar job')
  return job
}

describe('SONO-26: similar tracks mapped to Spotify through Sonovault', () => {
  it('fills external track genres even with recent Spotify matches and misses', async () => {
    delete sonovaultSecrets['apiKey']
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()
    const before = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(before.items[4]).toMatchObject({
      state: 'spotify',
      library: null,
      genres: [],
    })
    expect(before.items[3]?.state).toBe('none')
    sonovaultSecrets['apiKey'] = apiKey
    const after = await refreshTidalSimilar(
      { kind: 'tracks', id: trackId },
      userId,
    )
    expect(after.items[4]).toMatchObject({
      state: 'spotify',
      library: null,
      spotify: { spotifyId: spotifyId(51) },
      genres: ['Electronic'],
      genreSource: 'sonovault',
    })
    expect(after.items[3]).toMatchObject({ state: 'none', genres: [] })
    const refreshed = await refreshTidalSimilar(
      { kind: 'tracks', id: trackId },
      userId,
    )
    expect(refreshed.items[4]).toMatchObject({
      genres: ['Electronic'],
      genreEvidence: after.items[4]?.genreEvidence,
    })
    expect(await sonovaultEvents()).toHaveLength(1)
    await databaseClient
      .update(schema.providerResponse)
      .set({ receivedAt: new Date(Date.now() - 31 * 86400_000) })
      .where(eq(schema.providerResponse.provider, 'sonovault'))
    const stale = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(stale.items[4]).toMatchObject({
      state: 'spotify',
      genres: [],
      genreEvidence: null,
    })
  }, 30000)

  it('uses and reuses a confirmed external edition, skips a miss and loses removed evidence', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: albumId,
      slug: albumId,
      title: 'Fixture Seed Album',
      mediaType: 'album',
    })
    await databaseClient.insert(schema.album).values({ mediaItemId: albumId })
    await databaseClient.insert(schema.providerReference).values({
      id: 'album-ref',
      mediaItemId: albumId,
      provider: 'tidal',
      referenceType: 'album',
      externalId: '800001',
      metadata: {},
    })
    const read = await refreshTidalSimilar(
      { kind: 'albums', id: albumId },
      userId,
    )
    await runQueued()
    expect(read.items[0]).toMatchObject({
      library: null,
      genres: ['Ambient', 'Dark Ambient'],
      genreSource: 'sonovault-album-tracks',
      genreEvidence: {
        jobId: expect.any(String),
        responseId: expect.any(String),
      },
    })
    expect(read.items[1]).toMatchObject({
      library: null,
      genres: [],
      genreEvidence: null,
    })
    const job = await readJob()
    const stored = await readProviderResponseAttempt({
      jobId: job.id,
      attempt: 1,
    })
    expect(stored.map(({ capture }) => capture.response.status)).toEqual([
      200, 200, 200, 200, 404,
    ])
    expect(job.options).toMatchObject({ creditsUsed: 4 })
    const again = await refreshTidalSimilar(
      { kind: 'albums', id: albumId },
      userId,
    )
    expect(again.items[0]).toMatchObject({
      genres: ['Ambient', 'Dark Ambient'],
      genreEvidence: { jobId: job.id, responseId: expect.any(String) },
    })
    expect(await sonovaultEvents()).toHaveLength(4)
    await removeSonovaultData()
    const removed = await getTidalSimilar({ kind: 'albums', id: albumId })
    expect(removed.items[0]).toMatchObject({ genres: [], genreEvidence: null })
  }, 30000)

  it('maps verified records in the TIDAL read and leaves the rest to Spotify search', async () => {
    const read = await refreshTidalSimilar(
      { kind: 'tracks', id: trackId },
      userId,
    )

    // The library track is not sent; the one Sonovault request is made in
    // the read, before any queued job runs, and no Sonovault job is queued.
    expect(requested()).toEqual([
      `sonovault ${[2, 3, 4, 5].map(isrc).join(',')}`,
    ])
    expect(await jobsByTask(SONOVAULT_SIMILAR_LOOKUP_TASK)).toEqual([])
    expect(read.items.map(({ state }) => state)).toEqual([
      'library',
      'spotify',
      'unsearched',
      'unsearched',
      'unsearched',
    ])
    expect(read.items[1]?.spotify).toEqual({
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
    expect(read.items[1]).toMatchObject({
      genres: ['House', 'Acid House'],
      genreSource: 'sonovault',
    })
    expect(read.items[2]).toMatchObject({ genres: [], genreSource: null })
    expect(read.items[4]).toMatchObject({
      genres: ['Electronic'],
      genreSource: 'sonovault',
    })

    const tidalJob = await readJob()
    expect(tidalJob).toMatchObject({
      provider: 'tidal',
      status: 'succeeded',
      options: {
        itemId: trackId,
        sonovault: {
          sent: 4,
          mapped: 1,
          notFound: 1,
          noSpotify: 1,
          unverified: 1,
          skipped: 0,
          creditsUsed: 4,
        },
        creditsRemaining: 31000,
      },
    })
    expect(await lastLog(tidalJob.id)).toMatch(
      /Mapped 1 of 4 to Spotify through Sonovault\. 3 left for Spotify search\./,
    )
    // The request went through Sonovault's gate and is counted there.
    expect(await sonovaultEvents()).toEqual([
      { requestedAt: expect.any(Date), requestClass: 'write' },
    ])

    await runQueued()
    expect(requested()).toEqual([
      `sonovault ${[2, 3, 4, 5].map(isrc).join(',')}`,
      `spotify isrc:${isrc(3)}`,
      `spotify isrc:${isrc(4)}`,
      `spotify isrc:${isrc(5)}`,
    ])
    const [spotifyJob] = await jobsByTask(SPOTIFY_SIMILAR_LOOKUP_TASK)
    if (!spotifyJob) throw new Error('Missing Spotify job')
    expect(spotifyJob).toMatchObject({
      provider: 'spotify',
      status: 'succeeded',
      options: { codes: [isrc(3), isrc(4), isrc(5)] },
    })

    // The Sonovault response is stored with the TIDAL read, under Sonovault,
    // numbered after TIDAL's own, without the key.
    const responses = await databaseClient
      .select({
        id: schema.providerResponse.id,
        provider: schema.providerResponse.provider,
        ordinal: schema.providerResponse.ordinal,
        requestUrl: schema.providerResponse.requestUrl,
      })
      .from(schema.providerResponse)
      .where(eq(schema.providerResponse.jobId, tidalJob.id))
      .orderBy(schema.providerResponse.ordinal)
    expect(responses).toEqual([
      {
        id: expect.any(String),
        provider: 'tidal',
        ordinal: 1,
        requestUrl: expect.stringContaining('/similarTracks'),
      },
      {
        id: expect.any(String),
        provider: 'sonovault',
        ordinal: 2,
        requestUrl: 'https://api.sonovault.now/v1/tracks/resolve',
      },
    ])
    const sonovaultResponse = responses[1]
    expect(
      JSON.stringify(
        await readProviderResponseAttempt({ jobId: tidalJob.id, attempt: 1 }),
      ),
    ).not.toContain(apiKey)
    expect(tidalJob.options.sonovault).toMatchObject({
      responseId: sonovaultResponse?.id,
    })

    expect(await storedLookups()).toEqual([
      {
        code: isrc(2),
        spotifyId: spotifyId(20),
        source: 'sonovault',
        responseId: sonovaultResponse?.id,
        scrapeJobId: tidalJob.id,
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

    // Both jobs still replay from what they stored: the TIDAL read from its
    // own provider's responses, the Spotify search from its own.
    const tidalReplay = await replayProviderTask(
      TIDAL_SIMILAR_TASK,
      'tidal',
      ProviderTaskReplayStepsSchema.parse(tidalJob.options.providerReplaySteps),
      (
        await readProviderResponseAttempt({
          jobId: tidalJob.id,
          attempt: 1,
          provider: 'tidal',
        })
      ).map(({ capture }) => capture),
    )
    expect(tidalReplay).toEqual([
      expect.arrayContaining([expect.objectContaining({ tidalId: '820002' })]),
    ])
    const spotifyReplay = await replayProviderTask(
      SPOTIFY_SIMILAR_LOOKUP_TASK,
      'spotify',
      ProviderTaskReplayStepsSchema.parse(
        spotifyJob.options.providerReplaySteps,
      ),
      (
        await readProviderResponseAttempt({
          jobId: spotifyJob.id,
          attempt: 1,
        })
      ).map(({ capture }) => capture),
    )
    expect(spotifyReplay).toHaveLength(3)

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

  it('waits for its paced slot in the shared gate, then is counted', async () => {
    const slot = Date.now() + 1500
    await sonovaultGate({ nextAllowedAt: new Date(slot) })
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    const events = await sonovaultEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.requestedAt.getTime()).toBeGreaterThanOrEqual(slot - 5)
    expect((await readJob()).options.sonovault).toMatchObject({ mapped: 1 })
    const [gate] = await databaseClient
      .select({ nextAllowedAt: schema.providerRequestState.nextAllowedAt })
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'sonovault'))
    // The next Sonovault request, from any job, starts 1.1 s after it.
    expect(gate?.nextAllowedAt?.getTime()).toBeGreaterThanOrEqual(slot + 1095)
  }, 30000)

  it('falls back to Spotify search without waiting when no slot comes within the read', async () => {
    await sonovaultGate({ nextAllowedAt: new Date(Date.now() + 60000) })
    const started = Date.now()
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    expect(Date.now() - started).toBeLessThan(15000)
    expect(requested()).toEqual([])
    expect(await sonovaultEvents()).toEqual([])
    expect(await lastLog((await readJob()).id)).toMatch(
      /Sonovault not used: Sonovault is busy with other requests\. 4 left for Spotify search\./,
    )
    await runQueued()
    expect(requested()).toEqual(
      [2, 3, 4, 5].map((n) => `spotify isrc:${isrc(n)}`),
    )
  }, 30000)

  it.each([
    ['cooling down', { cooldownUntil: new Date(Date.now() + 3600000) }],
    ['halted', { halted: true }],
  ])(
    'falls back to Spotify search while Sonovault is %s',
    async (_, gate) => {
      await sonovaultGate(gate)
      const read = await refreshTidalSimilar(
        { kind: 'tracks', id: trackId },
        userId,
      )
      expect(read.items.map(({ state }) => state)).toEqual([
        'library',
        'unsearched',
        'unsearched',
        'unsearched',
        'unsearched',
      ])
      expect(await sonovaultEvents()).toEqual([])
      expect((await readJob()).options.sonovault).toEqual({
        sent: 0,
        mapped: 0,
      })
      await runQueued()
      expect(requested()).toEqual(
        [2, 3, 4, 5].map((n) => `spotify isrc:${isrc(n)}`),
      )
    },
    30000,
  )

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
    expect(result.items[1]).toMatchObject({
      state: 'unsearched',
      genres: [],
      genreSource: null,
    })
    expect(result.items[4]).toMatchObject({ genres: [], genreSource: null })
  }, 30000)

  it('keeps a Sonovault genre after adding and prefers visible library genres', async () => {
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    const newId = 'track-added'
    await databaseClient.insert(schema.mediaItem).values({
      id: newId,
      title: 'Afterhours Telex',
      slug: newId,
      mediaType: 'track',
    })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: newId })
    await databaseClient.insert(schema.providerReference).values({
      id: 'fixture-added-track-tidal',
      mediaItemId: newId,
      provider: 'tidal',
      referenceType: 'track',
      externalId: '820002',
    })
    const requestCount = request.mock.calls.length
    const added = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(added.items[1]).toMatchObject({
      state: 'library',
      library: { id: newId },
      genres: ['House', 'Acid House'],
      genreSource: 'sonovault',
    })
    await databaseClient.insert(schema.tag).values({
      id: 'fixture-track-genre',
      mediaType: 'album',
      name: 'West Coast House',
      kind: 'subgenre',
    })
    await databaseClient.insert(schema.trackTag).values({
      mediaItemId: newId,
      tagId: 'fixture-track-genre',
      owner: 'added',
    })
    const edited = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(edited.items[1]).toMatchObject({
      genres: ['West Coast House'],
      genreSource: 'library',
    })
    await databaseClient
      .update(schema.trackTag)
      .set({ owner: 'removed' })
      .where(eq(schema.trackTag.mediaItemId, newId))
    const removed = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(removed.items[1]).toMatchObject({ genres: [], genreSource: null })
    expect(request.mock.calls).toHaveLength(requestCount)
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
    expect((await readJob()).options.sonovault).toEqual({ sent: 0, mapped: 0 })
    expect(await lastLog((await readJob()).id)).toMatch(
      /Sonovault not used: 4 credits would leave fewer than the 2000-credit reserve/,
    )
  }, 30000)

  it('still runs a lookup job queued before the release, and makes no new ones', async () => {
    const tracks = [
      { code: isrc(2), title: 'Afterhours Telex', durationSec: 348 },
    ]
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'queued-similar-lookup',
      provider: 'sonovault',
      status: 'queued',
      scope: { mediaType: 'track', mediaItemIds: [trackId], limit: 1 },
      options: {
        task: SONOVAULT_SIMILAR_LOOKUP_TASK,
        kind: 'track',
        itemId: trackId,
        tracks,
        groupKey: 'queued-similar-lookup-group',
        dispatchPriority: 2,
      },
      requestedByUserId: userId,
    })
    await runQueued()
    const [job] = await jobsByTask(SONOVAULT_SIMILAR_LOOKUP_TASK)
    expect(job).toMatchObject({
      status: 'succeeded',
      options: { mapped: 1, sent: 1, creditsRemaining: 31000 },
    })
    const captures = await readProviderResponseAttempt({
      jobId: 'queued-similar-lookup',
      attempt: 1,
    })
    expect(captures.map(({ capture }) => capture.ordinal)).toEqual([1])
    expect(await storedLookups()).toEqual([
      expect.objectContaining({
        code: isrc(2),
        source: 'sonovault',
        scrapeJobId: 'queued-similar-lookup',
      }),
    ])
    await expect(
      createTaskJob(SONOVAULT_SIMILAR_LOOKUP_TASK, userId, {
        taskOptions: { kind: 'track', itemId: trackId, tracks },
      }),
    ).rejects.toThrow(/looked up on Sonovault when they are read from TIDAL/)
    await expect(
      retryJob('queued-similar-lookup', userId, false),
    ).rejects.toThrow(/looked up on Sonovault when they are read from TIDAL/)
  }, 30000)
})
