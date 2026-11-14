import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { LASTFM_SPOTIFY_SEARCH_TASK } from '@repo/schemas/lastfm'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import {
  spotifyAlbumFixture,
  spotifyTokenFixture,
} from '@/plugins/builtin/__tests__/fixtures/spotify'
import { albumNameKey } from '@/lib/album-import-candidates'

const database = `lastfm_search_${randomUUID().replaceAll('-', '')}`
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
let account = 'fixture-listener'
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'spotify' ? spotifyPlugin : id === 'lastfm' ? lastfmPlugin : null,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'fixture-client',
    clientSecret: 'fixture-secret',
    apiKey: 'fixture-key',
    username: account,
  }),
}))
import {
  queueLastfmSpotifySearches,
  getLastfmSpotifySearch,
} from '@/services/lastfm-spotify-search'
import {
  bulkRetryJobs,
  bulkCancelJobs,
  getJob,
  listJobs,
  processQueuedJobs,
  retryJob,
} from '@/services/jobs'
import { getJobData } from '@/services/job-data'
import {
  getLastfmLinkReport,
  setLastfmAlbumLink,
} from '@/services/lastfm-scrobbles'

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  account = 'fixture-listener'
  request.mockReset()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === '/v1/search')
      return Response.json({
        albums: { items: [spotifyAlbumFixture()], total: 1, offset: 0 },
      })
    throw new Error('Unexpected offline provider request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.lastfmAlbumLink)
  await databaseClient.delete(schema.lastfmSync)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const group = { artistName: 'Example Artist', albumName: 'Example Album' }
async function addGroup(
  albumName = group.albumName,
  artistName = group.artistName,
  username = account,
) {
  await databaseClient.insert(schema.lastfmScrobble).values({
    id: randomUUID(),
    username,
    listenedAt: new Date('2026-01-01T12:00:00Z'),
    artistName,
    albumName,
    trackName: 'Opening',
    artistKey: albumNameKey(artistName),
    albumKey: albumNameKey(albumName),
    trackKey: 'opening',
  })
  return { artistName, albumName }
}
async function addLibraryAlbum() {
  await databaseClient.insert(schema.mediaItem).values({
    id: 'library-album',
    slug: 'library-album',
    title: 'Library album',
    mediaType: 'album',
  })
  await databaseClient
    .insert(schema.album)
    .values({ mediaItemId: 'library-album' })
}
async function cancelJob(id: string, userId: string | null) {
  await bulkCancelJobs({ jobIds: [id], confirmRunning: true }, userId)
}
async function queuedId() {
  const [job] = await databaseClient.select().from(schema.scrapeJob)
  if (!job) throw new Error('Expected a queued search')
  return job.id
}

describe('scrobbled album Spotify searches through persistent jobs', () => {
  it('queues each explicit unlinked group once, skips active/linked/missing targets and does not search during queueing or reads', async () => {
    await addGroup()
    const second = await addGroup('Second Album')
    const linked = await addGroup('Linked Album')
    await addLibraryAlbum()
    await setLastfmAlbumLink({
      ...linked,
      action: 'link',
      albumId: 'library-album',
    })
    const result = await queueLastfmSpotifySearches(
      {
        groups: [
          group,
          second,
          group,
          linked,
          { ...group, albumName: 'Missing' },
        ],
        batchId: 'fixture-batch',
      },
      null,
    )
    expect(result).toMatchObject({
      queued: 2,
      skipped: 3,
      batchId: 'fixture-batch',
    })
    expect(
      await queueLastfmSpotifySearches({ groups: [group] }, null),
    ).toMatchObject({ queued: 0, skipped: 1 })
    const jobs = await listJobs({
      mediaType: 'album',
      batchId: 'fixture-batch',
    })
    expect(jobs.items).toHaveLength(2)
    expect((await listJobs({ q: 'Second Album' })).items).toHaveLength(1)
    expect(
      jobs.items.every(
        (job) =>
          job.items.length === 0 &&
          job.options.task === LASTFM_SPOTIFY_SEARCH_TASK,
      ),
    ).toBe(true)
    expect((await getLastfmSpotifySearch(group)).job?.status).toBe('queued')
    expect(
      (await getLastfmLinkReport()).items.find(
        (item) => item.albumName === group.albumName,
      )?.spotifySearch?.status,
    ).toBe('queued')
    expect(request).not.toHaveBeenCalled()
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
  })

  it('deduplicates concurrent queue requests for the same normalized group', async () => {
    await addGroup()
    const results = await Promise.all([
      queueLastfmSpotifySearches({ groups: [group] }, null),
      queueLastfmSpotifySearches(
        {
          groups: [
            { artistName: 'EXAMPLE   ARTIST', albumName: 'example album' },
          ],
        },
        null,
      ),
    ])
    expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(1)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('persists candidates only on the originating job, reuses them without requests and never adds library albums', async () => {
    await addGroup()
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    const id = await queuedId()
    await processQueuedJobs()
    expect(await getJob(id)).toMatchObject({
      status: 'succeeded',
      errorMessage: null,
    })
    expect(request).toHaveBeenCalledTimes(2)
    const stored = await getLastfmSpotifySearch(group)
    expect(stored).toMatchObject({
      job: { jobId: id, status: 'succeeded', resultCount: 1 },
      query: 'Example Artist Example Album',
      result: { items: [{ title: 'Example Album' }] },
    })
    expect((await getJobData(id)).diagnostics[0]?.data).toMatchObject([
      {
        kind: LASTFM_SPOTIFY_SEARCH_TASK,
        result: { items: [{ title: 'Example Album' }] },
      },
    ])
    expect(await databaseClient.select().from(schema.mediaItem)).toEqual([])
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
    await getLastfmSpotifySearch(group)
    expect(request).toHaveBeenCalledTimes(2)
    const events = await databaseClient
      .select()
      .from(schema.providerRequestEvent)
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.provider === 'spotify')).toBe(true)
    account = 'different-fixture-listener'
    expect((await getLastfmSpotifySearch(group)).job).toBeNull()
  })

  it('retains a Spotify rate-limit failure and leaves later searches queued without retrying', async () => {
    await addGroup()
    const second = await addGroup('Second Album')
    await queueLastfmSpotifySearches({ groups: [group, second] }, null)
    request.mockImplementation(async (input) =>
      new URL(String(input)).hostname === 'accounts.spotify.com'
        ? Response.json(spotifyTokenFixture)
        : Response.json(
            { error: { message: 'Rate limit exceeded' } },
            { status: 429, headers: { 'retry-after': '60' } },
          ),
    )
    await processQueuedJobs()
    expect(request).toHaveBeenCalledTimes(2)
    expect((await getLastfmSpotifySearch(group)).job?.status).toBe('failed')
    expect((await getLastfmSpotifySearch(second)).job?.status).toBe('queued')
    expect((await getLastfmSpotifySearch(group)).result).toBeNull()
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety?.cooldownUntil?.getTime()).toBeGreaterThan(Date.now())
  })

  it('clears deleted library identities when reopening saved candidates', async () => {
    await addGroup()
    await addLibraryAlbum()
    await databaseClient.insert(schema.providerReference).values({
      id: 'fixture-reference',
      provider: 'spotify',
      mediaItemId: 'library-album',
      referenceType: 'album',
      externalId: spotifyAlbumFixture().id,
    })
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    await processQueuedJobs()
    expect(
      (await getLastfmSpotifySearch(group)).result?.items[0]?.mediaItemId,
    ).toBe('library-album')
    await databaseClient
      .delete(schema.mediaItem)
      .where(eq(schema.mediaItem.id, 'library-album'))
    expect(
      (await getLastfmSpotifySearch(group)).result?.items[0]?.mediaItemId,
    ).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('honours provider cooldowns and retries a cancelled search with its exact target', async () => {
    await addGroup()
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'spotify',
      cooldownUntil: new Date(Date.now() + 60000),
    })
    await expect(
      queueLastfmSpotifySearches({ groups: [group] }, null),
    ).rejects.toMatchObject({ response: { statusCode: 429 } })
    expect(await databaseClient.select().from(schema.scrapeJob)).toEqual([])
    await databaseClient.delete(schema.providerRequestState)
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    const id = await queuedId()
    await cancelJob(id, null)
    const retry = await retryJob(id, null, false)
    expect(retry.options).toMatchObject({
      task: LASTFM_SPOTIFY_SEARCH_TASK,
      ...group,
      retryOf: id,
    })
    expect(retry.options.resultCount).toBeUndefined()
    expect(retry.id).not.toBe(id)
    await processQueuedJobs()
    expect((await getLastfmSpotifySearch(group)).job?.jobId).toBe(retry.id)
    expect((await getLastfmSpotifySearch(group)).job?.status).toBe('succeeded')
  })

  it('links a retry to another active search for that target instead of allowing a later duplicate retry', async () => {
    await addGroup()
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    const originalId = await queuedId()
    await cancelJob(originalId, null)
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    const active = await retryJob(originalId, null, false)
    expect(active.id).not.toBe(originalId)
    expect((await getJob(originalId))?.options.retryJobId).toBe(active.id)
    await processQueuedJobs()
    expect((await retryJob(originalId, null, false)).id).toBe(active.id)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('discards a result arriving after cancellation and does not record cancellation as a provider failure', async () => {
    await addGroup()
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    const id = await queuedId()
    let release: (response: Response) => void = () => {
      throw new Error('Search has not started')
    }
    const response = new Promise<Response>((resolve) => {
      release = resolve
    })
    let started: () => void = () => {}
    const searching = new Promise<void>((resolve) => {
      started = resolve
    })
    request.mockImplementation(async (input) => {
      if (new URL(String(input)).hostname === 'accounts.spotify.com')
        return Response.json(spotifyTokenFixture)
      started()
      return response
    })
    const processing = processQueuedJobs()
    await Promise.race([
      searching,
      processing.then(() => {
        throw new Error('Job finished before the search request')
      }),
    ])
    await cancelJob(id, null)
    release(
      Response.json({
        albums: { items: [spotifyAlbumFixture()], total: 1, offset: 0 },
      }),
    )
    await processing
    expect(await getLastfmSpotifySearch(group)).toMatchObject({
      job: { status: 'cancelled', resultCount: null },
      result: null,
    })
    expect((await getJobData(id)).diagnostics).toEqual([])
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety?.failureCount).toBe(0)
  })

  it('skips groups linked before execution and fences a changed Last.fm account', async () => {
    await addGroup()
    await queueLastfmSpotifySearches({ groups: [group] }, null)
    await addLibraryAlbum()
    await setLastfmAlbumLink({
      ...group,
      action: 'link',
      albumId: 'library-album',
    })
    await processQueuedJobs()
    expect(request).not.toHaveBeenCalled()
    expect((await getLastfmSpotifySearch(group)).result).toBeNull()
    const other = await addGroup('Other Album')
    await queueLastfmSpotifySearches({ groups: [other] }, null)
    account = 'changed-fixture-account'
    await processQueuedJobs()
    expect(request).not.toHaveBeenCalled()
    expect(
      (await databaseClient.select().from(schema.scrapeJob)).some(
        (job) => job.status === 'failed',
      ),
    ).toBe(true)
  })

  it('requires broad confirmation for queueing and retrying more than five searches', async () => {
    const groups = await Promise.all(
      Array.from({ length: 6 }, (_, index) => addGroup(`Album ${index}`)),
    )
    await expect(queueLastfmSpotifySearches({ groups }, null)).rejects.toThrow()
    expect(await databaseClient.select().from(schema.scrapeJob)).toEqual([])
    await queueLastfmSpotifySearches({ groups, confirmBroadRun: true }, null)
    const jobs = await databaseClient.select().from(schema.scrapeJob)
    for (const job of jobs) await cancelJob(job.id, null)
    await expect(
      bulkRetryJobs(
        { jobIds: jobs.map((job) => job.id), confirmBroadRun: false },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    expect(request).not.toHaveBeenCalled()
  })

  it('sorts the whole filtered report before pagination, with a stable name tiebreak', async () => {
    await addGroup('Z album', 'A artist')
    await addGroup('A album', 'Z artist')
    const first = await getLastfmLinkReport({
      sortBy: 'albumName',
      sortDirection: 'asc',
      size: 1,
      reason: 'unlinked',
    })
    const second = await getLastfmLinkReport({
      sortBy: 'albumName',
      sortDirection: 'asc',
      size: 1,
      page: 2,
      reason: 'unlinked',
    })
    expect(first.items[0]?.albumName).toBe('A album')
    expect(second.items[0]?.albumName).toBe('Z album')
    expect(first.totalCount).toBe(2)
    expect(request).not.toHaveBeenCalled()
  })
})

it('sorts library albums and stored Spotify results across the full report without provider requests', async () => {
  const linked = await addGroup('Z linked')
  const queued = await addGroup('A queued')
  await addGroup('B not searched')
  await addLibraryAlbum()
  await setLastfmAlbumLink({
    ...linked,
    action: 'link',
    albumId: 'library-album',
  })
  await queueLastfmSpotifySearches(
    { groups: [queued], confirmBroadRun: false },
    null,
  )
  const albumPage = await getLastfmLinkReport({
    sortBy: 'libraryAlbum',
    sortDirection: 'asc',
    size: 1,
  })
  expect(albumPage.items[0]?.albumName).toBe('Z linked')
  const searchPage = await getLastfmLinkReport({
    sortBy: 'spotifySearch',
    sortDirection: 'desc',
    size: 1,
  })
  expect(searchPage.items[0]?.albumName).toBe('A queued')
  expect(searchPage.items[0]?.spotifySearch?.status).toBe('queued')
  expect(searchPage.totalCount).toBe(3)
  expect(request).not.toHaveBeenCalled()
})
