import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, asc, eq } from 'drizzle-orm'
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
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { TIDAL_TRACK_MATCH_TASK } from '@repo/schemas/tidal'
import { env } from '@/env'
import { createStableId } from '@/lib/media-utils'
import { clearTidalTokenCache } from '@/lib/tidal-api'
import { tidalPlugin } from '@/plugins/builtin/tidal'
import * as schema from '@/schemas/db'

const database = `tidal_track_match_${randomUUID().replaceAll('-', '')}`
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
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) => (id === 'tidal' ? tidalPlugin : null),
  listLoadedScrapePlugins: async () => [tidalPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'offline-fixture-client',
    clientSecret: 'offline-fixture-secret',
  }),
}))

import { getJob, IN_REQUEST_SLOT_WAIT_MS } from '@/services/jobs'
import { readProviderResponseAttempt } from '@/services/provider-response-history'
import {
  ProviderTaskReplayStepsSchema,
  replayProviderTask,
} from '@/services/provider-task-replay'
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import { listTrackMatchDiagnostics } from '@/services/track-match-diagnostics'
import {
  acceptTidalTrackMatch,
  getTidalTrackMatch,
  listTidalTrackMatchStatuses,
  matchTidalTracks,
} from '@/services/tidal-track-match'

const userId = 'fixture-owner'
const albumId = 'album-fixture'
// The library keeps 13 digits; TIDAL reports the same barcode with 12.
const libraryUpc = '0000000000017'
const tidalUpc = '000000000017'
const isrc = (n: number) => `QZFX1${2700000 + n}`
const libraryDuration = (position: number) => 180 + position * 10
const scenario = {
  single: 1,
  albumUpc: 2,
  duration: 3,
  ambiguous: 4,
  none: 5,
} as const

const tidalAlbum = (
  id: string,
  title: string,
  barcodeId: string,
  albumType: 'ALBUM' | 'EP' | 'SINGLE' = 'ALBUM',
) => ({
  id,
  type: 'albums',
  attributes: {
    title,
    barcodeId,
    albumType,
    releaseDate: '2020-01-01',
    numberOfItems: 10,
  },
})
const tidalTrack = (
  id: string,
  position: number,
  album: string,
  overrides: {
    durationSec?: number
    version?: string
    isrc?: string
    streamable?: boolean
  } = {},
) => {
  const seconds = overrides.durationSec ?? libraryDuration(position)
  return {
    id,
    type: 'tracks',
    attributes: {
      title: `Fixture ${position}`,
      ...(overrides.version ? { version: overrides.version } : {}),
      isrc: overrides.isrc ?? isrc(position),
      duration: `PT${Math.floor(seconds / 60)}M${seconds % 60}S`,
      popularity: 0.4,
      ...(overrides.streamable === false
        ? {}
        : { availability: ['STREAM', 'DJ'] }),
      externalLinks: [
        {
          href: `https://tidal.com/browse/track/${id}`,
          meta: { type: 'TIDAL_SHARING' },
        },
      ],
    },
    relationships: {
      albums: { data: [{ id: album, type: 'albums' }] },
    },
  }
}
const document = (tracks: unknown[], albums: unknown[], next?: string) => ({
  data: tracks,
  included: albums,
  links: { self: '/tracks?countryCode=AU', ...(next ? { next } : {}) },
})

const ambiguousNext = `/tracks?countryCode=AU&filter%5Bisrc%5D=${isrc(scenario.ambiguous)}&include=albums&page%5Bcursor%5D=fixture-cursor`
const documents = new Map<string, unknown[]>([
  [
    isrc(scenario.single),
    [
      document(
        [tidalTrack('900101', scenario.single, '910101')],
        [tidalAlbum('910101', 'Album fixture', tidalUpc)],
      ),
    ],
  ],
  [
    isrc(scenario.albumUpc),
    [
      document(
        [
          tidalTrack('900201', scenario.albumUpc, '910201'),
          tidalTrack('900202', scenario.albumUpc, '910202'),
        ],
        [
          tidalAlbum('910201', 'Compilation fixture', '000000000099'),
          tidalAlbum('910202', 'Album fixture', tidalUpc),
        ],
      ),
    ],
  ],
  [
    isrc(scenario.duration),
    [
      document(
        [
          tidalTrack('900301', scenario.duration, '910301', {
            durationSec: libraryDuration(scenario.duration) + 4,
          }),
          tidalTrack('900302', scenario.duration, '910302', {
            durationSec: libraryDuration(scenario.duration) + 1,
          }),
        ],
        [
          tidalAlbum('910301', 'Single fixture', '000000000301', 'SINGLE'),
          tidalAlbum('910302', 'EP fixture', '000000000302', 'EP'),
        ],
      ),
    ],
  ],
  [
    isrc(scenario.ambiguous),
    [
      document(
        [
          tidalTrack('900401', scenario.ambiguous, '910401'),
          tidalTrack('900402', scenario.ambiguous, '910402'),
        ],
        [
          tidalAlbum('910401', 'Compilation fixture', '000000000401'),
          tidalAlbum('910402', 'Other compilation fixture', '000000000402'),
        ],
        ambiguousNext,
      ),
      document(
        [
          tidalTrack('900403', scenario.ambiguous, '910403'),
          // Another recording TIDAL returned on the same page is left out.
          tidalTrack('900404', scenario.ambiguous, '910403', {
            isrc: isrc(99),
          }),
        ],
        [tidalAlbum('910403', 'Third compilation fixture', '000000000403')],
      ),
    ],
  ],
  [isrc(scenario.none), [document([], [])]],
])
const tokenResponse = {
  access_token: 'offline-fixture-token',
  expires_in: 14400,
  scope: '',
  token_type: 'Bearer',
}

/** Answers TIDAL requests offline; a request for `limitedIsrc` gets a 429. */
function mockTidal(limitedIsrc?: string) {
  request.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === 'https://auth.tidal.com/v1/oauth2/token')
      return Response.json(tokenResponse)
    if (url.pathname !== '/v2/tracks') throw new Error('Unexpected request')
    const code = url.searchParams.get('filter[isrc]') ?? ''
    if (code === limitedIsrc)
      return Response.json(
        { errors: [{ status: '429', detail: 'Too many requests' }] },
        { status: 429, headers: { 'retry-after': '60' } },
      )
    const pages = documents.get(code)
    const page = url.searchParams.get('page[cursor]') ? 1 : 0
    const body = pages?.[page]
    if (!body) throw new Error('Unexpected request')
    return Response.json(body)
  })
}

let tracks: { id: string; position: number }[] = []
const trackId = (position: number) => {
  const found = tracks.find((entry) => entry.position === position)
  if (!found) throw new Error('Missing library track')
  return found.id
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
  request.mockReset()
  mockTidal()
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values({
    id: albumId,
    slug: albumId,
    title: 'Album fixture',
    mediaType: 'album',
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: albumId })
  await databaseClient.transaction(async (tx) => {
    await replaceAlbumTracks(
      tx,
      albumId,
      Object.values(scenario).map((position) => ({
        title: `Fixture ${position}`,
        position,
        durationSec: libraryDuration(position),
      })),
    )
    await tx.insert(schema.providerReference).values({
      id: 'spotify-upc-fixture',
      mediaItemId: albumId,
      provider: 'spotify',
      referenceType: 'upc',
      externalId: libraryUpc,
    })
  })
  tracks = await databaseClient
    .select({
      id: schema.track.trackMediaItemId,
      position: schema.track.position,
    })
    .from(schema.track)
    .where(eq(schema.track.albumMediaItemId, albumId))
  for (const position of Object.values(scenario))
    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc: isrc(position) })
      .where(eq(schema.libraryTrack.mediaItemId, trackId(position)))
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

/** Matches one track in the request and reads its record. */
async function match(position: number) {
  const result = await matchTidalTracks(
    { trackIds: [trackId(position)] },
    userId,
  )
  expect(result).toMatchObject({ skipped: 0, notRun: 0 })
  const review = await getTidalTrackMatch(trackId(position))
  expect(result.items).toEqual([review])
  if (!review.job) throw new Error('Missing job')
  const job = await getJob(review.job.jobId)
  if (!job) throw new Error('Missing job')
  return { review, job }
}

const tidalJobs = () =>
  databaseClient
    .select({ id: schema.scrapeJob.id, status: schema.scrapeJob.status })
    .from(schema.scrapeJob)
    .where(eq(schema.scrapeJob.provider, 'tidal'))

const references = (position: number, referenceType: string) =>
  databaseClient
    .select()
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.mediaItemId, trackId(position)),
        eq(schema.providerReference.provider, 'tidal'),
        eq(schema.providerReference.referenceType, referenceType),
      ),
    )
    .orderBy(asc(schema.providerReference.externalId))

describe('TIDAL track match in the request, with offline HTTP', () => {
  it('matches the only track with the ISRC and keeps its responses', async () => {
    const { review, job } = await match(scenario.single)
    expect(job.status).toBe('succeeded')
    expect(job.scope).toEqual({
      mediaType: 'track',
      mediaItemIds: [trackId(scenario.single)],
      limit: 1,
    })
    expect(review.match).toEqual({
      tidalTrackId: '900101',
      url: 'https://tidal.com/browse/track/900101',
      version: null,
      durationSec: libraryDuration(scenario.single),
      popularity: 0.4,
      source: 'tidal-track-match',
      matchReason: 'single',
      alignment: null,
    })
    expect(review.job).toMatchObject({
      status: 'succeeded',
      isrc: isrc(scenario.single),
      reason: 'single',
      acceptedTidalTrackId: '900101',
      candidateCount: 1,
    })
    expect(review.candidates.map((entry) => entry.tidalTrackId)).toEqual([
      '900101',
    ])
    expect(await references(scenario.single, 'track')).toEqual([
      expect.objectContaining({
        externalId: '900101',
        isPrimary: true,
        metadata: {
          url: 'https://tidal.com/browse/track/900101',
          version: null,
          durationSec: libraryDuration(scenario.single),
          popularity: 0.4,
          source: 'tidal-track-match',
          jobId: job.id,
          matchReason: 'single',
          recordedAt: expect.any(String),
        },
      }),
    ])
    expect(await references(scenario.single, 'isrc')).toEqual([
      expect.objectContaining({
        externalId: isrc(scenario.single),
        metadata: expect.objectContaining({
          source: 'tidal-track-match',
          jobId: job.id,
        }),
      }),
    ])

    const responses = await readProviderResponseAttempt({
      jobId: job.id,
      attempt: 1,
    })
    expect(responses.map(({ capture }) => capture.request.url)).toEqual([
      'https://openapi.tidal.com/v2/tracks',
    ])
    expect(JSON.stringify(responses)).not.toMatch(
      /offline-fixture-(secret|token)/,
    )
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toHaveLength(request.mock.calls.length)
    const [saved] = await databaseClient
      .select({ options: schema.scrapeJob.options })
      .from(schema.scrapeJob)
      .where(eq(schema.scrapeJob.id, job.id))
    const steps = ProviderTaskReplayStepsSchema.parse(
      saved?.options.providerReplaySteps,
    )
    const calls = request.mock.calls.length
    expect(
      await replayProviderTask(
        TIDAL_TRACK_MATCH_TASK,
        'tidal',
        steps,
        responses.map(({ capture }) => capture),
      ),
    ).toEqual([
      [expect.objectContaining({ tidalTrackId: '900101', streamable: true })],
    ])
    expect(request).toHaveBeenCalledTimes(calls)
  }, 30_000)

  it('chooses the track on the library album by its UPC', async () => {
    const { review } = await match(scenario.albumUpc)
    expect(review.job).toMatchObject({
      reason: 'album-upc',
      acceptedTidalTrackId: '900202',
    })
    expect(await references(scenario.albumUpc, 'track')).toEqual([
      expect.objectContaining({
        externalId: '900202',
        metadata: expect.objectContaining({ matchReason: 'album-upc' }),
      }),
    ])
  }, 30_000)

  it('chooses the track nearest the library duration', async () => {
    const { review } = await match(scenario.duration)
    expect(review.job).toMatchObject({
      reason: 'duration',
      acceptedTidalTrackId: '900302',
    })
    expect(
      (await references(scenario.duration, 'track')).map(
        (row) => row.externalId,
      ),
    ).toEqual(['900302'])
  }, 30_000)

  it('leaves identical tracks for review and writes the one chosen', async () => {
    const { review, job } = await match(scenario.ambiguous)
    expect(job.status).toBe('succeeded')
    expect(review.job).toMatchObject({
      reason: 'ambiguous',
      acceptedTidalTrackId: null,
      candidateCount: 3,
    })
    expect(review.candidates.map((entry) => entry.tidalTrackId)).toEqual([
      '900401',
      '900402',
      '900403',
    ])
    expect(review.candidates[2]?.albums).toEqual([
      {
        tidalAlbumId: '910403',
        title: 'Third compilation fixture',
        albumType: 'ALBUM',
        barcodeId: '000000000403',
        releaseDate: '2020-01-01',
      },
    ])
    expect(await references(scenario.ambiguous, 'track')).toEqual([])
    const responses = await readProviderResponseAttempt({
      jobId: job.id,
      attempt: 1,
    })
    expect(responses).toHaveLength(2)

    const statuses = await listTidalTrackMatchStatuses({
      trackIds: [trackId(scenario.ambiguous), trackId(scenario.none)],
    })
    expect(statuses.items).toEqual([
      expect.objectContaining({
        trackId: trackId(scenario.ambiguous),
        job: expect.objectContaining({ reason: 'ambiguous' }),
        candidates: [],
      }),
      {
        trackId: trackId(scenario.none),
        match: null,
        job: null,
        candidates: [],
      },
    ])

    await expect(
      acceptTidalTrackMatch({
        trackId: trackId(scenario.ambiguous),
        jobId: job.id,
        tidalTrackId: '900404',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      acceptTidalTrackMatch({
        trackId: trackId(scenario.single),
        jobId: job.id,
        tidalTrackId: '900402',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(await references(scenario.ambiguous, 'track')).toEqual([])

    const accepted = await acceptTidalTrackMatch({
      trackId: trackId(scenario.ambiguous),
      jobId: job.id,
      tidalTrackId: '900402',
    })
    expect(accepted.job).toMatchObject({
      reason: 'ambiguous',
      acceptedTidalTrackId: '900402',
    })
    expect(accepted.match).toMatchObject({
      tidalTrackId: '900402',
      source: 'tidal-track-match',
      matchReason: 'manual',
    })
    expect(accepted.candidates.map((entry) => entry.tidalTrackId)).toEqual([
      '900402',
    ])
    expect(await references(scenario.ambiguous, 'track')).toEqual([
      expect.objectContaining({
        externalId: '900402',
        metadata: expect.objectContaining({
          source: 'tidal-track-match',
          jobId: job.id,
          matchReason: 'manual',
        }),
      }),
    ])
    expect(await references(scenario.ambiguous, 'isrc')).toEqual([
      expect.objectContaining({ externalId: isrc(scenario.ambiguous) }),
    ])

    // Choosing again replaces the earlier choice.
    await acceptTidalTrackMatch({
      trackId: trackId(scenario.ambiguous),
      jobId: job.id,
      tidalTrackId: '900403',
    })
    expect(
      (await references(scenario.ambiguous, 'track')).map(
        (row) => row.externalId,
      ),
    ).toEqual(['900403'])

    // A match running in another request blocks acceptance from this one.
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'running-match-fixture',
      provider: 'tidal',
      status: 'running',
      scope: { mediaItemIds: [trackId(scenario.ambiguous)], limit: 1 },
      options: {
        task: TIDAL_TRACK_MATCH_TASK,
        trackId: trackId(scenario.ambiguous),
      },
    })
    await expect(
      acceptTidalTrackMatch({
        trackId: trackId(scenario.ambiguous),
        jobId: job.id,
        tidalTrackId: '900401',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
  }, 30_000)

  it('ends as not found when TIDAL has no track with the ISRC', async () => {
    const { review, job } = await match(scenario.none)
    expect(job.status).toBe('failed')
    expect(job.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ classification: 'not-found' }),
        }),
      ]),
    )
    expect(review.candidates).toEqual([])
    expect(await references(scenario.none, 'track')).toEqual([])
    expect(
      await readProviderResponseAttempt({ jobId: job.id, attempt: 1 }),
    ).toHaveLength(1)
  }, 30_000)

  it('skips tracks without an ISRC', async () => {
    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc: null })
      .where(eq(schema.libraryTrack.mediaItemId, trackId(scenario.single)))
    expect(
      await matchTidalTracks(
        { trackIds: [trackId(scenario.single), 'missing-track'] },
        userId,
      ),
    ).toMatchObject({ items: [], skipped: 2, notRun: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('creates no queued job: the record is finished when the request returns', async () => {
    const result = await matchTidalTracks(
      { trackIds: [trackId(scenario.single), trackId(scenario.duration)] },
      userId,
    )
    expect(result.items.map((item) => item.match?.tidalTrackId)).toEqual([
      '900101',
      '900302',
    ])
    expect(await tidalJobs()).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({ status: 'succeeded' }),
    ])
    // Every TIDAL request, the token included, took a slot from the gate.
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toHaveLength(request.mock.calls.length)
    const events = await databaseClient
      .select({ requestedAt: schema.providerRequestEvent.requestedAt })
      .from(schema.providerRequestEvent)
      .orderBy(asc(schema.providerRequestEvent.requestedAt))
    for (const [index, event] of events.entries()) {
      const previous = events[index - 1]
      if (previous)
        expect(
          event.requestedAt.getTime() - previous.requestedAt.getTime(),
        ).toBeGreaterThanOrEqual(tidalPlugin.manifest.rateLimit.minTimeMs)
    }
  }, 30_000)

  it('runs a match queued before matching ran in the request', async () => {
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'queued-match-fixture',
      provider: 'tidal',
      status: 'queued',
      scope: { mediaItemIds: [trackId(scenario.single)], limit: 1 },
      options: {
        task: TIDAL_TRACK_MATCH_TASK,
        trackId: trackId(scenario.single),
        isrc: isrc(scenario.single),
        groupKey: createStableId(
          TIDAL_TRACK_MATCH_TASK,
          JSON.stringify([userId, trackId(scenario.single)]),
        ),
        trackTitle: 'Fixture 1',
      },
    })
    const { job } = await match(scenario.single)
    expect(job).toMatchObject({
      id: 'queued-match-fixture',
      status: 'succeeded',
    })
    expect(await tidalJobs()).toHaveLength(1)
  }, 30_000)

  it('refuses at a cooldown without a request or a record', async () => {
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'tidal',
      cooldownUntil: new Date(Date.now() + 120_000),
    })
    await expect(
      matchTidalTracks({ trackIds: [trackId(scenario.single)] }, userId),
    ).rejects.toMatchObject({
      response: {
        statusCode: 429,
        message: expect.stringMatching(
          /^TIDAL is rate limited\. Try again in 1[12]\d seconds\.$/,
        ),
      },
    })
    expect(request).not.toHaveBeenCalled()
    expect(await tidalJobs()).toEqual([])
  })

  it('waits a bounded time for a busy slot, then refuses', async () => {
    // Another request holds TIDAL's only slot for longer than a match waits.
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'tidal',
      leaseId: 'other-request',
      leaseUntil: new Date(Date.now() + 60_000),
    })
    const started = Date.now()
    await expect(
      matchTidalTracks({ trackIds: [trackId(scenario.single)] }, userId),
    ).rejects.toMatchObject({
      response: {
        statusCode: 429,
        message: expect.stringMatching(/^TIDAL is rate limited\. Try again/),
      },
    })
    const waited = Date.now() - started
    expect(waited).toBeLessThan(IN_REQUEST_SLOT_WAIT_MS + 5000)
    expect(request).not.toHaveBeenCalled()
    // The record keeps the refusal; the gate's state is unchanged.
    const [job] = await tidalJobs()
    expect(job?.status).toBe('failed')
    const [gate] = await databaseClient
      .select()
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'tidal'))
    expect(gate).toMatchObject({ failureCount: 0, cooldownUntil: null })
  }, 30_000)

  it('stops the rest of a batch when TIDAL answers 429', async () => {
    const limited = isrc(scenario.duration)
    mockTidal(limited)
    const result = await matchTidalTracks(
      {
        trackIds: [
          trackId(scenario.single),
          trackId(scenario.duration),
          trackId(scenario.albumUpc),
        ],
      },
      userId,
    )
    expect(result.items.map((item) => item.trackId)).toEqual([
      trackId(scenario.single),
    ])
    expect(result.notRun).toBe(2)
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^TIDAL is rate limited\. Try again in \d+ seconds\.$/,
      ),
    ])
    // The refused request is kept with its record like any other response.
    const jobs = await tidalJobs()
    const refused = jobs.find((job) => job.status === 'failed')
    if (!refused) throw new Error('Missing refused record')
    const responses = await readProviderResponseAttempt({
      jobId: refused.id,
      attempt: 1,
    })
    expect(responses.map(({ capture }) => capture.response.status)).toEqual([
      429,
    ])
    const [gate] = await databaseClient
      .select()
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'tidal'))
    expect(gate?.cooldownUntil?.getTime()).toBeGreaterThan(Date.now())
  }, 30_000)

  it('reports an album job reference as the current match, a track match first', async () => {
    const albumReference = (tidalTrackId: string, recordedAt: string) => ({
      id: `album-reference-${tidalTrackId}`,
      mediaItemId: trackId(scenario.none),
      provider: 'tidal',
      referenceType: 'track',
      externalId: tidalTrackId,
      isPrimary: true,
      metadata: {
        url: `https://tidal.com/browse/track/${tidalTrackId}`,
        version: null,
        durationSec: libraryDuration(scenario.none),
        popularity: 0.3,
        source: 'tidal-album',
        jobId: 'album-job-fixture',
        recordedAt,
        albumMediaItemId: albumId,
        tidalAlbumId: '910501',
        volumeNumber: 1,
        trackNumber: scenario.none,
        alignment: 'position-duration',
      },
    })
    await databaseClient
      .insert(schema.providerReference)
      .values([
        albumReference('900501', '2026-01-01T00:00:00.000Z'),
        albumReference('900502', '2026-02-01T00:00:00.000Z'),
      ])
    const expected = {
      tidalTrackId: '900502',
      url: 'https://tidal.com/browse/track/900502',
      version: null,
      durationSec: libraryDuration(scenario.none),
      popularity: 0.3,
      source: 'tidal-album',
      matchReason: null,
      alignment: 'position-duration',
    }
    const review = await getTidalTrackMatch(trackId(scenario.none))
    expect(review).toEqual({
      trackId: trackId(scenario.none),
      match: expected,
      job: null,
      candidates: [],
    })
    const { items } = await listTidalTrackMatchStatuses({
      trackIds: [trackId(scenario.none), trackId(scenario.single)],
    })
    expect(items.map((item) => item.match?.tidalTrackId ?? null)).toEqual([
      '900502',
      null,
    ])

    // A track match is preferred over a newer album alignment.
    const { job } = await match(scenario.single)
    await databaseClient.insert(schema.providerReference).values({
      ...albumReference('900199', '2099-01-01T00:00:00.000Z'),
      id: 'album-reference-single',
      mediaItemId: trackId(scenario.single),
    })
    expect(
      (await getTidalTrackMatch(trackId(scenario.single))).match,
    ).toMatchObject({
      tidalTrackId: '900101',
      source: 'tidal-track-match',
    })
    expect(job.status).toBe('succeeded')
  }, 30_000)

  it('filters and sorts Track Metadata by TIDAL match freshness', async () => {
    await match(scenario.single)
    await match(scenario.none)
    const view = (freshness: unknown[], sortBy = 'dateAdded') =>
      listTrackMatchDiagnostics(
        TrackMatchDiagnosticsQuerySchema.parse({
          view: 'spotify-search-metadata',
          playability: 'all',
          freshness: JSON.stringify(freshness),
          sortBy,
        }),
        userId,
      )
    const ids = async (freshness: unknown[], sortBy?: string) =>
      (await view(freshness, sortBy)).items.map((item) => item.id).sort()
    const others = [scenario.albumUpc, scenario.duration, scenario.ambiguous]
      .map(trackId)
      .sort()
    expect(await ids([{ provider: 'tidal', mode: 'never' }])).toEqual(others)
    expect(await ids([{ provider: 'tidal', mode: 'failed' }])).toEqual([
      trackId(scenario.none),
    ])
    expect(await ids([{ provider: 'tidal', mode: 'unscraped' }])).toEqual(
      [...others, trackId(scenario.none)].sort(),
    )
    expect(
      await ids([{ provider: 'tidal', mode: 'older', olderThanDays: 1 }]),
    ).toEqual([...others, trackId(scenario.none)].sort())
    // Every filtered provider must match: no Spotify search has run.
    expect(
      await ids([
        { provider: 'tidal', mode: 'failed' },
        { provider: 'spotify', mode: 'never' },
      ]),
    ).toEqual([trackId(scenario.none)])
    expect(
      await ids([
        { provider: 'tidal', mode: 'failed' },
        { provider: 'spotify', mode: 'failed' },
      ]),
    ).toEqual([])
    const sorted = await view([], 'tidalLastMatch')
    expect(sorted.items[0]?.id).toBe(trackId(scenario.single))
    expect(() =>
      TrackMatchDiagnosticsQuerySchema.parse({
        view: 'spotify-search-metadata',
        freshness: JSON.stringify([{ provider: 'discogs', mode: 'never' }]),
      }),
    ).toThrow()
  }, 60_000)
})
