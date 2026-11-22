import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, asc, eq, sql } from 'drizzle-orm'
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
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { SONOVAULT_TRACK_LOOKUP_TASK } from '@repo/schemas/sonovault'
import { env } from '@/env'
import { sonovaultPlugin } from '@/plugins/builtin/sonovault'
import * as schema from '@/schemas/db'
import {
  sonovaultBulkFixture,
  sonovaultLinksFixture,
  sonovaultMatchedLine,
  sonovaultMissLine,
  sonovaultTrackFixture,
} from '@/plugins/builtin/__tests__/fixtures/sonovault'

const database = `sonovault_track_lookup_${randomUUID().replaceAll('-', '')}`
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
const secrets: Record<string, string> = {}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'sonovault' ? sonovaultPlugin : null,
  listLoadedScrapePlugins: async () => [sonovaultPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({ ...secrets }),
}))

import { getJob, processQueuedJobs } from '@/services/jobs'
import { readProviderResponseAttempt } from '@/services/provider-response-history'
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import { storeConfirmedRecording } from '@/services/spotify-track-recordings'
import { listTrackMatchDiagnostics } from '@/services/track-match-diagnostics'
import {
  getSonovaultSummary,
  getSonovaultTrackState,
  queueSonovaultTrackLookups,
  removeSonovaultData,
} from '@/services/sonovault-track-lookup'

const userId = 'fixture-owner'
const albumId = 'album-fixture'
const apiKey = 'offline-fixture-sonovault-key'
const libraryDuration = (position: number) => 180 + position * 10
const spotifyId = (position: number) =>
  `FixtureSpotifyTrack${String(position).padStart(3, '0')}`
const libraryIsrc = (position: number) =>
  `QZLB${String(position).padStart(8, '0')}`
const sonovaultIsrc = (position: number) =>
  `QZSV${String(position).padStart(8, '0')}`
const sonovaultId = (position: number) => 70000 + position

/** Each library track's identifiers before a lookup. */
const scenario = {
  // Spotify ID, no ISRC: a verified match fills the primary ISRC.
  fills: 1,
  // Spotify ID and an ISRC Spotify reported: kept.
  spotifyIsrc: 2,
  // Spotify ID; Sonovault's duration is 10 s longer: unverified.
  unverified: 3,
  // No Spotify ID; an ISRC another provider reported: looked up by ISRC.
  isrcOnly: 4,
  miss: 5,
  noCredits: 6,
  // Neither: never sent.
  none: 7,
} as const
const positions = Object.values(scenario)

type Line = ReturnType<typeof sonovaultMatchedLine>
/** What the mocked bulk call answers for each input. */
let catalog = new Map<string, Line>()
let bodies: { input_type: string; items: string[] }[] = []

function matched(
  position: number,
  input: string,
  overrides: { title?: string; duration?: number; isrc?: string } = {},
) {
  return sonovaultMatchedLine(
    input,
    sonovaultTrackFixture(sonovaultId(position), {
      title: overrides.title ?? `Fixture ${position}`,
      duration: overrides.duration ?? libraryDuration(position),
      isrc: overrides.isrc ?? sonovaultIsrc(position),
    }),
    sonovaultLinksFixture(sonovaultId(position), spotifyId(position)),
  )
}

function defaultCatalog() {
  return new Map<string, Line>([
    [
      spotifyId(scenario.fills),
      matched(scenario.fills, spotifyId(scenario.fills)),
    ],
    [
      spotifyId(scenario.spotifyIsrc),
      matched(scenario.spotifyIsrc, spotifyId(scenario.spotifyIsrc)),
    ],
    [
      spotifyId(scenario.unverified),
      matched(scenario.unverified, spotifyId(scenario.unverified), {
        duration: libraryDuration(scenario.unverified) + 10,
      }),
    ],
    [
      libraryIsrc(scenario.isrcOnly),
      matched(scenario.isrcOnly, libraryIsrc(scenario.isrcOnly), {
        isrc: libraryIsrc(scenario.isrcOnly),
      }),
    ],
    [
      spotifyId(scenario.noCredits),
      sonovaultMissLine(spotifyId(scenario.noCredits), 'skipped_no_credits'),
    ],
  ])
}

const BodySchema = z.object({
  input_type: z.string(),
  items: z.array(z.string()),
})

function mockSonovault() {
  request.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href !== 'https://api.sonovault.now/v1/tracks/resolve')
      throw new Error('Unexpected request')
    if (new Headers(init?.headers).get('x-api-key') !== apiKey)
      return Response.json({ message: 'Unauthorized' }, { status: 401 })
    const body = BodySchema.parse(JSON.parse(String(init?.body)))
    bodies.push(body)
    return Response.json(
      sonovaultBulkFixture(
        body.items.map((item) => catalog.get(item) ?? sonovaultMissLine(item)),
        41000,
      ),
      {
        headers: {
          'RateLimit-Limit': '60',
          'RateLimit-Remaining': '59',
          'RateLimit-Reset': '60',
        },
      },
    )
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
  for (const key of Object.keys(secrets)) delete secrets[key]
  secrets['apiKey'] = apiKey
  catalog = defaultCatalog()
  bodies = []
  request.mockReset()
  mockSonovault()
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
  await databaseClient.transaction((tx) =>
    replaceAlbumTracks(
      tx,
      albumId,
      positions.map((position) => ({
        title: `Fixture ${position}`,
        position,
        durationSec: libraryDuration(position),
      })),
    ),
  )
  tracks = await databaseClient
    .select({
      id: schema.track.trackMediaItemId,
      position: schema.track.position,
    })
    .from(schema.track)
    .where(eq(schema.track.albumMediaItemId, albumId))
  for (const position of positions) {
    const spotify = position === scenario.isrcOnly || position === scenario.none
    await databaseClient
      .update(schema.libraryTrack)
      .set({
        spotifyTrackId: spotify ? null : spotifyId(position),
        isrc: position === scenario.spotifyIsrc ? libraryIsrc(position) : null,
      })
      .where(eq(schema.libraryTrack.mediaItemId, trackId(position)))
  }
  await databaseClient.insert(schema.providerReference).values([
    {
      id: 'spotify-isrc-fixture',
      mediaItemId: trackId(scenario.spotifyIsrc),
      provider: 'spotify',
      referenceType: 'isrc',
      externalId: libraryIsrc(scenario.spotifyIsrc),
      metadata: { source: 'spotify-track-search' },
    },
    {
      id: 'tidal-isrc-fixture',
      mediaItemId: trackId(scenario.isrcOnly),
      provider: 'tidal',
      referenceType: 'isrc',
      externalId: libraryIsrc(scenario.isrcOnly),
      metadata: { source: 'tidal-track-match' },
    },
    {
      id: 'tidal-track-fixture',
      mediaItemId: trackId(scenario.fills),
      provider: 'tidal',
      referenceType: 'track',
      externalId: '880001',
      isPrimary: true,
      metadata: { source: 'tidal-track-match' },
    },
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

/** Runs queued Sonovault jobs, waiting out the request spacing between them. */
async function runQueued() {
  for (let round = 0; round < 20; round += 1) {
    const [queued] = await databaseClient
      .select({ id: schema.scrapeJob.id })
      .from(schema.scrapeJob)
      .where(eq(schema.scrapeJob.status, 'queued'))
      .limit(1)
    if (!queued) return
    const [gate] = await databaseClient
      .select({ nextAllowedAt: schema.providerRequestState.nextAllowedAt })
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'sonovault'))
    const wait = (gate?.nextAllowedAt?.getTime() ?? 0) - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 50))
    await processQueuedJobs()
  }
  throw new Error('Queued jobs did not finish')
}

async function lookUp(selected: number[]) {
  const result = await queueSonovaultTrackLookups(
    {
      trackIds: selected.map(trackId),
      confirmBroadRun: selected.length > 5,
    },
    userId,
  )
  await runQueued()
  return result
}

const jobs = () =>
  databaseClient
    .select()
    .from(schema.scrapeJob)
    .where(eq(schema.scrapeJob.provider, 'sonovault'))
    .orderBy(asc(schema.scrapeJob.createdAt), asc(schema.scrapeJob.id))

async function jobFor(position: number) {
  const id = trackId(position)
  const job = (await jobs()).find((row) => {
    const ids = row.options['trackIds']
    return Array.isArray(ids) && ids.includes(id)
  })
  if (!job) throw new Error('Missing job')
  return job
}

const references = (position: number, provider = 'sonovault') =>
  databaseClient
    .select()
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.mediaItemId, trackId(position)),
        eq(schema.providerReference.provider, provider),
      ),
    )
    .orderBy(
      asc(schema.providerReference.referenceType),
      asc(schema.providerReference.externalId),
    )

const trackFacts = (position: number) =>
  databaseClient
    .select({
      bpm: schema.trackFact.bpm,
      keyCamelot: schema.trackFact.keyCamelot,
      verified: schema.trackFact.verified,
    })
    .from(schema.trackFact)
    .where(eq(schema.trackFact.mediaItemId, trackId(position)))

async function primaryIsrc(position: number) {
  const [row] = await databaseClient
    .select({ isrc: schema.libraryTrack.isrc })
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, trackId(position)))
  return row?.isrc ?? null
}

async function lookupRow(position: number) {
  const [row] = await databaseClient
    .select()
    .from(schema.sonovaultTrackLookup)
    .where(eq(schema.sonovaultTrackLookup.mediaItemId, trackId(position)))
  return row ?? null
}

const sonovaultResponses = () =>
  databaseClient
    .select()
    .from(schema.providerResponse)
    .where(eq(schema.providerResponse.provider, 'sonovault'))

describe('Sonovault track lookup through the queue, with offline HTTP', () => {
  it('queues one job per input type and writes references from the stored response', async () => {
    const result = await lookUp(positions)
    expect(result).toMatchObject({ queued: 6, skipped: 1 })
    expect(request).toHaveBeenCalledTimes(2)
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          input_type: 'spotify_id',
          items: [
            scenario.fills,
            scenario.spotifyIsrc,
            scenario.unverified,
            scenario.miss,
            scenario.noCredits,
          ].map(spotifyId),
        },
        { input_type: 'isrc', items: [libraryIsrc(scenario.isrcOnly)] },
      ]),
    )

    const rows = await jobs()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.status).toBe('succeeded')
      expect(row.options['task']).toBe(SONOVAULT_TRACK_LOOKUP_TASK)
      const job = await getJob(row.id)
      expect(job?.scope).toMatchObject({
        mediaType: 'track',
        mediaItemIds: row.options['trackIds'],
      })
      expect(row.options).toMatchObject({
        creditsRemaining: 41000,
        creditsReportedAt: expect.any(String),
      })
    }

    const spotifyJob = await jobFor(scenario.fills)
    const captures = await readProviderResponseAttempt({
      jobId: spotifyJob.id,
      attempt: 1,
    })
    expect(captures.map(({ capture }) => capture.request.url)).toEqual([
      'https://api.sonovault.now/v1/tracks/resolve',
    ])
    expect(JSON.stringify(captures)).not.toContain(apiKey)
    const [stored] = await databaseClient
      .select()
      .from(schema.providerResponse)
      .where(eq(schema.providerResponse.jobId, spotifyJob.id))
    if (!stored) throw new Error('Missing stored response')
    expect(stored).toMatchObject({
      provider: 'sonovault',
      status: 200,
      bodyState: 'captured',
    })

    const fills = await references(scenario.fills)
    expect(fills.map((row) => [row.referenceType, row.externalId])).toEqual([
      ['isrc', sonovaultIsrc(scenario.fills)],
      [
        'musicbrainz-recording',
        `00000000-0000-4000-8000-${String(sonovaultId(scenario.fills)).padStart(12, '0')}`,
      ],
      ['sonovault-track', String(sonovaultId(scenario.fills))],
      ['spotify-track', spotifyId(scenario.fills)],
      ['tidal-track', `55${sonovaultId(scenario.fills)}`],
    ])
    for (const row of fills.filter((entry) => entry.referenceType !== 'isrc'))
      expect(row.metadata).toMatchObject({
        verified: true,
        fetchedAt: stored.receivedAt?.toISOString(),
        responseId: stored.id,
        jobId: spotifyJob.id,
        inputType: 'spotify_id',
      })
    expect(
      fills.find((row) => row.referenceType === 'sonovault-track'),
    ).toMatchObject({
      isPrimary: true,
      metadata: {
        url: null,
        isrc: sonovaultIsrc(scenario.fills),
        title: `Fixture ${scenario.fills}`,
        durationSec: libraryDuration(scenario.fills),
      },
    })
    expect(
      fills.find((row) => row.referenceType === 'tidal-track')?.metadata,
    ).toMatchObject({
      url: `https://tidal.com/browse/track/55${sonovaultId(scenario.fills)}`,
    })
    expect(
      fills.find((row) => row.referenceType === 'isrc')?.metadata,
    ).toMatchObject({
      source: SONOVAULT_TRACK_LOOKUP_TASK,
      jobId: spotifyJob.id,
      responseId: stored.id,
    })

    // SONO-07: a verified Spotify-ID lookup fills an empty primary ISRC.
    expect(await primaryIsrc(scenario.fills)).toBe(
      sonovaultIsrc(scenario.fills),
    )
    expect(await lookupRow(scenario.fills)).toMatchObject({
      status: 'matched',
      inputType: 'spotify_id',
      sonovaultTrackId: String(sonovaultId(scenario.fills)),
      verified: true,
      primaryIsrc: sonovaultIsrc(scenario.fills),
      scrapeJobId: spotifyJob.id,
      responseId: stored.id,
    })

    // An ISRC Spotify reported is never replaced.
    expect(await primaryIsrc(scenario.spotifyIsrc)).toBe(
      libraryIsrc(scenario.spotifyIsrc),
    )
    expect(await lookupRow(scenario.spotifyIsrc)).toMatchObject({
      verified: true,
      primaryIsrc: null,
    })
    expect(
      (await references(scenario.spotifyIsrc)).find(
        (row) => row.referenceType === 'isrc',
      )?.externalId,
    ).toBe(sonovaultIsrc(scenario.spotifyIsrc))

    // SONO-08: an unverified record is kept unverified, without its ISRC.
    const unverified = await references(scenario.unverified)
    expect(unverified.length).toBeGreaterThan(0)
    expect(unverified.map((row) => row.referenceType)).not.toContain('isrc')
    for (const row of unverified)
      expect(row.metadata).toMatchObject({ verified: false })
    expect(
      unverified.find((row) => row.referenceType === 'sonovault-track')
        ?.metadata,
    ).toMatchObject({ isrc: sonovaultIsrc(scenario.unverified) })
    expect(await primaryIsrc(scenario.unverified)).toBe(null)
    // SONO-13, SONO-17: tempo and key are stored, marked as the record is.
    expect(await trackFacts(scenario.unverified)).toEqual([
      { bpm: 124, keyCamelot: '8A', verified: false },
    ])
    expect(await trackFacts(scenario.fills)).toEqual([
      { bpm: 124, keyCamelot: '8A', verified: true },
    ])
    expect(await trackFacts(scenario.miss)).toEqual([])
    expect(await lookupRow(scenario.unverified)).toMatchObject({
      verified: false,
      primaryIsrc: null,
    })

    // A lookup by ISRC never fills the primary ISRC.
    const isrcJob = await jobFor(scenario.isrcOnly)
    expect(isrcJob.id).not.toBe(spotifyJob.id)
    expect(await lookupRow(scenario.isrcOnly)).toMatchObject({
      inputType: 'isrc',
      verified: true,
      primaryIsrc: null,
    })
    expect(await primaryIsrc(scenario.isrcOnly)).toBe(null)
    expect(
      (await references(scenario.isrcOnly)).find(
        (row) => row.referenceType === 'sonovault-track',
      )?.metadata,
    ).toMatchObject({ inputType: 'isrc', jobId: isrcJob.id })

    // A miss is recorded; a line skipped for credits writes nothing.
    expect(await lookupRow(scenario.miss)).toMatchObject({
      status: 'not_found',
      sonovaultTrackId: null,
      verified: null,
    })
    expect(await references(scenario.miss)).toEqual([])
    expect(await lookupRow(scenario.noCredits)).toBe(null)
    expect(await references(scenario.noCredits)).toEqual([])
    expect(await lookupRow(scenario.none)).toBe(null)

    // References from other providers are untouched (SONO-06).
    expect(await references(scenario.fills, 'tidal')).toEqual([
      expect.objectContaining({
        id: 'tidal-track-fixture',
        externalId: '880001',
      }),
    ])
    expect(await references(scenario.spotifyIsrc, 'spotify')).toEqual([
      expect.objectContaining({ id: 'spotify-isrc-fixture' }),
    ])
    expect(await references(scenario.isrcOnly, 'tidal')).toEqual([
      expect.objectContaining({ id: 'tidal-isrc-fixture' }),
    ])
    const [library] = await databaseClient
      .select({ spotifyTrackId: schema.libraryTrack.spotifyTrackId })
      .from(schema.libraryTrack)
      .where(eq(schema.libraryTrack.mediaItemId, trackId(scenario.fills)))
    expect(library?.spotifyTrackId).toBe(spotifyId(scenario.fills))

    const state = await getSonovaultTrackState(trackId(scenario.fills))
    expect(state.lookup).toMatchObject({ status: 'matched', verified: true })
    expect(state.references.map((row) => row.referenceType)).toContain(
      'sonovault-track',
    )
    const summary = await getSonovaultSummary()
    expect(summary).toMatchObject({
      lookups: { matched: 4, verified: 3, notFound: 1, dueForRefresh: 0 },
      primaryIsrcs: 1,
      responses: 2,
      credits: { remaining: 41000, reserve: 2000 },
    })
  }, 60_000)

  it('marks a record of another version unverified', async () => {
    catalog.set(
      spotifyId(scenario.fills),
      matched(scenario.fills, spotifyId(scenario.fills), {
        title: `Fixture ${scenario.fills} (Radio Edit)`,
      }),
    )
    await lookUp([scenario.fills])
    expect(await lookupRow(scenario.fills)).toMatchObject({ verified: false })
    const rows = await references(scenario.fills)
    expect(rows.map((row) => row.referenceType)).not.toContain('isrc')
    for (const row of rows)
      expect(row.metadata).toMatchObject({ verified: false })
    expect(await primaryIsrc(scenario.fills)).toBe(null)
  }, 30_000)

  it('lets a later Spotify ISRC replace the primary ISRC Sonovault gave', async () => {
    await lookUp([scenario.fills])
    expect(await primaryIsrc(scenario.fills)).toBe(
      sonovaultIsrc(scenario.fills),
    )
    await databaseClient.transaction((tx) =>
      storeConfirmedRecording(
        tx,
        trackId(scenario.fills),
        {
          spotifyTrackId: spotifyId(scenario.fills),
          title: `Fixture ${scenario.fills}`,
          artists: ['Fixture Artist'],
          artistCredits: [],
          albumName: null,
          spotifyAlbumId: null,
          durationSec: libraryDuration(scenario.fills),
          isrc: libraryIsrc(scenario.fills),
          artworkUrl: null,
          spotifyUrl: `https://open.spotify.com/track/${spotifyId(scenario.fills)}`,
        },
        { jobId: 'spotify-job-fixture', matchMethod: 'manual' },
      ),
    )
    expect(await primaryIsrc(scenario.fills)).toBe(libraryIsrc(scenario.fills))

    // A Spotify ISRC is not replaced by a Sonovault refresh.
    await databaseClient
      .update(schema.sonovaultTrackLookup)
      .set({ lookedUpAt: new Date(Date.now() - 365 * 86_400_000) })
    await queueSonovaultTrackLookups(
      { trackIds: [trackId(scenario.fills)], refresh: true },
      userId,
    )
    await runQueued()
    expect(request).toHaveBeenCalledTimes(2)
    expect(await primaryIsrc(scenario.fills)).toBe(libraryIsrc(scenario.fills))
    expect(await lookupRow(scenario.fills)).toMatchObject({ primaryIsrc: null })
  }, 30_000)

  it('keeps the primary ISRC when Spotify reports the one Sonovault gave', async () => {
    await lookUp([scenario.fills])
    await databaseClient.transaction((tx) =>
      storeConfirmedRecording(
        tx,
        trackId(scenario.fills),
        {
          spotifyTrackId: spotifyId(scenario.fills),
          title: `Fixture ${scenario.fills}`,
          artists: ['Fixture Artist'],
          artistCredits: [],
          albumName: null,
          spotifyAlbumId: null,
          durationSec: libraryDuration(scenario.fills),
          isrc: sonovaultIsrc(scenario.fills),
          artworkUrl: null,
          spotifyUrl: `https://open.spotify.com/track/${spotifyId(scenario.fills)}`,
        },
        { jobId: 'spotify-job-fixture', matchMethod: 'manual' },
      ),
    )
    expect(await primaryIsrc(scenario.fills)).toBe(
      sonovaultIsrc(scenario.fills),
    )
    // The value is now Spotify's too, so removing Sonovault's data keeps it.
    await removeSonovaultData()
    expect(await primaryIsrc(scenario.fills)).toBe(
      sonovaultIsrc(scenario.fills),
    )
  }, 30_000)

  it('does not repeat a miss for 30 days', async () => {
    await lookUp([scenario.miss])
    expect(request).toHaveBeenCalledTimes(1)
    expect(
      await queueSonovaultTrackLookups(
        { trackIds: [trackId(scenario.miss)] },
        userId,
      ),
    ).toMatchObject({ queued: 0, skipped: 1 })
    await databaseClient
      .update(schema.sonovaultTrackLookup)
      .set({ lookedUpAt: new Date(Date.now() - 29 * 86_400_000) })
      .where(
        eq(schema.sonovaultTrackLookup.mediaItemId, trackId(scenario.miss)),
      )
    expect(
      await queueSonovaultTrackLookups(
        { trackIds: [trackId(scenario.miss)] },
        userId,
      ),
    ).toMatchObject({ queued: 0 })
    await databaseClient
      .update(schema.sonovaultTrackLookup)
      .set({ lookedUpAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(
        eq(schema.sonovaultTrackLookup.mediaItemId, trackId(scenario.miss)),
      )
    expect(
      await queueSonovaultTrackLookups(
        { trackIds: [trackId(scenario.miss)] },
        userId,
      ),
    ).toMatchObject({ queued: 1, skipped: 0 })
    await runQueued()
    expect(request).toHaveBeenCalledTimes(2)
    // A matched track is not looked up again without a refresh.
    await lookUp([scenario.fills])
    expect(
      await queueSonovaultTrackLookups(
        { trackIds: [trackId(scenario.fills)] },
        userId,
      ),
    ).toMatchObject({ queued: 0 })
  }, 30_000)

  it('stops before the credit reserve without a request', async () => {
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'previous-sonovault-job',
      provider: 'sonovault',
      status: 'succeeded',
      scope: { mediaType: 'track', mediaItemIds: [] },
      options: {
        task: SONOVAULT_TRACK_LOOKUP_TASK,
        trackIds: [],
        inputType: 'spotify_id',
        creditsRemaining: 2001,
        creditsReportedAt: new Date().toISOString(),
      },
    })
    await lookUp([scenario.fills, scenario.unverified])
    expect(request).not.toHaveBeenCalled()
    const job = await jobFor(scenario.fills)
    expect(job.status).toBe('succeeded')
    expect(job.options).toMatchObject({
      lookedUp: 0,
      creditReserveReached: true,
    })
    expect(await lookupRow(scenario.fills)).toBe(null)

    // A lower reserve lets the same batch run.
    secrets['creditReserve'] = '1999'
    await lookUp([scenario.fills, scenario.unverified])
    expect(request).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('starts a cooldown for the seconds in RateLimit-Reset on a 429', async () => {
    request.mockImplementation(async () =>
      Response.json(
        { message: 'Too many requests' },
        {
          status: 429,
          headers: {
            'RateLimit-Limit': '60',
            'RateLimit-Remaining': '0',
            'RateLimit-Reset': '7',
          },
        },
      ),
    )
    await queueSonovaultTrackLookups(
      { trackIds: [trackId(scenario.fills)] },
      userId,
    )
    const before = Date.now()
    await processQueuedJobs()
    const after = Date.now()
    expect(request).toHaveBeenCalledTimes(1)
    const [state] = await databaseClient
      .select()
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'sonovault'))
    const cooldown = state?.cooldownUntil?.getTime() ?? 0
    expect(cooldown).toBeGreaterThanOrEqual(before + 7000 - 1000)
    expect(cooldown).toBeLessThanOrEqual(after + 7000 + 1000)
    expect(await lookupRow(scenario.fills)).toBe(null)
  }, 30_000)

  it('removes only what Sonovault stored', async () => {
    await lookUp(positions)
    expect((await sonovaultResponses()).length).toBe(2)
    const removal = await removeSonovaultData()
    expect(removal).toEqual({
      references: expect.any(Number),
      lookups: 5,
      primaryIsrcs: 1,
      responses: 2,
      trackFacts: expect.any(Number),
    })
    expect(removal.references).toBeGreaterThan(0)
    expect(removal.trackFacts).toBeGreaterThan(0)
    expect(await databaseClient.select().from(schema.trackFact)).toEqual([])
    expect(await primaryIsrc(scenario.fills)).toBe(null)
    expect(await primaryIsrc(scenario.spotifyIsrc)).toBe(
      libraryIsrc(scenario.spotifyIsrc),
    )
    const [left] = await databaseClient
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.providerReference)
      .where(eq(schema.providerReference.provider, 'sonovault'))
    expect(left?.count).toBe(0)
    expect(
      await databaseClient.select().from(schema.sonovaultTrackLookup),
    ).toEqual([])
    expect(await sonovaultResponses()).toEqual([])
    expect(
      (
        await databaseClient
          .select({ id: schema.providerReference.id })
          .from(schema.providerReference)
          .orderBy(asc(schema.providerReference.id))
      ).map((row) => row.id),
    ).toEqual([
      'spotify-isrc-fixture',
      'tidal-isrc-fixture',
      'tidal-track-fixture',
    ])
    // Jobs are kept with their counts.
    expect(await jobs()).toHaveLength(2)
  }, 60_000)

  it('filters and sorts Track Metadata by Sonovault lookup freshness', async () => {
    await lookUp([scenario.fills, scenario.miss])
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
    const lookedUp = [scenario.fills, scenario.miss].map(trackId)
    const others = positions
      .map(trackId)
      .filter((id) => !lookedUp.includes(id))
      .sort()
    expect(await ids([{ provider: 'sonovault', mode: 'unscraped' }])).toEqual(
      others,
    )
    expect(await ids([{ provider: 'sonovault', mode: 'never' }])).toEqual(
      others,
    )
    expect(
      await ids([{ provider: 'sonovault', mode: 'older', olderThanDays: 1 }]),
    ).toEqual(others)
    const sorted = await view([], 'sonovaultLastLookup')
    expect(
      sorted.items
        .slice(0, 2)
        .map((item) => item.id)
        .sort(),
    ).toEqual([...lookedUp].sort())
  }, 60_000)
})
