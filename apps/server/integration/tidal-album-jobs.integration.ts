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
import { CreateJobSchema } from '@repo/schemas/job'
import { env } from '@/env'
import { clearTidalTokenCache } from '@/lib/tidal-api'
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import * as schema from '@/schemas/db'
import { tidalPlugin } from '@/plugins/builtin/tidal'

const database = `tidal_album_jobs_${randomUUID().replaceAll('-', '')}`
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
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'offline-fixture-client',
    clientSecret: 'offline-fixture-secret',
  }),
}))

const albumId = 'album-fixture'
const upc = '0000000000017'
const tidalAlbumId = '700001'
const trackCount = 22
// Library track 5 has another title and timing; track 7 has no duration.
const UNALIGNED = 5
const TITLE_ONLY = 7
// Library track 2 already has its own ISRC.
const KEPT_ISRC = 2
const tidalTrackId = (position: number) => `${800000 + position}`
const isrc = (position: number) =>
  `QZFX1${String(2600000 + position).padStart(7, '0')}`
const durationSec = (position: number) => 150 + position * 7

const libraryTracks = Array.from({ length: trackCount }, (_, index) => {
  const position = index + 1
  return {
    title:
      position === UNALIGNED ? 'Library-only fixture' : `Fixture ${position}`,
    position,
    ...(position === TITLE_ONLY
      ? {}
      : {
          durationSec:
            position === UNALIGNED
              ? durationSec(position) + 40
              : durationSec(position) + (position % 3) - 1,
        }),
  }
})

const tidalTrack = (position: number) => ({
  id: tidalTrackId(position),
  type: 'tracks',
  attributes: {
    title: `Fixture ${position}`,
    ...(position === 3 ? { version: 'Fixture Edit' } : {}),
    isrc: isrc(position),
    duration: `PT${Math.floor(durationSec(position) / 60)}M${durationSec(position) % 60}S`,
    explicit: false,
    popularity: 0.5,
    availability: ['STREAM', 'DJ'],
    externalLinks: [
      {
        href: `https://tidal.com/browse/track/${tidalTrackId(position)}`,
        meta: { type: 'TIDAL_SHARING' },
      },
    ],
  },
})
const itemIdentifier = (position: number) => ({
  id: tidalTrackId(position),
  type: 'tracks',
  meta: { volumeNumber: 1, trackNumber: position },
})
const positions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

const nextLink = `/albums/${tidalAlbumId}/relationships/items?countryCode=AU&page%5Bcursor%5D=fixture-cursor`
const albumDocument = {
  data: [
    {
      id: tidalAlbumId,
      type: 'albums',
      attributes: {
        title: 'Album fixture',
        barcodeId: upc,
        albumType: 'ALBUM',
        numberOfItems: trackCount,
        numberOfVolumes: 1,
        externalLinks: [
          {
            href: `https://tidal.com/browse/album/${tidalAlbumId}`,
            meta: { type: 'TIDAL_SHARING' },
          },
        ],
      },
      relationships: {
        items: {
          data: positions(1, 20).map(itemIdentifier),
          links: {
            self: `/albums/${tidalAlbumId}/relationships/items?countryCode=AU`,
            next: nextLink,
            meta: { nextCursor: 'fixture-cursor' },
          },
        },
      },
    },
  ],
  included: positions(1, 20).map(tidalTrack),
  links: { self: '/albums?countryCode=AU' },
}
const itemsPage = {
  data: positions(21, trackCount).map(itemIdentifier),
  included: positions(21, trackCount).map(tidalTrack),
  links: { self: nextLink },
}
const tokenResponse = {
  access_token: 'offline-fixture-token',
  expires_in: 14400,
  scope: '',
  token_type: 'Bearer',
}

function mockTidal(albums: unknown = albumDocument) {
  request.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === 'https://auth.tidal.com/v1/oauth2/token')
      return Response.json(tokenResponse)
    if (url.pathname === '/v2/albums') return Response.json(albums)
    if (url.pathname === `/v2/albums/${tidalAlbumId}/relationships/items`)
      return Response.json(itemsPage)
    throw new Error('Unexpected request')
  })
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  clearTidalTokenCache()
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
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
    await replaceAlbumTracks(tx, albumId, libraryTracks)
    await tx.insert(schema.providerReference).values({
      id: 'spotify-upc-fixture',
      mediaItemId: albumId,
      provider: 'spotify',
      referenceType: 'upc',
      externalId: upc,
    })
    await tx.insert(schema.providerSnapshot).values({
      id: 'spotify-fixture-snapshot',
      mediaItemId: albumId,
      provider: 'spotify',
      source: 'scrape',
      checksum: 'spotify-fixture',
      payload: {},
      normalizedData: { tracks: libraryTracks },
    })
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function runJob() {
  const { createJob, processQueuedJobs, getJob } =
    await import('@/services/jobs')
  // The worker skips TIDAL until its request spacing has passed.
  const [gate] = await databaseClient
    .select({ nextAllowedAt: schema.providerRequestState.nextAllowedAt })
    .from(schema.providerRequestState)
    .where(eq(schema.providerRequestState.provider, 'tidal'))
  const wait = (gate?.nextAllowedAt?.getTime() ?? 0) - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 50))
  const job = await createJob(
    CreateJobSchema.parse({
      provider: 'tidal',
      scope: { mediaItemIds: [albumId], mediaType: 'album' },
    }),
    null,
  )
  await processQueuedJobs()
  const finished = await getJob(job.id)
  if (!finished) throw new Error('Missing job')
  return finished
}

const albumTrackRows = () =>
  databaseClient
    .select()
    .from(schema.track)
    .where(eq(schema.track.albumMediaItemId, albumId))
    .orderBy(asc(schema.track.position))

const trackReferences = (referenceType: string) =>
  databaseClient
    .select()
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.provider, 'tidal'),
        eq(schema.providerReference.referenceType, referenceType),
      ),
    )
    .orderBy(asc(schema.providerReference.externalId))

/** A reference row without the values each run sets anew. */
const stable = (rows: Array<typeof schema.providerReference.$inferSelect>) =>
  rows.map((row) => ({
    id: row.id,
    mediaItemId: row.mediaItemId,
    externalId: row.externalId,
    isPrimary: row.isPrimary,
    metadata: Object.fromEntries(
      Object.entries(row.metadata ?? {}).filter(
        ([key]) => key !== 'jobId' && key !== 'recordedAt',
      ),
    ),
  }))

describe('TIDAL album job through the queue, with offline HTTP', () => {
  it('records track references and ISRCs on the aligned library tracks', async () => {
    const tracks = await albumTrackRows()
    const keptIsrcTrack = tracks[KEPT_ISRC - 1]?.trackMediaItemId
    if (!keptIsrcTrack) throw new Error('Missing library track')
    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc: 'QZFX19999999' })
      .where(eq(schema.libraryTrack.mediaItemId, keptIsrcTrack))
    mockTidal()

    const job = await runJob()
    expect(job.status).toBe('succeeded')

    expect(await albumTrackRows()).toEqual(tracks)
    const [albumReference] = await trackReferences('album')
    expect(albumReference).toMatchObject({
      mediaItemId: albumId,
      externalId: tidalAlbumId,
      isPrimary: true,
      metadata: {
        url: `https://tidal.com/browse/album/${tidalAlbumId}`,
        matchedBy: 'upc',
        barcodeId: upc,
      },
    })
    expect(
      await databaseClient
        .select()
        .from(schema.externalLink)
        .where(eq(schema.externalLink.provider, 'tidal')),
    ).toEqual([
      expect.objectContaining({
        mediaItemId: albumId,
        label: 'TIDAL',
        url: `https://tidal.com/browse/album/${tidalAlbumId}`,
      }),
    ])

    const references = await trackReferences('track')
    expect(references).toHaveLength(trackCount - 1)
    for (const row of tracks) {
      const reference = references.find(
        (entry) => entry.mediaItemId === row.trackMediaItemId,
      )
      if (row.position === UNALIGNED) {
        expect(reference).toBeUndefined()
        continue
      }
      expect(reference).toMatchObject({
        externalId: tidalTrackId(row.position),
        isPrimary: true,
        metadata: {
          url: `https://tidal.com/browse/track/${tidalTrackId(row.position)}`,
          version: row.position === 3 ? 'Fixture Edit' : null,
          durationSec: durationSec(row.position),
          popularity: 0.5,
          source: 'tidal-album',
          jobId: job.id,
          albumMediaItemId: albumId,
          tidalAlbumId,
          volumeNumber: 1,
          trackNumber: row.position,
          alignment:
            row.position === TITLE_ONLY
              ? 'position-title'
              : 'position-duration',
          recordedAt: expect.any(String),
        },
      })
      expect(reference?.metadata).not.toHaveProperty('bpm')
    }

    const isrcs = await trackReferences('isrc')
    expect(isrcs).toHaveLength(trackCount - 1)
    expect(isrcs.map((row) => row.metadata)).toEqual(
      isrcs.map(() =>
        expect.objectContaining({ source: 'tidal-album', jobId: job.id }),
      ),
    )
    const libraryRows = await databaseClient
      .select({
        id: schema.libraryTrack.mediaItemId,
        isrc: schema.libraryTrack.isrc,
      })
      .from(schema.libraryTrack)
    const primary = new Map(libraryRows.map((row) => [row.id, row.isrc]))
    expect(
      tracks.map((row) => primary.get(row.trackMediaItemId) ?? null),
    ).toEqual(
      tracks.map((row) =>
        row.position === KEPT_ISRC
          ? 'QZFX19999999'
          : row.position === UNALIGNED || row.position === TITLE_ONLY
            ? null
            : isrc(row.position),
      ),
    )

    const calls = request.mock.calls.map(([input]) =>
      String(input instanceof Request ? input.url : input),
    )
    expect(calls).toHaveLength(3)
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toHaveLength(calls.length)
    const responses = await databaseClient
      .select()
      .from(schema.providerResponse)
      .where(eq(schema.providerResponse.jobId, job.id))
      .orderBy(asc(schema.providerResponse.ordinal))
    // The token exchange is gated but its response is not kept.
    expect(responses.map((row) => row.requestUrl)).toEqual([
      'https://openapi.tidal.com/v2/albums',
      `https://openapi.tidal.com/v2/albums/${tidalAlbumId}/relationships/items`,
    ])
    expect(responses.every((row) => row.provider === 'tidal')).toBe(true)
    expect(
      responses.map((row) =>
        row.body.state === 'captured' ? JSON.parse(row.body.text) : null,
      ),
    ).toEqual([albumDocument, itemsPage])
    expect(JSON.stringify(responses)).not.toMatch(
      /offline-fixture-(secret|token)/,
    )
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.provider, 'tidal'))
    expect(snapshot?.payload).toEqual({
      album: albumDocument,
      itemPages: [itemsPage],
    })

    // A second run looks the album up by its TIDAL ID and writes the same rows.
    const before = {
      tracks: stable(references),
      isrcs: await trackReferences('isrc'),
      library: libraryRows,
    }
    request.mockClear()
    const again = await runJob()
    expect(again.status).toBe('succeeded')
    expect(
      request.mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).includes(
          'filter%5Bid%5D',
        ),
      ),
    ).toBe(true)
    const afterTracks = await trackReferences('track')
    expect(stable(afterTracks)).toEqual(before.tracks)
    expect(
      afterTracks.every((row) => row.metadata?.['jobId'] === again.id),
    ).toBe(true)
    // An ISRC keeps the job it was first read from.
    expect(await trackReferences('isrc')).toEqual(before.isrcs)
    expect(
      await databaseClient
        .select({
          id: schema.libraryTrack.mediaItemId,
          isrc: schema.libraryTrack.isrc,
        })
        .from(schema.libraryTrack),
    ).toEqual(expect.arrayContaining(before.library))
  })

  it('ends as not found when TIDAL has no album with the UPC', async () => {
    mockTidal({
      data: [],
      links: { self: '/albums?countryCode=AU' },
      included: [],
    })
    const job = await runJob()
    expect(job.status).toBe('failed')
    expect(job.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ classification: 'not-found' }),
        }),
      ]),
    )
    expect(await trackReferences('track')).toEqual([])
    expect(await trackReferences('album')).toEqual([])
    const responses = await databaseClient
      .select()
      .from(schema.providerResponse)
      .where(eq(schema.providerResponse.jobId, job.id))
    expect(responses.length).toBeGreaterThan(0)
  })
})
