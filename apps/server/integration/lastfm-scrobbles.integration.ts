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
import { ProviderResponseSchema } from '@repo/schemas/provider-response'
import { env } from '@/env'
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import * as schema from '@/schemas/db'
import type { LastfmSyncJobContext } from '@/services/lastfm-scrobbles'

const database = `lastfm_scrobbles_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const queries: string[] = []
const databaseClient = drizzle(pool, {
  schema,
  logger: {
    logQuery(query) {
      queries.push(query)
    },
  },
})
const request = vi.fn<typeof fetch>()
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'lastfm' ? lastfmPlugin : null,
  listLoadedScrapePlugins: async () => [],
}))
// One page per job and no pacing, so every page boundary chains a follow-on job.
vi.mock('@/services/lastfm-scrobbles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/lastfm-scrobbles')>()
  return {
    ...actual,
    runLastfmSyncJob: (context: LastfmSyncJobContext) =>
      actual.runLastfmSyncJob(context, {
        maxPages: 1,
        spacingMs: 0,
        retryDelaysMs: [0, 0],
      }),
  }
})
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    apiKey: 'offline-fixture-key',
    username: 'Fixture-Listener',
  }),
}))

const recent = Math.floor(Date.now() / 1000) - 3600
const old = Math.floor(Date.UTC(2015, 4, 10) / 1000)

function scrobble(
  uts: number,
  name: string,
  album = 'Album fixture',
  artist = 'Artist fixture',
) {
  return {
    artist: { mbid: '', '#text': artist },
    album: { mbid: '', '#text': album },
    name,
    mbid: '',
    url: 'https://www.last.fm/music/Artist+fixture/_/track',
    date: { uts: String(uts), '#text': 'synthetic' },
  }
}

function page(number: number, totalPages: number, track: unknown) {
  return {
    recenttracks: {
      track,
      '@attr': {
        user: 'Fixture-Listener',
        page: String(number),
        perPage: '200',
        totalPages: String(totalPages),
        total: '3',
      },
    },
  }
}

const nowPlaying = {
  artist: { mbid: '', '#text': 'Artist fixture' },
  album: { mbid: '', '#text': 'Album fixture' },
  name: 'First track',
  '@attr': { nowplaying: 'true' },
}

function respond(...pages: unknown[]) {
  for (const body of pages)
    request.mockImplementationOnce(async () => Response.json(body))
}

function requestedUrl(call: number) {
  return new URL(String(request.mock.calls[call]?.[0]))
}

async function syncJobs() {
  return databaseClient
    .select()
    .from(schema.scrapeJob)
    .orderBy(schema.scrapeJob.createdAt, schema.scrapeJob.id)
}

// Stands in for the job worker's polling loop.
async function drain() {
  const { processQueuedJobs } = await import('@/services/jobs')
  const { getLastfmSyncStatus } = await import('@/services/lastfm-scrobbles')
  await vi.waitFor(
    async () => {
      await processQueuedJobs()
      expect((await getLastfmSyncStatus()).state).not.toBe('running')
    },
    { timeout: 10000, interval: 100 },
  )
  return getLastfmSyncStatus()
}

/** Every response the sync jobs stored, in job and request order. */
async function storedResponses() {
  const { getJobProviderResponse, listJobProviderResponses } =
    await import('@/services/provider-response-history')
  const stored = []
  for (const job of await syncJobs()) {
    const page = await listJobProviderResponses(job.id, { page: 1, size: 100 })
    for (const item of page.items) {
      const { body } = ProviderResponseSchema.parse(
        await getJobProviderResponse(job.id, item.id),
      )
      stored.push({
        jobId: job.id,
        phase: item.phase,
        url: item.requestUrl,
        status: item.status,
        text: body.state === 'captured' ? body.text : null,
      })
    }
  }
  return stored
}

async function syncToEnd() {
  const { queueLastfmSync } = await import('@/services/lastfm-sync-jobs')
  await queueLastfmSync(null)
  return drain()
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
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.lastfmAlbumLink)
  await databaseClient.delete(schema.lastfmSync)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'album-fixture',
    slug: 'album-fixture',
    title: 'Album  Fixture',
    mediaType: 'album',
    metadata: { browse: { country: ['Synthetic'] } },
  })
  await databaseClient
    .insert(schema.album)
    .values({ mediaItemId: 'album-fixture' })
  await databaseClient
    .insert(schema.artist)
    .values({ id: 'artist-fixture', name: 'Artist fixture' })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: 'album-fixture',
    artistId: 'artist-fixture',
    role: 'artist',
  })
  await databaseClient.transaction((tx) =>
    replaceAlbumTracks(tx, 'album-fixture', [
      { title: 'First Track', position: 1 },
    ]),
  )
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function addAlbum(id: string, title: string) {
  await databaseClient
    .insert(schema.mediaItem)
    .values({ id, slug: id, title, mediaType: 'album' })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: id,
    artistId: 'artist-fixture',
    role: 'artist',
  })
}

describe('Last.fm scrobble sync jobs with offline HTTP and a temporary database', () => {
  it('runs as chained jobs, stores every dated scrobble, links albums and fills browse fields', async () => {
    const spotifyTrackId = 'firsttrack000000000000'
    await databaseClient.transaction((tx) =>
      replaceAlbumTracks(tx, 'album-fixture', [
        { title: 'First Track', position: 1, externalId: spotifyTrackId },
      ]),
    )
    const { getAlbumDetail } = await import('@/services/media')
    const [recording] = (await getAlbumDetail('album-fixture'))?.tracks ?? []
    if (!recording) throw new Error('Expected the stored album track')

    respond(
      page(1, 2, [
        nowPlaying,
        scrobble(recent, 'First track'),
        scrobble(old, 'First track'),
      ]),
      // A page holding one track arrives as a bare object.
      page(2, 2, scrobble(old - 60, 'Other', 'Unknown album')),
    )
    const status = await syncToEnd()

    expect(status).toMatchObject({
      configured: true,
      state: 'complete',
      pagesFetched: 2,
      totalPages: 2,
      newScrobbles: 3,
      storedScrobbles: 3,
      matchedScrobbles: 2,
      errorMessage: null,
    })
    const jobs = await syncJobs()
    expect(jobs.map((job) => [job.provider, job.status])).toEqual([
      ['lastfm', 'succeeded'],
      ['lastfm', 'succeeded'],
    ])
    expect(jobs[0]?.options).toMatchObject({ task: 'lastfm-scrobble-sync' })
    expect(jobs[1]?.options).toMatchObject({
      task: 'lastfm-scrobble-sync',
      continues: jobs[0]?.id,
    })
    expect(status.job).toEqual({ id: jobs[1]?.id, status: 'succeeded' })
    const { getJob, listJobs } = await import('@/services/jobs')
    const finished = await getJob(jobs[1]?.id ?? '')
    expect(finished?.items).toEqual([])
    expect(finished?.logs.at(-1)?.message).toBe(
      'Sync complete. 3 new scrobbles; 2 of 3 stored scrobbles are linked to albums.',
    )
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)

    expect(request).toHaveBeenCalledTimes(2)
    const first = requestedUrl(0).searchParams
    const second = requestedUrl(1).searchParams
    expect(first.get('method')).toBe('user.getRecentTracks')
    expect(first.get('user')).toBe('Fixture-Listener')
    expect(first.get('limit')).toBe('200')
    expect(first.get('page')).toBe('1')
    expect(first.has('from')).toBe(false)
    expect(second.get('page')).toBe('2')
    // The window is fixed for the run so page numbers cannot drift.
    expect(second.get('to')).toBe(first.get('to'))
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get('user-agent'),
    ).toBe('media-manager-lastfm-sync/1.0')

    const rows = await databaseClient.select().from(schema.lastfmScrobble)
    expect(rows.map((row) => row.username)).toEqual(
      Array(3).fill('fixture-listener'),
    )
    expect(
      await databaseClient.$count(
        schema.catalogObservation,
        eq(schema.catalogObservation.operation, 'scrobble'),
      ),
    ).toBe(0)
    expect(
      rows.find((row) => row.albumName === 'Unknown album')?.albumMediaItemId,
    ).toBeNull()
    expect(
      rows.find((row) => row.listenedAt.getTime() === old * 1000)
        ?.albumMediaItemId,
    ).toBe('album-fixture')

    const [item] = await databaseClient
      .select()
      .from(schema.mediaItem)
      .where(eq(schema.mediaItem.id, 'album-fixture'))
    expect(item?.metadata?.['browse']).toEqual({
      country: ['Synthetic'],
      scrobbles: 2,
      lastListenedAt: recent * 1000,
      scrobblesLast1y: 1,
      scrobblesLast5y: 1,
    })
    expect((await getAlbumDetail('album-fixture'))?.tracks).toMatchObject([
      {
        position: 1,
        track: {
          id: recording.track.id,
          sources: ['album', 'lastfm'],
          scrobbles: 2,
          spotifyTrackId,
        },
      },
    ])
  })

  it('returns the active job instead of queueing a second sync', async () => {
    const { queueLastfmSync } = await import('@/services/lastfm-sync-jobs')
    const first = await queueLastfmSync(null)
    const second = await queueLastfmSync(null)
    expect(first.state).toBe('running')
    expect(second.job).toEqual(first.job)
    expect(await syncJobs()).toHaveLength(1)
  })

  it('stores every page it reads on the job that read it, with the account name and without credentials', async () => {
    const credentialEcho = {
      session: { key: 'fixture-session-key' },
      note: 'Signed with offline-fixture-key',
    }
    respond(
      { ...page(1, 2, [scrobble(recent, 'First track')]), ...credentialEcho },
      { ...page(2, 2, [scrobble(old, 'First track')]), ...credentialEcho },
    )
    await syncToEnd()

    const jobs = await syncJobs()
    const stored = await storedResponses()
    expect(
      stored.map(({ jobId, phase, url, status }) => [
        jobId,
        phase,
        url,
        status,
      ]),
    ).toEqual(
      jobs.map((job) => [
        job.id,
        'task',
        'https://ws.audioscrobbler.com/2.0/',
        200,
      ]),
    )
    for (const [index, { text }] of stored.entries()) {
      expect(JSON.parse(text ?? 'null')).toEqual({
        ...page(index + 1, 2, [scrobble(index ? old : recent, 'First track')]),
        note: 'Signed with [REDACTED]',
      })
      expect(text).not.toContain('offline-fixture-key')
      expect(text).not.toContain('fixture-session-key')
    }
  })

  it('re-reads an overlap on the next sync without duplicating scrobbles', async () => {
    respond(page(1, 1, [scrobble(recent, 'First track')]))
    await syncToEnd()
    const firstTo = Number(requestedUrl(0).searchParams.get('to'))

    respond(
      page(1, 1, [
        scrobble(recent + 60, 'First track'),
        scrobble(recent, 'First track'),
      ]),
    )
    const status = await syncToEnd()

    expect(requestedUrl(1).searchParams.get('from')).toBe(
      String(firstTo - 7 * 24 * 60 * 60),
    )
    expect(status).toMatchObject({
      state: 'complete',
      newScrobbles: 1,
      storedScrobbles: 2,
    })
  })

  it('completes an empty window without storing anything', async () => {
    respond(page(1, 0, [nowPlaying]))
    const status = await syncToEnd()
    expect(status).toMatchObject({ state: 'complete', storedScrobbles: 0 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('fails the job on a rate limit without retrying, then resumes the same page and window', async () => {
    respond(page(1, 2, [scrobble(recent, 'First track')]), {
      error: 29,
      message: 'Rate limit exceeded',
    })
    const failed = await syncToEnd()

    expect(failed).toMatchObject({
      state: 'failed',
      pagesFetched: 1,
      storedScrobbles: 1,
      nextScheduledAt: null,
    })
    expect(failed.errorMessage).toBeTruthy()
    expect(failed.job?.status).toBe('failed')
    expect(request).toHaveBeenCalledTimes(2)
    const { listJobs } = await import('@/services/jobs')
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(1)
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety?.cooldownUntil?.getTime()).toBeGreaterThan(Date.now())

    const { queueLastfmSync, queueDueLastfmSync } =
      await import('@/services/lastfm-sync-jobs')
    await expect(queueLastfmSync(null)).rejects.toMatchObject({
      response: { statusCode: 429 },
    })
    // The schedule never resumes a failed run.
    expect(await queueDueLastfmSync(Date.now() + 365 * 86400000)).toBe(false)

    // The cooldown is cleared by hand, as an operator would in Providers.
    await databaseClient.delete(schema.providerRequestState)
    respond(page(2, 2, [scrobble(old, 'First track')]))
    const resumed = await syncToEnd()

    expect(resumed).toMatchObject({
      state: 'complete',
      pagesFetched: 2,
      newScrobbles: 2,
      storedScrobbles: 2,
    })
    expect(requestedUrl(2).searchParams.get('page')).toBe('2')
    expect(requestedUrl(2).searchParams.get('to')).toBe(
      requestedUrl(0).searchParams.get('to'),
    )
    const jobs = await syncJobs()
    expect(jobs.map((job) => job.status)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
    ])
    expect(jobs[1]?.options['retryJobId']).toBe(jobs[2]?.id)
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)
  })

  it('repeats a page after a temporary Last.fm failure without failing the job', async () => {
    request.mockImplementationOnce(
      async () => new Response('Internal error', { status: 500 }),
    )
    respond(
      { error: 8, message: 'Operation failed' },
      page(1, 1, [scrobble(recent, 'First track')]),
    )
    const status = await syncToEnd()

    expect(status).toMatchObject({
      state: 'complete',
      storedScrobbles: 1,
      job: { status: 'succeeded' },
    })
    expect(request).toHaveBeenCalledTimes(3)
    expect(requestedUrl(2).searchParams.get('page')).toBe('1')
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety).toMatchObject({ failureCount: 0, cooldownUntil: null })
    const logs = await databaseClient.select().from(schema.scrapeJobLog)
    expect(logs.filter((log) => log.level === 'warn')).toHaveLength(2)
  })

  it('fails the job when a temporary failure persists, without a provider cooldown', async () => {
    request.mockImplementation(async () =>
      Response.json({ error: 8, message: 'Operation failed' }),
    )
    const status = await syncToEnd()

    expect(status).toMatchObject({ state: 'failed', storedScrobbles: 0 })
    expect(status.errorMessage).toContain('temporary service error')
    expect(request).toHaveBeenCalledTimes(3)
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety?.cooldownUntil).toBeNull()

    const { queueLastfmSync } = await import('@/services/lastfm-sync-jobs')
    request.mockReset()
    respond(page(1, 1, [scrobble(recent, 'First track')]))
    await queueLastfmSync(null)
    expect(await drain()).toMatchObject({
      state: 'complete',
      storedScrobbles: 1,
    })
  })

  it('retries a failed sync job from the jobs API', async () => {
    respond(page(3, 5, [scrobble(recent, 'First track')]))
    const status = await syncToEnd()
    expect(status).toMatchObject({ state: 'failed', storedScrobbles: 0 })

    await databaseClient.delete(schema.providerRequestState)
    const { retryJob } = await import('@/services/jobs')
    const retry = await retryJob(status.job?.id ?? '', null, false)
    expect(retry.id).not.toBe(status.job?.id)
    respond(page(1, 1, [scrobble(recent, 'First track')]))
    expect(await drain()).toMatchObject({
      state: 'complete',
      storedScrobbles: 1,
      job: { id: retry.id, status: 'succeeded' },
    })
  })

  it('discards the in-flight page when the job is cancelled and resumes on request', async () => {
    const { bulkCancelJobs } = await import('@/services/jobs')
    request.mockImplementationOnce(async () =>
      Response.json(page(1, 3, [scrobble(recent, 'First track')])),
    )
    request.mockImplementationOnce(async () => {
      const running = (await syncJobs()).find((job) => job.status === 'running')
      await bulkCancelJobs(
        { jobIds: [running?.id ?? ''], confirmRunning: true },
        null,
      )
      return Response.json(page(2, 3, [scrobble(old, 'First track')]))
    })
    const stopped = await syncToEnd()
    expect(stopped).toMatchObject({
      state: 'stopped',
      pagesFetched: 1,
      storedScrobbles: 1,
      job: { status: 'cancelled' },
    })

    respond(
      page(2, 3, [scrobble(old, 'First track')]),
      page(3, 3, [scrobble(old - 60, 'First track')]),
    )
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      pagesFetched: 3,
      storedScrobbles: 3,
    })
    expect(requestedUrl(2).searchParams.get('page')).toBe('2')
  })

  it.each([
    { schedule: '10m', minutes: 10 },
    { schedule: '30m', minutes: 30 },
    { schedule: '1h', minutes: 60 },
    { schedule: '3h', minutes: 180 },
    { schedule: '6h', minutes: 360 },
    { schedule: 'daily', minutes: 1440 },
    { schedule: 'weekly', minutes: 10080 },
  ])(
    'queues a $schedule sync only when due after a completed sync',
    async ({ schedule, minutes }) => {
      const { LastfmSyncScheduleSchema } = await import('@repo/schemas/lastfm')
      const { getLastfmSyncStatus, setLastfmSyncSchedule } =
        await import('@/services/lastfm-scrobbles')
      const { queueDueLastfmSync } = await import('@/services/lastfm-sync-jobs')
      const day = 24 * 60 * 60 * 1000

      // The setting can be saved first, but the schedule never starts the first sync.
      expect(await setLastfmSyncSchedule('weekly')).toMatchObject({
        state: 'never',
        schedule: 'weekly',
        nextScheduledAt: null,
        startedAt: null,
      })
      queries.length = 0
      expect(await queueDueLastfmSync(Date.now() + 365 * day)).toBe(false)
      expect(
        queries.some((query) => query.includes('from lastfm_scrobble')),
      ).toBe(false)

      respond(page(1, 1, [scrobble(recent, 'First track')]))
      const complete = await syncToEnd()
      const completedAt = Date.parse(complete.lastCompletedAt ?? '')
      expect(complete.nextScheduledAt).toBe(
        new Date(completedAt + 7 * day).toISOString(),
      )
      expect((await setLastfmSyncSchedule('off')).nextScheduledAt).toBeNull()
      queries.length = 0
      expect(await queueDueLastfmSync(completedAt + 365 * day)).toBe(false)
      expect(
        queries.some((query) => query.includes('from lastfm_scrobble')),
      ).toBe(false)
      const interval = minutes * 60 * 1000
      expect(
        (await setLastfmSyncSchedule(LastfmSyncScheduleSchema.parse(schedule)))
          .nextScheduledAt,
      ).toBe(new Date(completedAt + interval).toISOString())

      queries.length = 0
      expect(await queueDueLastfmSync(completedAt + interval - 1000)).toBe(
        false,
      )
      expect(await queueDueLastfmSync(completedAt + interval)).toBe(true)
      expect(await queueDueLastfmSync(completedAt + interval + day)).toBe(false)
      expect(
        queries.some((query) => query.includes('from lastfm_scrobble')),
      ).toBe(false)
      expect(await getLastfmSyncStatus()).toMatchObject({
        state: 'running',
        schedule,
        nextScheduledAt: null,
      })
      respond(page(1, 0, []))
      expect((await drain()).state).toBe('complete')
      expect(await syncJobs()).toHaveLength(2)
    },
  )

  it('reports how each scrobbled artist and album name is linked', async () => {
    const { getLastfmLinkReport, relinkLastfmScrobbles } =
      await import('@/services/lastfm-scrobbles')
    await addAlbum('twin-a', 'Twin album')
    await addAlbum('twin-b', 'Twin Album')
    respond(
      page(1, 1, [
        scrobble(recent, 'First track'),
        scrobble(recent - 10, 'First track'),
        scrobble(recent - 20, 'First track'),
        scrobble(recent - 30, 'Second', 'Album fixture', 'Other artist'),
        scrobble(recent - 40, 'Second', 'Album fixture', 'Other artist'),
        scrobble(recent - 50, 'Third', 'Twin album'),
        scrobble(recent - 60, 'Fourth', 'Late album'),
        scrobble(recent - 70, 'Fifth', 'Unknown album'),
        scrobble(recent - 80, 'Sixth', ''),
        scrobble(recent - 90, 'Seventh', 'Album Fixture (Deluxe Edition)'),
      ]),
    )
    await syncToEnd()
    await addAlbum('late-album', 'Late Album')

    const fixture = {
      id: 'album-fixture',
      slug: 'album-fixture',
      title: 'Album  Fixture',
      artists: ['Artist fixture'],
    }
    const report = await getLastfmLinkReport()
    expect(report).toMatchObject({ totalCount: 7, page: 1, pageCount: 1 })
    expect(
      Object.fromEntries(
        report.summary.map((row) => [row.reason, [row.groups, row.scrobbles]]),
      ),
    ).toEqual({
      linked: [2, 4],
      unmatched: [3, 4],
      ambiguous: [1, 1],
      'no-album': [1, 1],
    })
    expect(report.items[0]).toEqual({
      spotifySearch: null,
      artistName: 'Artist fixture',
      albumName: 'Album fixture',
      scrobbles: 3,
      lastListenedAt: new Date(recent * 1000).toISOString(),
      reason: 'linked',
      album: fixture,
      strategy: 'exact',
      candidates: [],
    })
    // The same title under an artist the album does not credit, with no shared track.
    expect(report.items[1]).toMatchObject({
      artistName: 'Other artist',
      reason: 'unmatched',
      album: null,
      strategy: null,
      candidates: [],
    })
    const named = (albumName: string | null) =>
      report.items.find((item) => item.albumName === albumName)
    expect(named('Album Fixture (Deluxe Edition)')).toMatchObject({
      reason: 'linked',
      strategy: 'edition',
      album: fixture,
    })
    expect(named('Twin album')).toMatchObject({ reason: 'ambiguous' })
    expect(named('Twin album')?.candidates.map((album) => album.id)).toEqual([
      'twin-a',
      'twin-b',
    ])
    expect(named('Late album')).toMatchObject({ reason: 'unmatched' })
    expect(named(null)?.reason).toBe('no-album')

    const unlinked = await getLastfmLinkReport({ reason: 'unlinked', size: 2 })
    expect(unlinked).toMatchObject({ totalCount: 5, pageCount: 3 })
    expect(unlinked.items).toHaveLength(2)
    expect(unlinked.summary).toEqual(report.summary)
    const statuses = { reasons: ['ambiguous', 'no-album'], size: 1 }
    const firstStatus = await getLastfmLinkReport(statuses)
    const secondStatus = await getLastfmLinkReport({ ...statuses, page: 2 })
    expect(firstStatus).toMatchObject({ totalCount: 2, pageCount: 2 })
    expect(
      [...firstStatus.items, ...secondStatus.items]
        .map((item) => item.reason)
        .sort(),
    ).toEqual(['ambiguous', 'no-album'])
    const searched = await getLastfmLinkReport({ q: 'other art' })
    expect(searched.items.map((item) => item.artistName)).toEqual([
      'Other artist',
    ])

    // Relinking applies the album added after the sync without any request.
    const relinked = await relinkLastfmScrobbles()
    expect(relinked.matchedScrobbles).toBe(5)
    expect(request).toHaveBeenCalledTimes(1)
    const late = await getLastfmLinkReport({ q: 'late album' })
    expect(late.items[0]).toMatchObject({ reason: 'linked', strategy: 'exact' })
  })

  it('keeps manual links and exclusions across relinks until returned to automatic matching', async () => {
    const {
      getAlbumListening,
      getLastfmLinkReport,
      relinkLastfmScrobbles,
      setLastfmAlbumLink,
    } = await import('@/services/lastfm-scrobbles')
    respond(
      page(1, 1, [
        scrobble(recent, 'First track'),
        scrobble(recent - 10, 'First track'),
        scrobble(recent - 20, 'Second', 'Another title', 'Other artist'),
      ]),
    )
    expect((await syncToEnd()).matchedScrobbles).toBe(2)
    const other = { artistName: 'Other artist', albumName: 'Another title' }
    const own = { artistName: 'Artist fixture', albumName: 'Album fixture' }
    const reason = async (q: string) =>
      (await getLastfmLinkReport({ q })).items[0]?.reason

    const linked = await setLastfmAlbumLink({
      action: 'link',
      ...other,
      albumId: 'album-fixture',
    })
    expect(linked.matchedScrobbles).toBe(3)
    expect(await reason('another title')).toBe('manual')
    expect((await getAlbumListening('album-fixture')).sources).toEqual([
      { ...own, count: 2, manual: false },
      { ...other, count: 1, manual: true },
    ])
    const [item] = await databaseClient
      .select({ metadata: schema.mediaItem.metadata })
      .from(schema.mediaItem)
      .where(eq(schema.mediaItem.id, 'album-fixture'))
    expect(item?.metadata).toMatchObject({ browse: { scrobbles: 3 } })

    const excluded = await setLastfmAlbumLink({ action: 'unlink', ...own })
    expect(excluded.matchedScrobbles).toBe(1)
    expect(await reason('album fixture')).toBe('excluded')

    expect((await relinkLastfmScrobbles()).matchedScrobbles).toBe(1)
    expect(await reason('another title')).toBe('manual')
    expect(await reason('album fixture')).toBe('excluded')

    await setLastfmAlbumLink({ action: 'auto', ...other })
    const automatic = await setLastfmAlbumLink({ action: 'auto', ...own })
    expect(automatic.matchedScrobbles).toBe(2)
    expect(await reason('another title')).toBe('unmatched')
    expect(await reason('album fixture')).toBe('linked')

    await expect(
      setLastfmAlbumLink({ action: 'link', ...other, albumId: 'missing' }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      setLastfmAlbumLink({
        action: 'unlink',
        artistName: 'Nobody',
        albumName: 'Nothing',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a reviewed listening link only while it still points to that album', async () => {
    const { relinkLastfmScrobbles, setLastfmAlbumLink } =
      await import('@/services/lastfm-scrobbles')
    const { getMediaSources } = await import('@/services/history')
    respond(page(1, 1, [scrobble(recent, 'First track')]))
    expect((await syncToEnd()).matchedScrobbles).toBe(1)
    const group = { artistName: 'Artist fixture', albumName: 'Album fixture' }
    await expect(
      setLastfmAlbumLink({
        action: 'unlink',
        ...group,
        expectedAlbumId: 'previous-album',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    for (const attempt of [1, 2]) {
      const result = await setLastfmAlbumLink({
        action: 'unlink',
        ...group,
        expectedAlbumId: 'album-fixture',
      })
      expect(result.matchedScrobbles, `attempt ${attempt}`).toBe(0)
    }
    const history = (await getMediaSources('album-fixture')).changes
    expect(
      history.filter(
        (change) => change.title === 'Last.fm listening match rejected',
      ),
    ).toHaveLength(1)
    expect((await relinkLastfmScrobbles()).matchedScrobbles).toBe(0)
    expect(
      await databaseClient
        .select({ id: schema.lastfmScrobble.id })
        .from(schema.lastfmScrobble),
    ).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports album listening by month and by track with its scrobbled names', async () => {
    const { getAlbumListening } = await import('@/services/lastfm-scrobbles')
    respond(
      page(1, 1, [
        scrobble(recent, 'First track'),
        scrobble(old + 120, 'Bonus track'),
        scrobble(old, 'First track'),
        scrobble(old - 60, 'Elsewhere', 'Album fixture sessions'),
        scrobble(old - 120, 'Elsewhere', 'Album fixture', 'Other artist'),
        scrobble(old - 180, 'Elsewhere', 'Unrelated'),
      ]),
    )
    await syncToEnd()

    const all = await getAlbumListening('album-fixture')
    expect(all.total).toBe(3)
    expect(all.firstListenedAt).toBe(new Date(old * 1000).toISOString())
    expect(all.lastListenedAt).toBe(new Date(recent * 1000).toISOString())
    expect(all.months[0]).toEqual({ month: '2015-05', count: 2 })
    expect(all.months).toHaveLength(2)
    const [listed] = await databaseClient.select().from(schema.track)
    if (!listed) throw new Error('Missing fixture album track')
    expect(all.tracks).toEqual([
      {
        key: 'first track',
        trackId: listed.trackMediaItemId,
        title: 'First Track',
        position: 1,
        count: 2,
        lastListenedAt: new Date(recent * 1000).toISOString(),
      },
      {
        key: 'bonus track',
        title: 'Bonus track',
        position: null,
        count: 1,
        lastListenedAt: new Date((old + 120) * 1000).toISOString(),
      },
    ])
    expect(all.sources).toEqual([
      {
        artistName: 'Artist fixture',
        albumName: 'Album fixture',
        count: 3,
        manual: false,
      },
    ])
    expect(
      all.similarUnlinked.map((item) => [item.artistName, item.albumName]),
    ).toEqual([
      ['Artist fixture', 'Album fixture sessions'],
      ['Other artist', 'Album fixture'],
    ])

    const bonus = await getAlbumListening('album-fixture', 'bonus track')
    expect(bonus.total).toBe(1)
    expect(bonus.months).toEqual([{ month: '2015-05', count: 1 }])
    expect(bonus.tracks).toHaveLength(2)
    expect((await getAlbumListening('missing')).total).toBe(0)
  })

  it('groups confirmed track names on the album and filters all their plays together', async () => {
    const { getAlbumListening, setLastfmAlbumLink } =
      await import('@/services/lastfm-scrobbles')
    respond(
      page(1, 1, [
        scrobble(recent, '01. First Track'),
        scrobble(old + 120, 'First Track', 'Album fixture (Deluxe Edition)'),
        scrobble(old, 'First Track'),
        scrobble(old - 60, 'First Track', 'Unknown album'),
        scrobble(old - 120, 'First Track', 'Other release', 'Other artist'),
        scrobble(old - 180, 'First Track (Remastered)'),
      ]),
    )
    await syncToEnd()
    await setLastfmAlbumLink({
      action: 'link',
      artistName: 'Other artist',
      albumName: 'Other release',
      albumId: 'album-fixture',
    })

    const [listed] = await databaseClient.select().from(schema.track)
    if (!listed) throw new Error('Missing fixture album track')
    const matched = await databaseClient.select().from(schema.lastfmTrackSource)
    expect(
      matched.find(
        (row) =>
          row.trackKey === 'first track' && row.artistKey === 'artist fixture',
      )?.trackMediaItemId,
    ).not.toBe(listed.trackMediaItemId)
    await databaseClient
      .update(schema.lastfmTrackSource)
      .set({ trackMediaItemId: listed.trackMediaItemId, manuallyMatched: true })
      .where(eq(schema.lastfmTrackSource.trackKey, '01. first track'))
    await databaseClient
      .update(schema.lastfmTrackSource)
      .set({ manuallyMatched: true })
      .where(eq(schema.lastfmTrackSource.trackKey, 'first track (remastered)'))

    const all = await getAlbumListening('album-fixture')
    expect(all.total).toBe(5)
    expect(all.tracks).toMatchObject([
      {
        title: 'First Track',
        trackId: listed.trackMediaItemId,
        position: 1,
        count: 3,
      },
      { title: 'First Track (Remastered)', position: null, count: 1 },
      { title: 'First Track', position: null, count: 1 },
    ])
    expect(
      all.sources.map(({ albumName, count }) => [albumName, count]),
    ).toEqual([
      ['Album fixture', 3],
      ['Album fixture (Deluxe Edition)', 1],
      ['Other release', 1],
    ])
    const [combined, remastered, unrelated] = all.tracks
    if (!combined || !unrelated)
      throw new Error('Missing fixture listening rows')
    expect(combined.key).not.toBe(unrelated.key)
    expect(unrelated.trackId).toBeUndefined()
    expect(remastered?.trackId).toBeUndefined()
    const selected = await getAlbumListening('album-fixture', combined.key)
    expect(selected.total).toBe(3)
    expect(selected.months).toEqual([
      { month: '2015-05', count: 2 },
      { month: new Date(recent * 1000).toISOString().slice(0, 7), count: 1 },
    ])
    expect(
      (await getAlbumListening('album-fixture', unrelated.key)).total,
    ).toBe(1)
    expect(
      (await getAlbumListening('album-fixture', '01. first track')).total,
    ).toBe(3)
    expect(
      (await getAlbumListening('album-fixture', 'first track')).total,
    ).toBe(3)
  })
})
