import '@hono/zod-openapi'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import {
  SPOTIFY_TRACK_SEARCH_TASK,
  type SpotifyTrackSearchFreshness,
} from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import { encryptSecretValue } from '@/lib/crypto'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import * as schema from '@/schemas/db'

const database = `spotify_track_search_${randomUUID().replaceAll('-', '')}`
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
const userId = 'fixture-owner'
const otherUserId = 'fixture-other'
const recordingId = 'fixture-track'
const candidateId = 'catalogtrack0000000000'
const title = 'Night Signal: Live'
const artistName = 'Example Artist'
let market: string | undefined
let clientSecret: string | undefined
const searchBody = {
  tracks: {
    offset: 0,
    items: [
      {
        type: 'track',
        id: candidateId,
        name: title,
        duration_ms: 174000,
        artists: [{ id: 'catalogartist000000000', name: artistName }],
        album: {
          id: 'catalogalbum0000000000',
          name: 'Example Album',
          images: [{ url: 'https://i.scdn.co/image/fixture' }],
        },
        external_ids: { isrc: 'aa-fi1-20-00001' },
      },
      { type: 'track', id: null },
    ],
  },
}

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        if (!headers.has('cookie')) return null
        return {
          user: { id: userId, email: 'owner@example.test' },
          session: { userId },
        }
      },
    },
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'spotify' ? spotifyPlugin : null,
  listLoadedScrapePlugins: async () => [spotifyPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'fixture-client',
    redirectUri: 'https://fixture.example.test/api/v1/spotify/callback',
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(market === undefined ? {} : { market }),
  }),
}))

import {
  bulkCancelJobs,
  getJob,
  getJobActivity,
  listJobs,
  processQueuedJobs,
  retryJob,
} from '@/services/jobs'
import { listJobEntries } from '@/services/job-entries'
import { listTrackMatchDiagnostics } from '@/services/track-match-diagnostics'
import {
  getSpotifyTrackSearch,
  listSpotifyTrackSearchStatuses,
  queueSpotifyTrackSearches,
  readSpotifyTrackSearchCandidate,
} from '@/services/spotify-track-search'

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.user).values([
    { id: userId, name: 'Fixture Owner', email: 'owner@example.test' },
    { id: otherUserId, name: 'Other Fixture', email: 'other@example.test' },
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  market = 'AU'
  clientSecret = 'fixture-secret'
  request.mockReset()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (
      url.origin === 'https://api.spotify.com' &&
      url.pathname === '/v1/search'
    )
      return Response.json(searchBody)
    throw new Error('Unexpected offline provider request')
  })
  await fixture.delete(schema.scrapeJob)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.delete(schema.providerRequestState)
  await fixture.delete(schema.providerRequestEvent)
  await fixture.delete(schema.providerSecret)
  await fixture
    .insert(schema.artist)
    .values({ id: 'fixture-artist', name: artistName })
  await addTrack(recordingId, title)
})

async function addTrack(id: string, name: string, spotifyTrackId?: string) {
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: name,
    mediaType: 'track',
    sourceLabel: 'album',
  })
  await fixture
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, spotifyTrackId })
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId: 'fixture-artist', role: 'artist' })
}

async function queueOne(freshness?: SpotifyTrackSearchFreshness) {
  await queueSpotifyTrackSearches(
    { trackIds: [recordingId], batchId: 'fixture-batch', freshness },
    userId,
  )
  const [job] = (await listJobs({ mediaType: 'track' })).items
  if (!job) throw new Error('Expected a queued Spotify track search')
  return job
}

it('queues explicit tracks once across concurrent selections and keeps the batch in Tracks Jobs', async () => {
  const second = 'fixture-second'
  const covered = 'fixture-covered'
  await addTrack(second, 'Second Recording')
  await addTrack(covered, 'Already Covered', candidateId)
  const results = await Promise.all([
    queueSpotifyTrackSearches(
      {
        trackIds: [recordingId, second, covered, 'missing', recordingId],
        batchId: 'fixture-batch',
      },
      userId,
    ),
    queueSpotifyTrackSearches(
      { trackIds: [second], batchId: 'fixture-batch' },
      userId,
    ),
  ])
  expect(results.reduce((total, result) => total + result.queued, 0)).toBe(2)
  expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(4)
  expect((await listJobs({ mediaType: 'album' })).items).toEqual([])
  expect(
    (await listJobs({ mediaType: 'track', q: 'night signal' })).items,
  ).toMatchObject([
    {
      scope: { mediaType: 'track', mediaItemIds: [recordingId] },
      options: { task: SPOTIFY_TRACK_SEARCH_TASK, trackId: recordingId },
      items: [],
    },
  ])
  expect((await listJobEntries({ mediaType: 'track' })).items).toMatchObject([
    { kind: 'batch', batchId: 'fixture-batch', mediaType: 'track', total: 2 },
  ])
  expect(
    (await getJobActivity()).libraries.find(
      (entry) => entry.mediaType === 'track',
    ),
  ).toMatchObject({ queued: 2, running: 0, failed: 0 })
  expect(
    (
      await listSpotifyTrackSearchStatuses(
        { trackIds: [recordingId, covered] },
        userId,
      )
    ).items,
  ).toMatchObject([
    {
      trackId: recordingId,
      job: { status: 'queued' },
      lastAttemptAt: null,
      lastSuccessfulAt: null,
    },
    { trackId: covered, job: null },
  ])
  expect(request).not.toHaveBeenCalled()
})

it('stores a bounded, reviewed result with the job and returns it without searching again', async () => {
  const job = await queueOne()
  await processQueuedJobs()
  const url = new URL(String(request.mock.calls[1]?.[0]))
  expect(request).toHaveBeenCalledTimes(2)
  expect(url.searchParams.get('q')).toBe(
    'track:"Night Signal Live" artist:"Example Artist"',
  )
  expect(url.searchParams.get('type')).toBe('track')
  expect(url.searchParams.get('limit')).toBe('10')
  expect(url.searchParams.get('market')).toBe('AU')

  const stored = await getSpotifyTrackSearch(recordingId, userId)
  expect(stored).toMatchObject({
    job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
    candidates: [
      {
        spotifyTrackId: candidateId,
        title,
        artists: [artistName],
        artistCredits: [{ id: 'catalogartist000000000', name: artistName }],
        albumName: 'Example Album',
        spotifyAlbumId: 'catalogalbum0000000000',
        artworkUrl: 'https://i.scdn.co/image/fixture',
        durationSec: 174,
        isrc: 'AA-FI1-20-00001',
        spotifyUrl: `https://open.spotify.com/track/${candidateId}`,
      },
    ],
  })
  expect(
    (await listSpotifyTrackSearchStatuses({ trackIds: [recordingId] }, userId))
      .items,
  ).toMatchObject([
    {
      trackId: recordingId,
      lastAttemptAt: stored.job?.startedAt,
      lastSuccessfulAt: stored.job?.finishedAt,
    },
  ])
  expect(await getSpotifyTrackSearch(recordingId, otherUserId)).toMatchObject({
    job: null,
    candidates: [],
  })
  const selection = {
    trackId: recordingId,
    jobId: job.id,
    spotifyTrackId: candidateId,
    userId,
  }
  expect(
    await fixture.transaction((tx) =>
      readSpotifyTrackSearchCandidate(tx, selection),
    ),
  ).toEqual(stored.candidates[0])
  await expect(
    fixture.transaction((tx) =>
      readSpotifyTrackSearchCandidate(tx, {
        ...selection,
        userId: otherUserId,
      }),
    ),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  expect(
    await queueSpotifyTrackSearches(
      { trackIds: [recordingId], batchId: 'fixture-batch' },
      userId,
    ),
  ).toMatchObject({ queued: 0, skipped: 1 })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { mediaItemId: recordingId, spotifyTrackId: null },
  ])
  expect(request).toHaveBeenCalledTimes(2)

  await queueSpotifyTrackSearches({ trackIds: [recordingId] }, userId)
  await expect(
    fixture.transaction((tx) => readSpotifyTrackSearchCandidate(tx, selection)),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
})

it('skips a recording that gains a Spotify ID while queued', async () => {
  const job = await queueOne()
  await fixture
    .update(schema.libraryTrack)
    .set({ spotifyTrackId: candidateId })
    .where(eq(schema.libraryTrack.mediaItemId, recordingId))
  await processQueuedJobs()
  expect(await getJob(job.id)).toMatchObject({
    status: 'succeeded',
    summary: { headline: expect.stringMatching(/^Search skipped/) },
  })
  expect(
    (await listSpotifyTrackSearchStatuses({ trackIds: [recordingId] }, userId))
      .items,
  ).toMatchObject([
    {
      trackId: recordingId,
      job: { status: 'succeeded', resultCount: null },
      lastAttemptAt: null,
      lastSuccessfulAt: null,
    },
  ])
  expect(request).not.toHaveBeenCalled()
})

it.each([
  ['lastfm', '02 - Night Signal (Radio Edit)', 'Night Signal (Radio Edit)'],
  ['lastfm', '99 Red Balloons', '99 Red Balloons'],
  ['lastfm', '1979 - Radio Edit', '1979 - Radio Edit'],
  ['album', '02 - Night Signal (Radio Edit)', '02 - Night Signal (Radio Edit)'],
])(
  'uses the conservative numbered-title query for %s recording %s',
  async (sourceLabel, storedTitle, searchedTitle) => {
    await fixture
      .update(schema.mediaItem)
      .set({ title: storedTitle, sourceLabel })
      .where(eq(schema.mediaItem.id, recordingId))
    const job = await queueOne()
    expect(job.options.trackTitle).toBe(storedTitle)
    await processQueuedJobs()

    const url = new URL(String(request.mock.calls[1]?.[0]))
    expect(url.searchParams.get('q')).toBe(
      `track:"${searchedTitle}" artist:"${artistName}"`,
    )
    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
      candidates: [{ spotifyTrackId: candidateId }],
    })
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      { mediaItemId: recordingId, spotifyTrackId: null },
    ])
  },
)

it('records a real zero-result search as a successful attempt', async () => {
  const job = await queueOne()
  request.mockImplementationOnce(async () => Response.json(spotifyTokenFixture))
  request.mockImplementationOnce(async () =>
    Response.json({ tracks: { items: [], offset: 0 } }),
  )
  await processQueuedJobs()
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
    job: { jobId: job.id, status: 'succeeded', resultCount: 0 },
    candidates: [],
  })
  expect(
    (await listSpotifyTrackSearchStatuses({ trackIds: [recordingId] }, userId))
      .items,
  ).toMatchObject([
    {
      trackId: recordingId,
      lastAttemptAt: expect.any(String),
      lastSuccessfulAt: expect.any(String),
    },
  ])
  expect(request).toHaveBeenCalledTimes(2)
})

it.each([undefined, 'AU'])(
  'uses a connected Spotify account with market %s when client credentials are unavailable',
  async (configuredMarket) => {
    market = configuredMarket
    clientSecret = undefined
    await expect(
      queueSpotifyTrackSearches({ trackIds: [recordingId] }, userId),
    ).rejects.toMatchObject({
      response: {
        statusCode: 422,
        message: expect.stringContaining(
          configuredMarket
            ? 'Configure Spotify Client ID'
            : 'Set Spotify Market in Providers',
        ),
      },
    })
    expect(await fixture.select().from(schema.scrapeJob)).toHaveLength(0)
    expect(request).not.toHaveBeenCalled()

    const ownerHash = createHash('sha256').update(userId).digest('hex')
    await fixture.insert(schema.providerSecret).values({
      id: 'fixture-spotify-tokens',
      provider: `spotify-account-${ownerHash}`,
      key: 'tokens',
      encryptedValue: encryptSecretValue(
        JSON.stringify({
          accessToken: 'fixture-owner-token',
          refreshToken: 'fixture-refresh-token',
          expiresAt: Date.now() + 3600 * 1000,
          scope: 'user-library-read',
          clientId: 'fixture-client',
        }),
      ),
      lastUpdatedByUserId: userId,
    })
    const job = await queueOne()
    expect(request).not.toHaveBeenCalled()
    await processQueuedJobs()

    expect(request).toHaveBeenCalledTimes(1)
    const [input, init] = request.mock.calls[0] ?? []
    expect(new URL(String(input)).searchParams.get('market')).toBe(
      configuredMarket ?? null,
    )
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer fixture-owner-token',
    )
    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
    })
  },
)

it('discards candidates received after cancellation', async () => {
  const job = await queueOne([{ provider: 'spotify', mode: 'never' }])
  let finishSearch: (response: Response) => void = () => {
    throw new Error('Search has not started')
  }
  const response = new Promise<Response>((resolve) => {
    finishSearch = resolve
  })
  let startSearch: () => void = () => {}
  const searching = new Promise<void>((resolve) => {
    startSearch = resolve
  })
  request.mockImplementationOnce(async () => Response.json(spotifyTokenFixture))
  request.mockImplementationOnce(async () => {
    startSearch()
    return response
  })
  const processing = processQueuedJobs()
  await Promise.race([
    searching,
    processing.then(() => {
      throw new Error('The job finished before the search request')
    }),
  ])
  try {
    await bulkCancelJobs({ jobIds: [job.id], confirmRunning: true }, userId)
  } finally {
    finishSearch(Response.json(searchBody))
    await processing
  }
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
    job: { jobId: job.id, status: 'cancelled', resultCount: null },
    candidates: [],
  })
  expect(
    await fixture.select().from(schema.providerRequestState),
  ).toMatchObject([{ failureCount: 0 }])
  expect((await retryJob(job.id, userId, false)).status).toBe('queued')
})

it('keeps Spotify cooldowns and retries a cancelled search only once', async () => {
  const original = await queueOne()
  await bulkCancelJobs({ jobIds: [original.id], confirmRunning: false }, userId)
  const retried = await retryJob(original.id, userId, false)
  expect(retried.id).not.toBe(original.id)
  expect((await retryJob(original.id, userId, false)).id).toBe(retried.id)

  request.mockImplementationOnce(async () => Response.json(spotifyTokenFixture))
  request.mockImplementationOnce(async () =>
    Response.json(
      { error: { status: 429, message: 'Synthetic rate limit' } },
      { status: 429, headers: { 'Retry-After': '600' } },
    ),
  )
  await processQueuedJobs()
  expect(await getJob(retried.id)).toMatchObject({ status: 'failed' })
  await expect(retryJob(retried.id, userId, false)).rejects.toMatchObject({
    response: { statusCode: 429 },
  })
  expect(request).toHaveBeenCalledTimes(2)
})

it('validates and authenticates searches and status through the Spotify API', async () => {
  const { default: app } = await import('@/app')
  const path = '/api/v1/spotify/tracks/search'
  const headers = {
    'content-type': 'application/json',
    cookie: 'session=fixture',
    origin: 'http://localhost:3000',
  }
  const post = (suffix: string, body: unknown, origin = headers.origin) =>
    app.request(`${path}${suffix}`, {
      method: 'POST',
      headers: { ...headers, origin },
      body: JSON.stringify(body),
    })
  expect((await app.request(`${path}/${recordingId}`)).status).toBe(401)
  expect(
    (await post('', { trackIds: [recordingId] }, 'https://untrusted.example'))
      .status,
  ).toBe(403)
  expect(
    (await post('', { trackIds: Array.from({ length: 6 }, () => recordingId) }))
      .status,
  ).toBe(422)
  expect((await post('/status', { trackIds: [] })).status).toBe(422)
  expect(
    (
      await post('', {
        trackIds: [recordingId],
        freshness: [{ provider: 'lastfm', mode: 'never' }],
      })
    ).status,
  ).toBe(422)
  expect(
    (
      await post('', {
        trackIds: [recordingId],
        freshness: [{ provider: 'spotify', mode: 'never' }],
      })
    ).status,
  ).toBe(200)
  expect(
    await (await post('/status', { trackIds: [recordingId] })).json(),
  ).toMatchObject({
    data: { items: [{ trackId: recordingId, job: { status: 'queued' } }] },
  })
  expect(
    await (await app.request(`${path}/${recordingId}`, { headers })).json(),
  ).toMatchObject({ data: { job: { status: 'queued' }, candidates: [] } })
  expect(request).not.toHaveBeenCalled()
})

it('selects Metadata tracks by owner-scoped search freshness before sorting and capping the results', async () => {
  const older = 'older-recording'
  const zero = 'zero-results'
  const failed = 'failed-recording'
  const covered = 'covered-recording'
  await addTrack(older, 'Aged Search')
  await addTrack(zero, 'Zero Results')
  await addTrack(failed, 'Failed Search')
  await addTrack(covered, 'Already Covered', candidateId)

  function attempt(
    id: string,
    trackId: string,
    status: 'queued' | 'failed' | 'succeeded',
    daysAgo: number,
    options: { resultCount?: number; requester?: string } = {},
  ): typeof schema.scrapeJob.$inferInsert {
    const at = new Date(Date.now() - daysAgo * 86_400_000)
    return {
      id,
      provider: 'spotify',
      status,
      scope: { mediaType: 'track', mediaItemIds: [trackId], limit: 1 },
      options: {
        task: SPOTIFY_TRACK_SEARCH_TASK,
        trackId,
        ...(options.resultCount === undefined
          ? {}
          : { resultCount: options.resultCount }),
      },
      requestedByUserId: options.requester ?? userId,
      createdAt: at,
      startedAt: status === 'queued' ? null : at,
      finishedAt: status === 'queued' ? null : at,
    }
  }
  await fixture.insert(schema.scrapeJob).values([
    attempt('old-success', older, 'succeeded', 90, { resultCount: 1 }),
    attempt('newer-failure', older, 'failed', 1),
    attempt('empty-success', zero, 'succeeded', 2, { resultCount: 0 }),
    attempt('waiting-search', zero, 'queued', 0),
    attempt('only-failure', failed, 'failed', 1),
    attempt('newly-covered-skip', recordingId, 'succeeded', 1),
    attempt('other-owner-failure', recordingId, 'failed', 1, {
      requester: otherUserId,
    }),
  ])
  const view = (overrides: Record<string, unknown> = {}, requester = userId) =>
    listTrackMatchDiagnostics(
      TrackMatchDiagnosticsQuerySchema.parse({
        view: 'spotify-search-metadata',
        playability: 'unavailable',
        ...overrides,
      }),
      requester,
    )
  const ids = (page: Awaited<ReturnType<typeof view>>) =>
    page.items.map((item) => item.id)
  const withFreshness = (
    filter: { mode: string; olderThanDays?: number },
    requester?: string,
  ) => view({ freshness: [{ provider: 'spotify', ...filter }] }, requester)

  expect(ids(await view())).toEqual([older, failed, recordingId, zero])
  expect(ids(await withFreshness({ mode: 'never' }))).toEqual([recordingId])
  expect(ids(await withFreshness({ mode: 'failed' }))).toEqual([older, failed])
  expect(ids(await withFreshness({ mode: 'unscraped' }))).toEqual([
    failed,
    recordingId,
  ])
  expect(
    ids(await withFreshness({ mode: 'older', olderThanDays: 30 })),
  ).toEqual([older, failed, recordingId])
  expect(ids(await withFreshness({ mode: 'failed' }, otherUserId))).toEqual([
    recordingId,
  ])

  const order = {
    sortBy: 'spotifyLastSearch',
    direction: 'desc',
    size: 1,
    limitResults: 2,
  }
  const first = await view(order)
  expect(first).toMatchObject({ totalCount: 2, pageCount: 2, providers: [] })
  expect(ids(first)).toEqual([zero])
  expect(ids(await view({ ...order, page: 2 }))).toEqual([older])
  expect(ids(await view({ ...order, page: 3 }))).toEqual([])
  expect(request).not.toHaveBeenCalled()
})

it('skips Metadata selections whose search freshness changed before the queue request', async () => {
  const freshness: SpotifyTrackSearchFreshness = [
    { provider: 'spotify', mode: 'never' },
  ]
  const metadata = await listTrackMatchDiagnostics(
    TrackMatchDiagnosticsQuerySchema.parse({
      view: 'spotify-search-metadata',
      playability: 'unavailable',
      freshness,
    }),
    userId,
  )
  expect(metadata.items.map((item) => item.id)).toEqual([recordingId])

  const recent = await queueOne()
  await processQueuedJobs()
  expect((await getJob(recent.id))?.status).toBe('succeeded')
  request.mockClear()

  expect(
    await queueSpotifyTrackSearches(
      { trackIds: [recordingId], freshness },
      userId,
    ),
  ).toMatchObject({
    queued: 0,
    skipped: 1,
    warnings: [expect.stringContaining('freshness')],
  })
  expect(
    (await listJobs({ mediaType: 'track' })).items.map((job) => job.id),
  ).toEqual([recent.id])
  expect(request).not.toHaveBeenCalled()
})

it('reports saved search history on the retained track after acceptance changes the ID', async () => {
  const original = await queueOne()
  await processQueuedJobs()
  const completed = await getSpotifyTrackSearch(recordingId, userId)
  expect(completed.job).toMatchObject({
    jobId: original.id,
    status: 'succeeded',
  })

  const retained = 'retained-recording'
  await addTrack(retained, 'Retained Recording', candidateId)
  await fixture
    .update(schema.scrapeJob)
    .set({
      options: sql`${schema.scrapeJob.options} || ${JSON.stringify({ acceptedTrackId: retained, acceptedSpotifyTrackId: candidateId })}::jsonb`,
    })
    .where(eq(schema.scrapeJob.id, original.id))
  await fixture
    .delete(schema.mediaItem)
    .where(eq(schema.mediaItem.id, recordingId))
  request.mockClear()

  const result = {
    job: { jobId: original.id, status: 'succeeded', acceptedTrackId: retained },
    candidates: completed.candidates,
  }
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject(result)
  expect(await getSpotifyTrackSearch(retained, userId)).toMatchObject(result)
  const status = await listSpotifyTrackSearchStatuses(
    { trackIds: [retained, recordingId] },
    userId,
  )
  expect(status.items).toMatchObject([
    {
      trackId: retained,
      job: result.job,
      lastSuccessfulAt: completed.job?.finishedAt,
    },
    { trackId: recordingId, job: null },
  ])
  const query = TrackMatchDiagnosticsQuerySchema.parse({
    view: 'spotify-search-metadata',
    playability: 'all',
    freshness: [{ provider: 'spotify', mode: 'never' }],
  })
  expect((await listTrackMatchDiagnostics(query, userId)).items).toEqual([])
  expect(
    (await listTrackMatchDiagnostics(query, otherUserId)).items.map(
      (item) => item.id,
    ),
  ).toEqual([retained])
  expect(request).not.toHaveBeenCalled()
})
