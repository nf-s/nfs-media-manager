import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ArtistProfileProvider } from '@repo/schemas/artist-profiles'
import type { JsonValue } from '@repo/schemas/common'
import { env } from '@/env'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import * as schema from '@/schemas/db'

const database = 'artist_jobs_' + randomUUID().replaceAll('-', '')
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
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  getScrapePlugin: async (id: string) =>
    id === 'musicbrainz'
      ? {
          ...musicbrainzPlugin,
          manifest: {
            ...musicbrainzPlugin.manifest,
            rateLimit: {
              ...musicbrainzPlugin.manifest.rateLimit,
              minTimeMs: 0,
            },
          },
        }
      : null,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    appName: 'OfflineFixture',
    appVersion: '2.0',
    contact: 'offline@example.test',
  }),
}))

const artistId = 'artist-fixture'
const artistName = 'Artist Fixture'
const artistMbid = '11111111-1111-4111-8111-111111111111'
const duplicateMbid = '22222222-2222-4222-8222-222222222222'
const spotifyAlbumId = '0123456789abcdefghijkl'
const spotifyTrackId = '0123456789abcdefghijkm'
const spotifyArtistId = '0123456789abcdefghijkn'
const artistProfile = {
  id: artistMbid,
  name: artistName,
  tags: [{ name: 'Ambient' }],
}

async function seedArtistAlbum(id: string, targetArtist = artistId) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: 'Album fixture',
    mediaType: 'album',
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: id,
    artistId: targetArtist,
    role: 'artist',
  })
}

async function providerEvidence(
  mediaItemId: string,
  provider: ArtistProfileProvider,
  payload: JsonValue,
) {
  await databaseClient.insert(schema.providerCurrentState).values({
    id: provider + '-' + mediaItemId,
    mediaItemId,
    provider,
    payload,
    checksum: 'fixture',
    status: 'ready',
  })
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient
    .insert(schema.artist)
    .values({ id: artistId, name: artistName })
  await seedArtistAlbum('album-fixture')
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('artist enrichment through queued jobs and stored evidence', () => {
  it('queues one job per artist and provider, reads the stored native artist ID, and keeps album evidence intact', async () => {
    const albumEvidence = {
      releaseGroup: {
        id: duplicateMbid,
        title: 'Album fixture',
        'artist-credit': [{ artist: { id: artistMbid, name: artistName } }],
      },
    }
    await providerEvidence('album-fixture', 'musicbrainz', albumEvidence)
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, listJobs, processQueuedJobs } =
      await import('@/services/jobs')
    const input = { artistId, provider: 'musicbrainz' } satisfies {
      artistId: string
      provider: ArtistProfileProvider
    }
    const queued = await enqueueArtistEnrichment(input, null)
    expect((await enqueueArtistEnrichment(input, null)).id).toBe(queued.id)
    expect(queued.items).toEqual([])
    expect(queued.options).toMatchObject({
      task: 'artist-enrichment',
      artistId,
      artistName,
    })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(request).toHaveBeenCalledTimes(1)
    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
      '/ws/2/artist/' + artistMbid,
    )
    expect(await getJob(queued.id)).toMatchObject({
      status: 'succeeded',
      options: { progress: { pagesRead: 1, totalPages: 1 } },
    })
    expect(
      (
        await listJobs({ artistId, mediaType: 'album', sortBy: 'title' })
      ).items.map((item) => item.id),
    ).toEqual([queued.id])
    const [snapshot] = await databaseClient
      .select()
      .from(schema.artistProviderSnapshot)
    expect(snapshot).toMatchObject({
      artistId,
      scrapeJobId: queued.id,
      normalizedData: { externalId: artistMbid, tags: ['Ambient'] },
      payload: { artist: artistProfile },
    })
    expect(
      await databaseClient.select().from(schema.artistProviderCurrentState),
    ).toMatchObject([{ latestSnapshotId: snapshot?.id }])
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toMatchObject([{ payload: albumEvidence }])
    expect(await databaseClient.select().from(schema.tagOccurrence)).toEqual([])
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
  })

  it('retains conflicting linked IDs as job diagnostics and lets a direct correction bypass the conflict', async () => {
    await seedArtistAlbum('other-album')
    const credits = [
      { album: 'album-fixture', id: artistMbid },
      { album: 'other-album', id: duplicateMbid },
    ]
    for (const { album, id } of credits)
      await providerEvidence(album, 'musicbrainz', {
        releaseGroup: {
          'artist-credit': [{ artist: { id, name: artistName } }],
        },
      })
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobById, processQueuedJobs, retryJob } =
      await import('@/services/jobs')
    const unresolved = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz' },
      null,
    )
    const recordOutcome = vi.fn(async () => {})
    await processQueuedJobById(unresolved.id, 'musicbrainz', {
      canContinue: async () => true,
      recordOutcome,
    })
    expect(request).not.toHaveBeenCalled()
    expect(recordOutcome).not.toHaveBeenCalled()
    expect(await getJob(unresolved.id)).toMatchObject({
      status: 'failed',
      logs: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            classification: 'ambiguous',
            diagnostics: [
              expect.objectContaining({
                stage: 'artist.stored-candidates',
                evidence: expect.objectContaining({ total: 2 }),
              }),
            ],
          }),
        }),
      ]),
    })
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toEqual([])
    const corrected = await enqueueArtistEnrichment(
      {
        artistId,
        provider: 'musicbrainz',
        providerArtistId: artistMbid,
      },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await getJob(corrected.id)).toMatchObject({ status: 'succeeded' })
    await expect(retryJob(unresolved.id, null, false)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('records a missing match without counting it as a dispatcher failure', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobById } = await import('@/services/jobs')
    const job = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz' },
      null,
    )
    request.mockResolvedValueOnce(Response.json({ count: 0, artists: [] }))
    const recordOutcome = vi.fn(async () => {})
    await processQueuedJobById(job.id, 'musicbrainz', {
      canContinue: async () => true,
      recordOutcome,
    })
    expect(await getJob(job.id)).toMatchObject({
      status: 'failed',
      logs: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ classification: 'not-found' }),
        }),
      ]),
    })
    expect(recordOutcome).not.toHaveBeenCalled()
  })

  it('refuses to retry a failed explicit artist ID after a newer profile succeeds', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobs, retryJob } =
      await import('@/services/jobs')
    const stale = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz', providerArtistId: duplicateMbid },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await getJob(stale.id)).toMatchObject({ status: 'failed' })

    const current = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz', providerArtistId: artistMbid },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await getJob(current.id)).toMatchObject({ status: 'succeeded' })
    await expect(retryJob(stale.id, null, false)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toMatchObject([
      { scrapeJobId: current.id, normalizedData: { externalId: artistMbid } },
    ])
  })

  it('uses track-linked Spotify credits, Discogs credits and the Last.fm scrobble artist MBID', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'track-fixture',
      slug: 'track-fixture',
      title: 'Track Fixture',
      mediaType: 'track',
    })
    await databaseClient.insert(schema.libraryTrack).values({
      mediaItemId: 'track-fixture',
      spotifyTrackId,
      albumMediaItemId: 'album-fixture',
    })
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: 'track-fixture',
      artistId,
      role: 'artist',
    })
    await providerEvidence('album-fixture', 'spotify', {
      id: spotifyAlbumId,
      name: 'Album fixture',
      tracks: {
        items: [
          {
            id: '0123456789abcdefghijko',
            artists: [{ id: '0123456789abcdefghijkp', name: artistName }],
          },
          {
            id: spotifyTrackId,
            artists: [{ id: spotifyArtistId, name: artistName }],
          },
        ],
      },
    })
    await providerEvidence('album-fixture', 'discogs', {
      release: { id: 601, artists: [{ id: 71, name: artistName }] },
    })
    await databaseClient.insert(schema.lastfmScrobble).values({
      id: 'scrobble-fixture',
      username: 'listener-fixture',
      artistName,
      artistKey: artistName.toLowerCase(),
      trackName: 'Track Fixture',
      trackKey: 'track fixture',
      listenedAt: new Date('2025-01-01T00:00:00Z'),
      artistMbid,
      albumMbid: duplicateMbid,
      albumMediaItemId: 'album-fixture',
    })
    const { listStoredArtistProviderCandidates } =
      await import('@/services/artist-provider-evidence')
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'spotify'),
    ).toEqual([{ id: spotifyArtistId, name: artistName, exact: true }])
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'discogs'),
    ).toEqual([{ id: '71', name: artistName, exact: true }])
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'lastfm'),
    ).toEqual([{ id: artistMbid, name: artistName, exact: true }])
  })

  it('discards an artist response received after job cancellation', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { bulkCancelJobs, getJob, processQueuedJobs } =
      await import('@/services/jobs')
    const job = await enqueueArtistEnrichment(
      {
        artistId,
        provider: 'musicbrainz',
        providerArtistId: artistMbid,
      },
      null,
    )
    let notifyRequestStarted: () => void = () => undefined
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve
    })
    let releaseResponse: () => void = () => undefined
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    request.mockImplementationOnce(async () => {
      notifyRequestStarted()
      await release
      return Response.json(artistProfile)
    })
    const jobFinished = processQueuedJobs()
    try {
      await Promise.race([requestStarted, jobFinished])
      expect(request).toHaveBeenCalledTimes(1)
      const cancelled = await bulkCancelJobs(
        { jobIds: [job.id], confirmRunning: true },
        null,
      )
      expect(cancelled.cancelled).toBe(1)
    } finally {
      releaseResponse()
      await jobFinished
    }
    expect(await getJob(job.id)).toMatchObject({ status: 'cancelled' })
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toEqual([])
    expect(
      await databaseClient.select().from(schema.artistProviderCurrentState),
    ).toEqual([])
  })
})
