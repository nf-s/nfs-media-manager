import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
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
import { SONOVAULT_ALBUM_LOOKUP_TASK } from '@repo/schemas/sonovault-album'
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
import { sonovaultReleaseFixture } from '@/plugins/builtin/__tests__/fixtures/sonovault/releases'

const database = `sonovault_album_lookup_${randomUUID().replaceAll('-', '')}`
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
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import { listUnresolvedMatches } from '@/services/find-match'
import { listCloudQueuedJobIds } from '@/services/cloud-job-store'
import {
  getSonovaultAlbumState,
  getSonovaultAlbumSummary,
  listSonovaultAlbumReview,
  queueSonovaultAlbumLookups,
  queueSonovaultRefresh,
} from '@/services/sonovault-album-lookup'
import { backfillSonovaultTrackRecords } from '@/services/sonovault-track-records'
import {
  getSonovaultSummary,
  queueSonovaultTrackLookups,
  removeSonovaultData,
} from '@/services/sonovault-track-lookup'

const userId = 'fixture-owner'
const albumId = 'album-fixture'
const apiKey = 'offline-fixture-sonovault-key'
const spotifyAlbum = 'FixtureSpotifyAlbum001'
const releaseGroup = '00000000-0000-4000-8000-00000000a001'
const otherGroup = '00000000-0000-4000-8000-00000000a009'
const libraryDuration = (position: number) => 180 + position * 10
const spotifyId = (position: number) =>
  `FixtureSpotifyTrack${String(position).padStart(3, '0')}`
const releaseIsrc = (position: number) =>
  `QZSR${String(position).padStart(8, '0')}`
const recordId = (position: number) => 70000 + position
const positions = [1, 2, 3, 4]

/** A compilation the seed track is also on: no identifier of the album. */
const compilation = sonovaultReleaseFixture({
  id: 8101,
  tracks: [{ id: recordId(1), title: 'Fixture 1', duration: 190, number: 7 }],
  editions: [
    { id: 401, source: 'spotify', externalId: 'FixtureCompilation001' },
  ],
  digitalUpc: '999999999999',
})

/** The album's release: every edition merged, a bonus track among them. */
function albumRelease(edition: number | null) {
  const numbered = edition === 501
  return sonovaultReleaseFixture({
    id: 8102,
    edition,
    tracks: [
      ...positions.map((position) => ({
        id: recordId(position),
        title: `Fixture ${position}`,
        // Track 4 is listed at another version's length.
        duration: libraryDuration(position) + (position === 4 ? 30 : 0),
        isrc: releaseIsrc(position),
        number: numbered ? position : position === 1 ? 1 : null,
      })),
      { id: 79999, title: 'Bonus', duration: 100, number: numbered ? null : 2 },
    ],
    editions: [
      {
        id: 501,
        source: 'spotify',
        externalId: spotifyAlbum,
        catalogNo: 'FIX-501',
      },
      {
        id: 502,
        source: 'discogs',
        externalId: '7002',
        groupId: '222',
        barcode: '123456789012',
      },
      {
        id: 503,
        source: 'musicbrainz',
        externalId: '00000000-0000-4000-8000-00000000b001',
        groupId: releaseGroup,
      },
    ],
    digitalUpc: '123456789012',
    releaseGroups: [releaseGroup],
  })
}

let releaseOnTrack: number[] = [8101, 8102]
let bodies: { input_type: string; items: string[] }[] = []
const requested = () =>
  request.mock.calls.map(([input]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return `${url.pathname}${url.search}`
  })

const BodySchema = z.object({
  input_type: z.string(),
  items: z.array(z.string()),
})

function mockSonovault() {
  request.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (new Headers(init?.headers).get('x-api-key') !== apiKey)
      return Response.json({ message: 'Unauthorized' }, { status: 401 })
    if (url.pathname === '/v1/tracks/resolve') {
      const body = BodySchema.parse(JSON.parse(String(init?.body)))
      bodies.push(body)
      return Response.json(
        sonovaultBulkFixture(
          body.items.map((item) => {
            const position = positions.find(
              (entry) => spotifyId(entry) === item,
            )
            if (!position) return sonovaultMissLine(item)
            return sonovaultMatchedLine(
              item,
              {
                ...sonovaultTrackFixture(recordId(position), {
                  title: `Fixture ${position}`,
                  duration: libraryDuration(position),
                  isrc: releaseIsrc(position),
                }),
                releases: releaseOnTrack
                  .filter((id) => position === 1 || id !== 8101)
                  .map((id) => ({
                    id,
                    title: `Fixture Release ${id}`,
                    artist: { id: 7001, name: 'Fixture Artist' },
                    label: null,
                    release_date: '2020-01-01',
                  })),
              },
              sonovaultLinksFixture(recordId(position), item),
            )
          }),
          30000,
        ),
      )
    }
    const release = /^\/v1\/releases\/(\d+)$/.exec(url.pathname)?.[1]
    const edition = url.searchParams.get('edition')
    if (release === '8101' && !edition) return Response.json(compilation)
    if (release === '8102')
      return Response.json(albumRelease(edition ? Number(edition) : null))
    return Response.json({ message: 'Not found' }, { status: 404 })
  })
}

let tracks: { id: string; position: number }[] = []
const trackId = (position: number) => {
  const found = tracks.find((entry) => entry.position === position)
  if (!found) throw new Error('Missing library track')
  return found.id
}

it('refreshes stored matches for library members only', async () => {
  const outsideTrack = trackId(1)
  const memberTrack = trackId(2)
  const lookedUpAt = new Date('2010-01-01T00:00:00Z')
  await databaseClient
    .update(schema.mediaItem)
    .set({ inLibrary: false })
    .where(inArray(schema.mediaItem.id, [albumId, outsideTrack]))
  await databaseClient.insert(schema.sonovaultAlbumLookup).values({
    mediaItemId: albumId,
    status: 'confirmed',
    lookedUpAt,
  })
  await databaseClient.insert(schema.sonovaultTrackLookup).values(
    [outsideTrack, memberTrack].map((mediaItemId) => ({
      mediaItemId,
      status: 'matched',
      inputType: 'spotify_id',
      input: mediaItemId === outsideTrack ? spotifyId(1) : spotifyId(2),
      lookedUpAt,
    })),
  )

  expect((await getSonovaultSummary()).lookups.dueForRefresh).toBe(1)
  expect(await queueSonovaultRefresh(userId)).toMatchObject({
    queued: 1,
    skipped: 0,
  })
  const jobs = await databaseClient
    .select({ options: schema.scrapeJob.options })
    .from(schema.scrapeJob)
  expect(jobs).toEqual([
    { options: expect.objectContaining({ trackIds: [memberTrack] }) },
  ])
  expect(bodies).toEqual([])
})

async function addAlbumReference(
  provider: string,
  referenceType: string,
  externalId: string,
) {
  await databaseClient.insert(schema.providerReference).values({
    id: `${provider}-${referenceType}-${externalId}`,
    mediaItemId: albumId,
    provider,
    referenceType,
    externalId,
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
  for (const key of Object.keys(secrets)) delete secrets[key]
  secrets['apiKey'] = apiKey
  releaseOnTrack = [8101, 8102]
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
  for (const position of positions)
    await databaseClient
      .update(schema.libraryTrack)
      .set({
        spotifyTrackId: position <= 2 ? spotifyId(position) : null,
        isrc: null,
      })
      .where(eq(schema.libraryTrack.mediaItemId, trackId(position)))
  await addAlbumReference('spotify', 'album', spotifyAlbum)
  await addAlbumReference('spotify', 'upc', '0123456789012')
  await addAlbumReference('musicbrainz', 'release-group', releaseGroup)
  await addAlbumReference('discogs', 'master', '111')
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

/** Looks up the album's tracks, 100 to a request, as the album run does first. */
async function lookUpTracks() {
  await queueSonovaultTrackLookups({ trackIds: positions.map(trackId) }, userId)
  await runQueued()
}

async function lookUpAlbum(tracksFirst = true) {
  if (tracksFirst) await lookUpTracks()
  const result = await queueSonovaultAlbumLookups(
    { albumIds: [albumId] },
    userId,
  )
  await runQueued()
  return result
}

const albumJobs = () =>
  databaseClient
    .select()
    .from(schema.scrapeJob)
    .where(
      and(
        eq(schema.scrapeJob.provider, 'sonovault'),
        eq(schema.scrapeJob.status, 'succeeded'),
        sql`${schema.scrapeJob.options}->>'task' = ${SONOVAULT_ALBUM_LOOKUP_TASK}`,
      ),
    )
    .orderBy(asc(schema.scrapeJob.createdAt), asc(schema.scrapeJob.id))

const references = (mediaItemId: string) =>
  databaseClient
    .select()
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.mediaItemId, mediaItemId),
        eq(schema.providerReference.provider, 'sonovault'),
      ),
    )
    .orderBy(
      asc(schema.providerReference.referenceType),
      asc(schema.providerReference.externalId),
    )

async function trackLookup(position: number) {
  const [row] = await databaseClient
    .select()
    .from(schema.sonovaultTrackLookup)
    .where(eq(schema.sonovaultTrackLookup.mediaItemId, trackId(position)))
  return row ?? null
}

async function primaryIsrc(position: number) {
  const [row] = await databaseClient
    .select({ isrc: schema.libraryTrack.isrc })
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, trackId(position)))
  return row?.isrc ?? null
}

describe('Sonovault album lookup through the queue, with offline HTTP', () => {
  it("confirms the album from its tracks' records and aligns the tracks without their own", async () => {
    expect(await lookUpAlbum()).toMatchObject({ queued: 1, skipped: 0 })
    // One track lookup for every track with an ID, then the release most of
    // the tracks list (not the compilation only track 1 lists) and its
    // matched edition's numbering.
    expect(requested()).toEqual([
      '/v1/tracks/resolve',
      '/v1/releases/8102',
      '/v1/releases/8102?edition=501',
    ])
    expect(bodies).toEqual([
      { input_type: 'spotify_id', items: [spotifyId(1), spotifyId(2)] },
    ])

    const [job] = await albumJobs()
    if (!job) throw new Error('Missing job')
    expect(job.options).toMatchObject({
      task: SONOVAULT_ALBUM_LOOKUP_TASK,
      albumId,
      albumTitle: 'Album fixture',
      creditsUsed: 2,
      // The track lookup reported 30,000 before two release fetches.
      creditsRemaining: 29998,
      releaseCandidates: 2,
      releaseId: '8102',
      confirmedBy: ['spotify-album', 'upc', 'musicbrainz-release-group'],
      confirmed: true,
      aligned: 4,
      unaligned: 0,
    })
    expect((await getJob(job.id))?.scope).toMatchObject({
      mediaType: 'album',
      mediaItemIds: [albumId],
    })
    const responses = await databaseClient
      .select()
      .from(schema.providerResponse)
      .where(eq(schema.providerResponse.jobId, job.id))
      .orderBy(asc(schema.providerResponse.ordinal))
    expect(responses.map((row) => [row.status, row.bodyState])).toEqual([
      [200, 'captured'],
      [200, 'captured'],
    ])
    expect(JSON.stringify(responses)).not.toContain(apiKey)
    const [releaseResponse, numberedResponse] = responses
    if (!releaseResponse || !numberedResponse)
      throw new Error('Missing responses')

    // Tracks with an ID keep their own lookups and links.
    for (const position of [1, 2]) {
      expect(await trackLookup(position)).toMatchObject({
        inputType: 'spotify_id',
        verified: true,
      })
      expect(
        (await references(trackId(position))).map((row) => row.referenceType),
      ).toContain('spotify-track')
    }

    // A track with no ID gets the same references and ISRC from the release.
    expect(await trackLookup(3)).toMatchObject({
      inputType: 'release',
      input: '8102',
      status: 'matched',
      sonovaultTrackId: String(recordId(3)),
      verified: true,
      primaryIsrc: releaseIsrc(3),
      scrapeJobId: job.id,
      responseId: numberedResponse.id,
    })
    const rows = await references(trackId(3))
    expect(rows.map((row) => [row.referenceType, row.externalId])).toEqual([
      ['isrc', releaseIsrc(3)],
      ['sonovault-track', String(recordId(3))],
    ])
    expect(
      rows.find((row) => row.referenceType === 'sonovault-track'),
    ).toMatchObject({
      isPrimary: true,
      metadata: {
        verified: true,
        inputType: 'release',
        jobId: job.id,
        responseId: numberedResponse.id,
        isrc: releaseIsrc(3),
      },
    })
    expect(
      rows.find((row) => row.referenceType === 'isrc')?.metadata,
    ).toMatchObject({ source: SONOVAULT_ALBUM_LOOKUP_TASK, jobId: job.id })
    expect(await primaryIsrc(3)).toBe(releaseIsrc(3))
    // Paired by position and title at another version's length: unverified.
    expect(await trackLookup(4)).toMatchObject({
      inputType: 'release',
      verified: false,
      primaryIsrc: null,
    })
    expect(
      (await references(trackId(4))).map((row) => row.referenceType),
    ).toEqual(['sonovault-track'])
    expect(await primaryIsrc(4)).toBeNull()

    // SONO-21: album references from the release and its editions.
    const album = await references(albumId)
    expect(album.map((row) => [row.referenceType, row.externalId])).toEqual([
      ['digital-upc', '123456789012'],
      ['discogs-master', '222'],
      ['discogs-release', '7002'],
      ['musicbrainz-release', '00000000-0000-4000-8000-00000000b001'],
      ['musicbrainz-release-group', releaseGroup],
      ['sonovault-release', '8102'],
    ])
    expect(
      album.find((row) => row.referenceType === 'sonovault-release'),
    ).toMatchObject({
      isPrimary: true,
      metadata: {
        responseId: releaseResponse.id,
        jobId: job.id,
        editionId: 501,
        confirmedBy: ['spotify-album', 'upc', 'musicbrainz-release-group'],
        label: 'Fixture Label 501',
        catalogNo: 'FIX-501',
      },
    })

    // SONO-22: the Discogs master differs; MusicBrainz agrees.
    const state = await getSonovaultAlbumState(albumId)
    expect(state).toMatchObject({
      canLookUp: true,
      lookup: {
        status: 'confirmed',
        releaseId: '8102',
        editionId: '501',
        aligned: 4,
        isrcs: 1,
        creditsUsed: 2,
      },
      review: [
        {
          provider: 'discogs',
          referenceType: 'master',
          stored: '111',
          sonovault: '222',
          url: 'https://www.discogs.com/master/222',
        },
      ],
    })
    expect(await listUnresolvedMatches({ kind: 'album', id: albumId })).toEqual(
      {
        query: 'Album fixture',
        items: [
          {
            provider: 'discogs',
            jobId: job.id,
            outcome: 'suggested',
            candidates: [
              {
                referenceType: 'master',
                externalId: '222',
                title: 'Fixture Release 8102',
                subtitle: 'Fixture Artist · Sonovault',
                releaseDate: null,
                artworkUrl: null,
                url: 'https://www.discogs.com/master/222',
                current: false,
              },
            ],
          },
        ],
      },
    )
    expect(await listSonovaultAlbumReview()).toMatchObject({
      totalCount: 1,
      items: [{ albumId, title: 'Album fixture' }],
    })
    expect(await getSonovaultAlbumSummary()).toEqual({
      confirmed: 1,
      notFound: 0,
      alignedTracks: 4,
      differing: 1,
      candidates: 0,
    })

    // A confirmed album is not looked up again.
    request.mockClear()
    expect(await lookUpAlbum()).toMatchObject({ queued: 0, skipped: 1 })
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps each track's own record on its lookup row, past its job", async () => {
    await lookUpAlbum()
    const own = await trackLookup(1)
    expect(own?.record).toMatchObject({
      kind: 'resolve',
      track: { id: recordId(1), releases: [{ id: 8101 }, { id: 8102 }] },
      links: expect.arrayContaining([
        expect.objectContaining({
          source: 'spotify',
          external_id: spotifyId(1),
        }),
      ]),
    })
    expect((await trackLookup(3))?.record).toMatchObject({
      kind: 'release',
      releaseId: 8102,
      track: { id: recordId(3), track_number: 3 },
    })
    const before = (await Promise.all(positions.map(trackLookup))).map(
      (row) => row?.record,
    )

    // Rows stored before records were kept there are filled from responses.
    await databaseClient
      .update(schema.sonovaultTrackLookup)
      .set({ record: null })
    expect(
      await backfillSonovaultTrackRecords(databaseClient, { apply: false }),
    ).toEqual({
      apply: false,
      rows: 4,
      filled: 4,
      unreadable: 0,
      noResponse: 0,
    })
    expect((await trackLookup(1))?.record).toBeNull()
    expect(
      await backfillSonovaultTrackRecords(databaseClient, { apply: true }),
    ).toMatchObject({ filled: 4, unreadable: 0 })
    expect(
      (await Promise.all(positions.map(trackLookup))).map((row) => row?.record),
    ).toEqual(before)

    // Deleting the jobs and their responses leaves every record in place,
    // and a track with a record is not sent to Sonovault again.
    await databaseClient.delete(schema.scrapeJob)
    expect(
      (await Promise.all(positions.map(trackLookup))).map((row) => row?.record),
    ).toEqual(before)
    request.mockClear()
    await lookUpTracks()
    expect(request).not.toHaveBeenCalled()
  })

  it('dispatches bulk track lookups before album jobs queued earlier', async () => {
    await queueSonovaultAlbumLookups({ albumIds: [albumId] }, userId)
    await queueSonovaultTrackLookups({ trackIds: [trackId(1)] }, userId)
    await queueSonovaultTrackLookups({ trackIds: [trackId(2)] }, userId)
    const queued = await databaseClient
      .select({
        id: schema.scrapeJob.id,
        task: sql<string>`${schema.scrapeJob.options}->>'task'`,
        priority: sql<
          string | null
        >`${schema.scrapeJob.options}->>'dispatchPriority'`,
      })
      .from(schema.scrapeJob)
      .orderBy(asc(schema.scrapeJob.createdAt), asc(schema.scrapeJob.id))
    expect(queued.map(({ task, priority }) => [task, priority])).toEqual([
      [SONOVAULT_ALBUM_LOOKUP_TASK, null],
      ['sonovault-track-lookup', '1'],
      ['sonovault-track-lookup', '1'],
    ])
    const [album, first, second] = queued
    // Higher priority first; equal priority keeps the oldest first.
    expect(await listCloudQueuedJobIds('sonovault', [], 10)).toEqual([
      first?.id,
      second?.id,
      album?.id,
    ])
    expect(
      await listCloudQueuedJobIds('sonovault', [first?.id ?? ''], 1),
    ).toEqual([second?.id])
  })

  it('waits, recording nothing, while its tracks are not looked up', async () => {
    await lookUpAlbum(false)
    expect(request).not.toHaveBeenCalled()
    const [job] = await albumJobs()
    expect(job?.options).toMatchObject({ creditsUsed: 0, tracksPending: true })
    expect((await getSonovaultAlbumState(albumId)).lookup).toBeNull()
  })

  it('offers Sonovault IDs where the album has no Discogs or MusicBrainz match', async () => {
    await databaseClient
      .delete(schema.providerReference)
      .where(eq(schema.providerReference.provider, 'discogs'))
    await databaseClient
      .delete(schema.providerReference)
      .where(eq(schema.providerReference.provider, 'musicbrainz'))
    releaseOnTrack = [8102]
    await lookUpTracks()
    request.mockClear()

    await lookUpAlbum(false)
    expect(requested()).toEqual([
      '/v1/releases/8102',
      '/v1/releases/8102?edition=501',
    ])
    const state = await getSonovaultAlbumState(albumId)
    expect(state.lookup).toMatchObject({
      status: 'confirmed',
      confirmedBy: ['spotify-album', 'upc'],
      creditsUsed: 2,
    })
    expect(state.review).toEqual([
      {
        provider: 'discogs',
        referenceType: 'master',
        stored: null,
        sonovault: '222',
        url: 'https://www.discogs.com/master/222',
      },
      {
        provider: 'musicbrainz',
        referenceType: 'release-group',
        stored: null,
        sonovault: releaseGroup,
        url: `https://musicbrainz.org/release-group/${releaseGroup}`,
      },
    ])
    // The track looked up on its own keeps its lookup.
    expect(await trackLookup(2)).toMatchObject({ inputType: 'spotify_id' })
    expect(await trackLookup(3)).toMatchObject({ inputType: 'release' })
    const unresolved = await listUnresolvedMatches({
      kind: 'album',
      id: albumId,
    })
    expect(
      unresolved.items.map(({ provider, outcome, candidates }) => [
        provider,
        outcome,
        candidates.map(({ referenceType, externalId }) => [
          referenceType,
          externalId,
        ]),
      ]),
    ).toEqual([
      ['discogs', 'suggested', [['master', '222']]],
      ['musicbrainz', 'suggested', [['release-group', releaseGroup]]],
    ])
    // A candidate marked incorrect for the album is not offered again.
    await databaseClient.insert(schema.mediaOverride).values({
      id: 'fixture-rejection',
      mediaItemId: albumId,
      field: 'albumMatchRejection',
      value: {
        provider: 'discogs',
        sourceProvider: 'discogs',
        snapshotId: 'fixture-snapshot',
        referenceType: 'master',
        identifier: '222',
      },
    })
    expect(
      (await listUnresolvedMatches({ kind: 'album', id: albumId })).items.map(
        ({ provider }) => provider,
      ),
    ).toEqual(['musicbrainz'])
  })

  it('records a release no identifier confirms as not found, by title never', async () => {
    releaseOnTrack = [8101]
    await lookUpAlbum()
    expect(requested()).toEqual(['/v1/tracks/resolve', '/v1/releases/8101'])
    const state = await getSonovaultAlbumState(albumId)
    expect(state.lookup).toMatchObject({
      status: 'not_found',
      miss: 'not-confirmed',
      releaseId: null,
      aligned: 0,
      creditsUsed: 1,
      retryAfter: expect.any(String),
    })
    expect(state.references).toEqual([])
    expect(await trackLookup(3)).toBeNull()
    // A miss is not looked up again for 30 days.
    request.mockClear()
    expect(await lookUpAlbum()).toMatchObject({ queued: 0 })
    expect(request).not.toHaveBeenCalled()
    // Unless asked to try it again now.
    expect(
      await queueSonovaultAlbumLookups(
        { albumIds: [albumId], retry: true },
        userId,
      ),
    ).toMatchObject({ queued: 1 })
  })

  it('stops before the reserve and removes album lookups with everything else', async () => {
    await lookUpTracks()
    request.mockClear()
    // The track lookup reported 30,000 left.
    secrets['creditReserve'] = '29995'
    await lookUpAlbum(false)
    expect(request).not.toHaveBeenCalled()
    const [job] = await albumJobs()
    expect(job?.options).toMatchObject({ creditReserveReached: true })
    expect((await getSonovaultAlbumState(albumId)).lookup).toBeNull()

    delete secrets['creditReserve']
    await lookUpAlbum(false)
    expect((await getSonovaultAlbumState(albumId)).lookup?.status).toBe(
      'confirmed',
    )
    expect((await getSonovaultSummary()).credits.remaining).toBe(29998)
    const removed = await removeSonovaultData()
    expect(removed.lookups).toBe(5)
    expect(await references(albumId)).toEqual([])
    expect((await getSonovaultAlbumState(albumId)).lookup).toBeNull()
    expect(await primaryIsrc(2)).toBeNull()
  })

  it('aligns nothing when the release group is another album’s', async () => {
    await databaseClient
      .delete(schema.providerReference)
      .where(eq(schema.providerReference.mediaItemId, albumId))
    await addAlbumReference('musicbrainz', 'release-group', otherGroup)
    await lookUpAlbum()
    expect((await getSonovaultAlbumState(albumId)).lookup).toMatchObject({
      status: 'not_found',
      miss: 'not-confirmed',
    })
  })
})
