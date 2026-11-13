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
import { env } from '@/env'
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
const databaseClient = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'lastfm' ? lastfmPlugin : null,
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
  await databaseClient.insert(schema.track).values({
    id: 'track-fixture',
    albumMediaItemId: 'album-fixture',
    title: 'First Track',
    position: 1,
  })
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
    expect(jobs[0]?.options).toEqual({ task: 'lastfm-scrobble-sync' })
    expect(jobs[1]?.options).toEqual({
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
      rows.find((row) => row.albumName === 'Unknown album')?.albumMediaItemId,
    ).toBeNull()
    expect(
      rows.find((row) => row.listenedAt.getTime() === old * 1000)
        ?.albumMediaItemId,
    ).toBe('album-fixture')

    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata?.['browse']).toEqual({
      country: ['Synthetic'],
      scrobbles: 2,
      lastListenedAt: recent * 1000,
      scrobblesLast1y: 1,
      scrobblesLast5y: 1,
    })
  })

  it('returns the active job instead of queueing a second sync', async () => {
    const { queueLastfmSync } = await import('@/services/lastfm-sync-jobs')
    const first = await queueLastfmSync(null)
    const second = await queueLastfmSync(null)
    expect(first.state).toBe('running')
    expect(second.job).toEqual(first.job)
    expect(await syncJobs()).toHaveLength(1)
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
      expect(await queueDueLastfmSync(Date.now() + 365 * day)).toBe(false)

      respond(page(1, 1, [scrobble(recent, 'First track')]))
      const complete = await syncToEnd()
      const completedAt = Date.parse(complete.lastCompletedAt ?? '')
      expect(complete.nextScheduledAt).toBe(
        new Date(completedAt + 7 * day).toISOString(),
      )
      expect((await setLastfmSyncSchedule('off')).nextScheduledAt).toBeNull()
      expect(await queueDueLastfmSync(completedAt + 365 * day)).toBe(false)
      const interval = minutes * 60 * 1000
      expect(
        (await setLastfmSyncSchedule(LastfmSyncScheduleSchema.parse(schedule)))
          .nextScheduledAt,
      ).toBe(new Date(completedAt + interval).toISOString())

      expect(await queueDueLastfmSync(completedAt + interval - 1000)).toBe(
        false,
      )
      expect(await queueDueLastfmSync(completedAt + interval)).toBe(true)
      expect(await queueDueLastfmSync(completedAt + interval + day)).toBe(false)
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
    expect(all.tracks).toEqual([
      {
        key: 'first track',
        title: 'First track',
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
})
