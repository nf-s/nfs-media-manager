import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { z } from 'zod'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { SONOVAULT_TRACK_LOOKUP_TASK } from '@repo/schemas/sonovault'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import { sonovaultPlugin } from '@/plugins/builtin/sonovault'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import {
  sonovaultLinksFixture,
  sonovaultTrackFixture,
} from '@/plugins/builtin/__tests__/fixtures/sonovault'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `sonovault_candidates_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
const apiKey = 'offline-fixture-sonovault-key'
vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'sonovault'
      ? sonovaultPlugin
      : id === 'spotify'
        ? spotifyPlugin
        : null,
  listLoadedScrapePlugins: async () => [sonovaultPlugin, spotifyPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: (provider: string) =>
    provider === 'sonovault'
      ? { apiKey }
      : {
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
          market: 'AU',
        },
}))

import { processQueuedJobs } from '@/services/jobs'
import { spotifyTrackItemId } from '@/services/spotify-playlists'
import {
  acceptSonovaultTrackCandidate,
  getSonovaultCandidateReview,
  listSonovaultTrackNameLookupTargets,
  queueSonovaultTrackNameLookups,
  rejectSonovaultTrackCandidate,
} from '@/services/sonovault-track-candidates'
import {
  getSonovaultTrackState,
  removeSonovaultData,
} from '@/services/sonovault-track-lookup'

const userId = 'fixture-owner'
const artistName = 'Example Artist'

/** Library tracks with neither a Spotify ID nor an ISRC, unless noted. */
const tracks = {
  // Equal artist, title with version text and duration: automatic.
  automatic: {
    title: 'Night Signal (Extended Mix)',
    duration: 300,
    scrobbles: 50,
  },
  // No stored duration: never automatic, whatever the title.
  noDuration: { title: 'Harbour Lights', duration: null, scrobbles: 40 },
  // The search returns the original for an edit.
  version: { title: 'Glass Coast (Radio Edit)', duration: 200, scrobbles: 30 },
  miss: { title: 'Unlisted Song', duration: null, scrobbles: 20 },
  // Known only from scrobbles: a Spotify match moves it to a new recording.
  scrobbled: { title: 'Paper Moon', duration: null, scrobbles: 10 },
  // A Spotify ID: looked up by ID in stage 1, never by artist and title.
  identified: { title: 'Known Track', duration: 210, scrobbles: 90 },
} as const
type Key = keyof typeof tracks
const keys = Object.keys(tracks).filter((key): key is Key => key in tracks)
const trackId = (key: Key) => `track-${key}`
const sonovaultId = (key: Key) => 81000 + keys.indexOf(key)
const spotifyId = (key: Key) =>
  `FixtureSonoSpotify${String(keys.indexOf(key)).padStart(4, '0')}`

const catalog: Partial<Record<Key, { title: string; duration: number }>> = {
  automatic: { title: 'Night Signal - Extended Mix', duration: 302 },
  noDuration: { title: 'Harbour Lights', duration: 251 },
  version: { title: 'Glass Coast', duration: 260 },
  scrobbled: { title: 'Paper Moon', duration: 190 },
}

const BodySchema = z.object({
  input_type: z.string(),
  items: z.array(z.object({ artist: z.string(), title: z.string() })),
})
let bodies: z.infer<typeof BodySchema>[] = []

/** Spotify's listing of the recording, as the library names it. */
function catalogTrack(key: Key) {
  const track = tracks[key]
  return {
    type: 'track',
    id: spotifyId(key),
    name: track.title,
    duration_ms: (track.duration ?? catalog[key]?.duration ?? 200) * 1000,
    artists: [{ id: 'catalogartist000000000', name: artistName }],
    album: {
      id: 'catalogalbum0000000000',
      name: 'Fixture Release',
      images: [],
    },
    external_ids: { isrc: `QZSV${String(sonovaultId(key)).padStart(8, '0')}` },
  }
}

function mockProviders() {
  request.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === 'https://api.sonovault.now/v1/tracks/resolve') {
      const body = BodySchema.parse(JSON.parse(String(init?.body)))
      bodies.push(body)
      const results = body.items.map((item) => {
        const key = keys.find((name) => tracks[name].title === item.title)
        const entry = key ? catalog[key] : undefined
        return {
          // The bulk call echoes an artist-and-title line as an object.
          input: item,
          status: key && entry ? 'matched' : 'not_found',
          track:
            key && entry
              ? {
                  ...sonovaultTrackFixture(sonovaultId(key), entry),
                  artists: [
                    {
                      id: 7001,
                      name: artistName,
                      is_primary: true,
                      is_remixer: false,
                    },
                  ],
                }
              : null,
          links:
            key && entry
              ? sonovaultLinksFixture(sonovaultId(key), spotifyId(key))
              : [],
        }
      })
      return Response.json({
        results,
        partial: false,
        processed: results.length,
        credits_used: results.length,
        credits_remaining: 30000,
        message: null,
      })
    }
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    const match = /^\/v1\/tracks\/([A-Za-z0-9]{22})$/.exec(url.pathname)
    const key = keys.find((name) => spotifyId(name) === match?.[1])
    if (url.origin === 'https://api.spotify.com' && key)
      return Response.json(catalogTrack(key))
    throw new Error('Unexpected offline provider request')
  })
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture
    .insert(schema.user)
    .values({ id: userId, name: 'Fixture Owner', email: 'owner@example.test' })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  bodies = []
  request.mockReset()
  mockProviders()
  await fixture.delete(schema.scrapeJob)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.delete(schema.providerResponse)
  await fixture.delete(schema.providerRequestState)
  await fixture.delete(schema.providerRequestEvent)
  await fixture
    .insert(schema.artist)
    .values({ id: 'fixture-artist', name: artistName })
  for (const key of keys) {
    const track = tracks[key]
    const lastfm = key === 'scrobbled'
    await fixture.insert(schema.mediaItem).values({
      id: trackId(key),
      slug: lastfm ? slugifyParts(track.title, trackId(key)) : trackId(key),
      title: track.title,
      mediaType: 'track',
      sourceLabel: lastfm ? 'lastfm' : 'album',
    })
    await fixture.insert(schema.libraryTrack).values({
      mediaItemId: trackId(key),
      durationSec: track.duration,
      scrobbleCount: track.scrobbles,
      spotifyTrackId: key === 'identified' ? spotifyId(key) : null,
    })
    await fixture.insert(schema.mediaCredit).values({
      mediaItemId: trackId(key),
      artistId: 'fixture-artist',
      role: 'artist',
    })
  }
})

/** Runs queued jobs, waiting out the providers' request spacing. */
async function runQueued() {
  for (let round = 0; round < 20; round += 1) {
    const [queued] = await fixture
      .select({ id: schema.scrapeJob.id })
      .from(schema.scrapeJob)
      .where(eq(schema.scrapeJob.status, 'queued'))
      .limit(1)
    if (!queued) return
    const gates = await fixture
      .select({ nextAllowedAt: schema.providerRequestState.nextAllowedAt })
      .from(schema.providerRequestState)
    const wait =
      Math.max(0, ...gates.map((gate) => gate.nextAllowedAt?.getTime() ?? 0)) -
      Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 50))
    await processQueuedJobs()
  }
  throw new Error('Queued jobs did not finish')
}

async function lookUpAll() {
  const result = await queueSonovaultTrackNameLookups(
    { trackIds: keys.map(trackId), confirmBroadRun: true },
    userId,
  )
  await runQueued()
  return result
}

const jobs = async (task: string) =>
  (
    await fixture
      .select()
      .from(schema.scrapeJob)
      .orderBy(asc(schema.scrapeJob.createdAt), asc(schema.scrapeJob.id))
  ).filter((row) => row.options['task'] === task)

const libraryTrack = async (key: Key) => {
  const [row] = await fixture
    .select()
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, trackId(key)))
  return row
}

const references = (key: Key) =>
  fixture
    .select()
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.mediaItemId, trackId(key)),
        eq(schema.providerReference.provider, 'sonovault'),
      ),
    )

it('sends tracks with neither ID by artist and title and stores the response with its job', async () => {
  const result = await lookUpAll()
  expect(result).toMatchObject({ queued: 5, skipped: 1 })
  expect(await jobs(SONOVAULT_TRACK_LOOKUP_TASK)).toMatchObject([
    { status: 'succeeded' },
  ])
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.input_type).toBe('track_name')
  expect(bodies[0]?.items).toEqual(
    expect.arrayContaining(
      (
        ['automatic', 'noDuration', 'version', 'miss', 'scrobbled'] as const
      ).map((key) => ({
        artist: artistName,
        title: tracks[key].title,
      })),
    ),
  )
  expect(bodies[0]?.items).toHaveLength(5)
  const [job] = await jobs(SONOVAULT_TRACK_LOOKUP_TASK)
  expect(job).toMatchObject({
    status: 'succeeded',
    options: {
      inputType: 'track_name',
      candidates: 3,
      automatic: 1,
      notFound: 1,
      creditsRemaining: 30000,
    },
  })
  const responses = await fixture
    .select()
    .from(schema.providerResponse)
    .where(eq(schema.providerResponse.jobId, job?.id ?? ''))
  expect(responses).toMatchObject([
    { provider: 'sonovault', status: 200, bodyState: 'captured' },
  ])
})

it('accepts only an equal artist, title and duration automatically and takes its Spotify ID through the Spotify search', async () => {
  await lookUpAll()
  const automatic = await getSonovaultCandidateReview(trackId('automatic'))
  expect(automatic.candidates).toMatchObject([
    {
      sonovaultTrackId: String(sonovaultId('automatic')),
      status: 'accepted',
      acceptedBy: 'automatic',
      spotifyTrackId: spotifyId('automatic'),
    },
  ])
  // The Sonovault references and ISRC, as stage 1 records them.
  const state = await getSonovaultTrackState(trackId('automatic'))
  expect(state.lookup).toMatchObject({
    status: 'matched',
    inputType: 'track_name',
    verified: true,
    primaryIsrc: null,
  })
  expect(
    state.references.map(({ referenceType }) => referenceType).sort(),
  ).toEqual(
    [
      'isrc',
      'musicbrainz-recording',
      'sonovault-track',
      'spotify-track',
      'tidal-track',
    ].sort(),
  )
  // The Spotify job read that one track and matched it by its own rules.
  const [spotifyJob] = await jobs(SPOTIFY_TRACK_SEARCH_TASK)
  expect(spotifyJob).toMatchObject({
    status: 'succeeded',
    options: {
      trackId: trackId('automatic'),
      spotifyTrackId: spotifyId('automatic'),
      matchMethod: 'automatic',
      acceptedTrackId: trackId('automatic'),
    },
  })
  expect(automatic.candidates[0]?.spotifyJobId).toBe(spotifyJob?.id)
  expect(await libraryTrack('automatic')).toMatchObject({
    spotifyTrackId: spotifyId('automatic'),
  })
  // Nothing else was accepted.
  for (const key of ['noDuration', 'version'] as const) {
    expect(
      (await getSonovaultCandidateReview(trackId(key))).candidates,
    ).toMatchObject([{ status: 'pending', acceptedBy: null }])
    expect(await references(key)).toEqual([])
    expect(await libraryTrack(key)).toMatchObject({ spotifyTrackId: null })
  }
  expect(await getSonovaultCandidateReview(trackId('miss'))).toMatchObject({
    notFound: true,
    candidates: [],
  })
})

it('gives an accepted candidate its references, then its Spotify ID through the acceptance path', async () => {
  await lookUpAll()
  const result = await acceptSonovaultTrackCandidate({
    trackId: trackId('noDuration'),
    sonovaultTrackId: String(sonovaultId('noDuration')),
    userId,
  })
  expect(result).toMatchObject({
    spotifyWarning: null,
    review: {
      candidates: [
        {
          status: 'accepted',
          acceptedBy: 'owner',
          title: 'Harbour Lights',
          artists: [artistName],
          release: 'Fixture Release',
          durationSec: 251,
          isrc: `QZSV${String(sonovaultId('noDuration')).padStart(8, '0')}`,
        },
      ],
    },
  })
  expect(
    (await references('noDuration')).find(
      ({ referenceType }) => referenceType === 'sonovault-track',
    )?.metadata,
  ).toMatchObject({ verified: true, inputType: 'track_name' })
  // The Spotify ID is not taken before the Spotify job runs.
  expect(await libraryTrack('noDuration')).toMatchObject({
    spotifyTrackId: null,
  })
  await runQueued()
  const spotifyJob = (await jobs(SPOTIFY_TRACK_SEARCH_TASK)).find(
    (job) => job.options['trackId'] === trackId('noDuration'),
  )
  expect(spotifyJob).toMatchObject({
    status: 'succeeded',
    options: {
      reviewOnly: true,
      matchMethod: 'manual',
      acceptedSpotifyTrackId: spotifyId('noDuration'),
    },
  })
  expect(await libraryTrack('noDuration')).toMatchObject({
    spotifyTrackId: spotifyId('noDuration'),
  })
  await expect(
    acceptSonovaultTrackCandidate({
      trackId: trackId('noDuration'),
      sonovaultTrackId: String(sonovaultId('noDuration')),
      userId,
    }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
})

it('moves an accepted scrobbled track to its Spotify recording with its Sonovault references', async () => {
  await lookUpAll()
  await acceptSonovaultTrackCandidate({
    trackId: trackId('scrobbled'),
    sonovaultTrackId: String(sonovaultId('scrobbled')),
    userId,
  })
  expect(
    (await references('scrobbled')).map(({ referenceType }) => referenceType),
  ).toContain('sonovault-track')
  await runQueued()
  const recording = spotifyTrackItemId(spotifyId('scrobbled'))
  expect(
    await fixture
      .select({ id: schema.mediaItem.id })
      .from(schema.mediaItem)
      .where(eq(schema.mediaItem.id, trackId('scrobbled'))),
  ).toEqual([])
  const state = await getSonovaultTrackState(recording)
  expect(state.lookup).toMatchObject({
    status: 'matched',
    inputType: 'track_name',
    sonovaultTrackId: String(sonovaultId('scrobbled')),
  })
  expect(
    (await getSonovaultCandidateReview(recording)).candidates,
  ).toMatchObject([{ status: 'accepted', acceptedBy: 'owner' }])
})

it('does not offer a rejected candidate again', async () => {
  await lookUpAll()
  const review = await rejectSonovaultTrackCandidate({
    trackId: trackId('version'),
    sonovaultTrackId: String(sonovaultId('version')),
  })
  expect(review.candidates).toMatchObject([{ status: 'rejected' }])
  expect(await references('version')).toEqual([])
  bodies = []
  const again = await queueSonovaultTrackNameLookups(
    { trackIds: keys.map(trackId), confirmBroadRun: true },
    userId,
  )
  expect(again).toMatchObject({ queued: 0 })
  expect(bodies).toEqual([])
  expect(await listSonovaultTrackNameLookupTargets(10)).toEqual([])
})

it('lists the most scrobbled tracks with no identifier first', async () => {
  expect(await listSonovaultTrackNameLookupTargets(2)).toEqual([
    trackId('automatic'),
    trackId('noDuration'),
  ])
})

it('removes candidates with everything else Sonovault stored', async () => {
  await lookUpAll()
  await removeSonovaultData()
  expect(await fixture.select().from(schema.sonovaultTrackCandidate)).toEqual(
    [],
  )
})
