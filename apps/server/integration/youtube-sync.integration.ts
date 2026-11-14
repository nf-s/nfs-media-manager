import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
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
import type { BrowseFilter, BrowseRange } from '@repo/schemas/browse'
import {
  SubscriptionItemQuerySchema,
  type SubscriptionItemQueryInput,
} from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import type { LastfmSyncJobContext } from '@/services/lastfm-scrobbles'

const database = `youtube_sync_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
// The migration case points the services at a database of its own.
const active = { client: databaseClient }
const request = vi.fn<typeof fetch>()
const APP_ORIGIN = 'http://localhost:3000'
const USER = 'owner-fixture'
const SESSION = 'session-fixture'

vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...actual.env,
      APP_URL: 'http://localhost:3000',
      AUTH_BASE_URL: undefined,
      INTERNAL_BACKEND_URL: undefined,
      TRUSTED_ORIGINS: ['http://localhost:3000'],
    },
  }
})
vi.mock('@/lib/db', () => ({
  get db() {
    return active.client
  },
}))
// No request spacing, so the fixture API answers immediately.
vi.mock('@/plugins/builtin/youtube', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/plugins/builtin/youtube')>()
  const manifest = actual.youtubePlugin.manifest
  return {
    youtubePlugin: {
      manifest: {
        ...manifest,
        rateLimit: { ...manifest.rateLimit, minTimeMs: 0 },
      },
    },
  }
})
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'youtube'
      ? (await import('@/plugins/builtin/youtube')).youtubePlugin
      : null,
}))
// Two steps per job, so longer syncs chain follow-on jobs.
vi.mock('@/services/youtube-sync', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/youtube-sync')>()
  return {
    ...actual,
    runYoutubeSyncJob: (context: LastfmSyncJobContext) =>
      actual.runYoutubeSyncJob(context, { maxSteps: 2 }),
  }
})
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'fixture-client.apps.googleusercontent.com',
    clientSecret: 'offline-fixture-secret',
    redirectUri: 'http://localhost:3000/api/v1/youtube/callback',
  }),
}))

type FakeVideo = {
  id: string
  title: string
  description?: string
  publishedAt: string
  duration?: string
  views?: number
  tags?: string[]
  private?: boolean
  live?: 'upcoming'
  /** Also listed in the channel's Shorts playlist. */
  short?: boolean
}
type FakeChannel = {
  id: string
  title: string
  handle?: string
  subscribed: boolean
  noUploads?: boolean
  /** Leaves the video count out of the channel's statistics. */
  noVideoCount?: boolean
  /** Newest first, as the uploads playlist lists them. */
  videos: FakeVideo[]
}

const channelId = (key: string) => `UC${key.padEnd(22, '0')}`
const videoId = (key: string) => key.padEnd(11, '0')
const ORBITAL = channelId('orbital')
const COOKS = channelId('cooks')
const EMPTY = channelId('empty')
// The fixture API pages by two whatever page size is requested.
const PAGE = 2

function library(): FakeChannel[] {
  return [
    {
      id: ORBITAL,
      title: 'Kepler Mechanics Lab',
      handle: '@keplermechanicslab',
      subscribed: true,
      videos: [
        {
          id: videoId('a3'),
          title: 'Launch window livestream',
          description: 'Crew questions on isolation and depression.',
          publishedAt: '2026-04-01T18:00:00Z',
          duration: 'P0D',
          live: 'upcoming',
        },
        {
          id: videoId('a1'),
          title: 'Transfer orbits explained',
          description: 'Hohmann transfers and delta-v budgets.',
          publishedAt: '2026-03-01T23:30:00Z',
          duration: 'PT12M30S',
          views: 5000,
          tags: ['spaceflight'],
        },
        {
          id: videoId('a2'),
          title: 'Building a cloud chamber',
          description: 'A weekend build. Mentions orbits once.',
          publishedAt: '2026-02-01T10:00:00Z',
          duration: 'PT45M',
          views: 90000,
        },
        {
          id: videoId('a4'),
          title: 'Private video',
          publishedAt: '2026-01-05T10:00:00Z',
          private: true,
        },
        {
          id: videoId('a5'),
          title: 'Quick tip: torque wrenches',
          publishedAt: '2025-12-25T09:00:00Z',
          duration: 'PT58S',
          views: 300,
        },
      ],
    },
    {
      id: COOKS,
      title: 'The Who Cooks',
      subscribed: true,
      videos: [
        {
          id: videoId('b1'),
          title: 'Sourdough starter from scratch',
          description: 'Flour, water, patience.',
          publishedAt: '2026-01-15T08:00:00Z',
          duration: 'PT8M',
          views: 12000,
        },
        {
          id: videoId('b2'),
          title: 'Knife sharpening basics',
          description: 'Whetstones explained for beginners.',
          publishedAt: '2024-06-10T08:00:00Z',
          duration: 'PT22M',
          views: 700,
        },
        {
          id: videoId('b3'),
          title: 'Running a pop-up kitchen',
          publishedAt: '2023-01-01T08:00:00Z',
          duration: 'PT1H2M3S',
          views: 40,
        },
      ],
    },
    {
      id: EMPTY,
      title: 'Empty Channel Fixture',
      subscribed: true,
      noUploads: true,
      videos: [],
    },
  ]
}

const idle: (count: number) => Promise<void> = async () => {}

const api = {
  channels: library(),
  /** API requests answered before the quota error; token requests are not counted. */
  quotaAfter: Infinity,
  /** Answers this numbered API request with HTTP 500. */
  failAt: 0,
  refreshStatus: 200,
  expiresIn: 3600,
  apiRequests: 0,
  before: idle,
}

function paged<T>(items: T[], token: string | null) {
  const offset = Number(token ?? 0)
  const next = offset + PAGE
  return {
    items: items.slice(offset, next),
    ...(next < items.length ? { nextPageToken: String(next) } : {}),
  }
}

async function fakeYoutube(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  const url = new URL(String(input))
  if (url.host === 'oauth2.googleapis.com') {
    const form = new URLSearchParams(String(init?.body))
    const refresh = form.get('grant_type') === 'refresh_token'
    if (refresh && api.refreshStatus !== 200)
      return Response.json(
        { error: 'invalid_grant' },
        { status: api.refreshStatus },
      )
    return Response.json({
      access_token: refresh ? 'refreshed-access-token' : 'fixture-access-token',
      token_type: 'Bearer',
      expires_in: api.expiresIn,
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      ...(refresh ? {} : { refresh_token: 'fixture-refresh-token' }),
    })
  }
  if (url.host !== 'www.googleapis.com') throw new Error('Unexpected request')
  api.apiRequests += 1
  await api.before(api.apiRequests)
  if (api.apiRequests === api.failAt)
    return new Response('upstream fault', { status: 500 })
  if (api.apiRequests > api.quotaAfter)
    return Response.json(
      {
        error: {
          code: 403,
          message: 'The request cannot be completed because of the quota.',
          errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }],
        },
      },
      { status: 403 },
    )
  const params = url.searchParams
  const ids = (params.get('id') ?? '').split(',')
  switch (url.pathname) {
    case '/youtube/v3/subscriptions':
      return Response.json(
        paged(
          api.channels
            .filter((channel) => channel.subscribed)
            .map((channel) => ({
              snippet: {
                title: channel.title,
                description: '',
                resourceId: { kind: 'youtube#channel', channelId: channel.id },
                thumbnails: {
                  default: { url: `https://yt3.example/${channel.id}.jpg` },
                },
              },
            })),
          params.get('pageToken'),
        ),
      )
    case '/youtube/v3/channels':
      return Response.json({
        items: api.channels
          .filter((channel) => ids.includes(channel.id))
          .map((channel) => ({
            id: channel.id,
            snippet: {
              title: channel.title,
              description: `About ${channel.title}`,
              ...(channel.handle ? { customUrl: channel.handle } : {}),
              thumbnails: {
                default: { url: `https://yt3.example/${channel.id}.jpg` },
              },
            },
            statistics: {
              subscriberCount: '1200',
              hiddenSubscriberCount: false,
              ...(channel.noVideoCount
                ? {}
                : {
                    videoCount: String(
                      channel.videos.filter((video) => !video.private).length,
                    ),
                  }),
            },
            contentDetails: {
              relatedPlaylists: { uploads: `UU${channel.id.slice(2)}` },
            },
          })),
      })
    case '/youtube/v3/playlistItems': {
      const playlistId = params.get('playlistId') ?? ''
      const shorts = playlistId.startsWith('UUSH')
      const channel = api.channels.find(
        (item) => `${shorts ? 'UUSH' : 'UU'}${item.id.slice(2)}` === playlistId,
      )
      const listed =
        channel?.videos.filter((video) => !shorts || video.short) ?? []
      // A channel without Shorts has no Shorts playlist.
      if (!channel || channel.noUploads || (shorts && !listed.length))
        return Response.json(
          { error: { code: 404, errors: [{ reason: 'playlistNotFound' }] } },
          { status: 404 },
        )
      return Response.json(
        paged(
          listed.map((video) => ({ contentDetails: { videoId: video.id } })),
          params.get('pageToken'),
        ),
      )
    }
    case '/youtube/v3/videos':
      return Response.json({
        items: api.channels.flatMap((channel) =>
          channel.videos
            .filter((video) => ids.includes(video.id) && !video.private)
            .map((video) => ({
              id: video.id,
              snippet: {
                channelId: channel.id,
                title: video.title,
                description: video.description ?? '',
                publishedAt: video.publishedAt,
                ...(video.tags ? { tags: video.tags } : {}),
                liveBroadcastContent: video.live ?? 'none',
              },
              contentDetails: { duration: video.duration ?? 'PT5M' },
              statistics:
                video.views === undefined
                  ? {}
                  : { viewCount: String(video.views), likeCount: '7' },
            })),
        ),
      })
    default:
      throw new Error('Unexpected request')
  }
}

function channel(id: string) {
  const found = api.channels.find((item) => item.id === id)
  if (!found) throw new Error('Missing fixture channel')
  return found
}

function apiUrls() {
  return request.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.host === 'www.googleapis.com')
}

function apiPaths() {
  return apiUrls().map((url) => url.pathname.replace('/youtube/v3/', ''))
}

/** Shorts playlist requests as channel ID and page token, in order. */
function shortsRequests() {
  return apiUrls().flatMap((url) => {
    const playlistId = url.searchParams.get('playlistId') ?? ''
    return playlistId.startsWith('UUSH')
      ? [`UC${playlistId.slice(4)}:${url.searchParams.get('pageToken') ?? ''}`]
      : []
  })
}

/** The channels whose uploads list was requested, in request order. */
function uploadsRead() {
  return apiUrls().flatMap((url) => {
    const playlistId = url.searchParams.get('playlistId') ?? ''
    return playlistId.startsWith('UU') && !playlistId.startsWith('UUSH')
      ? [`UC${playlistId.slice(2)}`]
      : []
  })
}

async function connect() {
  const { authorizeYoutube, finishYoutubeAuthorization } =
    await import('@/services/youtube-oauth')
  const authorization = await authorizeYoutube(USER, SESSION, APP_ORIGIN)
  const state = new URL(authorization.url).searchParams.get('state') ?? ''
  return finishYoutubeAuthorization(
    { state, code: 'fixture-code' },
    USER,
    SESSION,
  )
}

async function status() {
  const { getYoutubeSubscriptionSyncStatus } =
    await import('@/services/youtube-sync')
  return getYoutubeSubscriptionSyncStatus(USER)
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
  await vi.waitFor(
    async () => {
      await processQueuedJobs()
      expect((await status()).state).not.toBe('running')
    },
    { timeout: 20000, interval: 50 },
  )
  return status()
}

async function syncToEnd() {
  const { queueYoutubeSync } = await import('@/services/youtube-sync-jobs')
  await queueYoutubeSync(USER)
  return drain()
}

// Stands in for a cooldown or request backoff running out.
async function clearProviderState() {
  await databaseClient.delete(schema.providerRequestState)
}

type Search = Omit<SubscriptionItemQueryInput, 'filters' | 'ranges'> & {
  filters?: BrowseFilter[]
  ranges?: BrowseRange[]
}

async function search({ filters, ranges, ...input }: Search) {
  const { listSubscriptionItems } =
    await import('@/services/subscription-library')
  const page = await listSubscriptionItems(
    SubscriptionItemQuerySchema.parse({
      ...input,
      filters: JSON.stringify(filters ?? []),
      ranges: JSON.stringify(ranges ?? []),
    }),
  )
  return { ...page, ids: page.items.map((item) => item.id) }
}

/** Any of these fixture channels, by title as the library filters them. */
function fromChannels(...ids: string[]): BrowseFilter[] {
  return ids.map((id) => ({
    field: 'source',
    value: channel(id).title,
    mode: 'any',
  }))
}

const youtubeOnly: BrowseFilter = {
  field: 'type',
  value: 'YouTube',
  mode: 'required',
}

/** Inclusive lengths in seconds. */
function duration(min: number | null, max: number | null): BrowseRange {
  return {
    field: 'durationSec',
    ...(min === null ? {} : { min }),
    ...(max === null ? {} : { max }),
    includeMissing: false,
  }
}

/** Inclusive UTC days. */
function published(from: string | null, to: string | null): BrowseRange {
  return {
    field: 'publishedAt',
    ...(from === null ? {} : { min: Date.parse(`${from}T00:00:00.000Z`) }),
    ...(to === null ? {} : { max: Date.parse(`${to}T23:59:59.999Z`) }),
    includeMissing: false,
  }
}

async function youtubeChannels() {
  const { listSubscriptionSources } =
    await import('@/services/subscription-library')
  return (await listSubscriptionSources({ type: 'youtube' })).items
}

const searchMigration = () =>
  readFile(
    new URL('../drizzle/0021_youtube_search_prefix.sql', import.meta.url),
    'utf8',
  )

/** Migration 0021 written against the tables as migration 0023 renamed them. */
async function renamedSearchMigration() {
  const renames: [string, string][] = [
    ['"youtube_video"', '"subscription_item"'],
    ['"youtube_channel"', '"subscription_source"'],
    ['v.channel_id', 'v.source_id'],
  ]
  let text = await searchMigration()
  for (const [from, to] of renames) {
    expect(text).toContain(from)
    text = text.replaceAll(from, to)
  }
  return text
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
  Object.assign(api, {
    channels: library(),
    quotaAfter: Infinity,
    failAt: 0,
    refreshStatus: 200,
    expiresIn: 3600,
    apiRequests: 0,
    before: idle,
  })
  request.mockReset()
  request.mockImplementation(fakeYoutube)
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.subscriptionItem)
  await databaseClient.delete(schema.subscriptionSource)
  await databaseClient.delete(schema.subscriptionSync)
  await databaseClient.delete(schema.providerSecret)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.delete(schema.user)
  await databaseClient.insert(schema.user).values({
    id: USER,
    name: 'Owner Fixture',
    email: 'owner@example.test',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('YouTube account connection with offline HTTP and a temporary database', () => {
  it('requests read-only offline access and stores the account only after a matching callback', async () => {
    const { authorizeYoutube, finishYoutubeAuthorization } =
      await import('@/services/youtube-oauth')
    expect((await status()).account).toEqual({
      configured: true,
      connected: false,
      redirectUri: 'http://localhost:3000/api/v1/youtube/callback',
    })

    const authorization = await authorizeYoutube(USER, SESSION, APP_ORIGIN)
    const url = new URL(authorization.url)
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'fixture-client.apps.googleusercontent.com',
      redirect_uri: 'http://localhost:3000/api/v1/youtube/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
    })
    const state = url.searchParams.get('state') ?? ''

    // Another browser session cannot complete the authorization.
    await expect(
      finishYoutubeAuthorization(
        { state, code: 'fixture-code' },
        USER,
        'other-session',
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('Connect') })
    expect(request).not.toHaveBeenCalled()

    expect(
      await finishYoutubeAuthorization(
        { state, code: 'fixture-code' },
        USER,
        SESSION,
      ),
    ).toEqual({ connected: true, returnOrigin: APP_ORIGIN })
    const exchange = new URLSearchParams(
      String(request.mock.calls[0]?.[1]?.body),
    )
    expect(Object.fromEntries(exchange)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'fixture-code',
      client_secret: 'offline-fixture-secret',
      redirect_uri: 'http://localhost:3000/api/v1/youtube/callback',
    })
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect((await status()).account.connected).toBe(true)

    // Tokens are stored encrypted, and a state value works once.
    const secrets = await databaseClient.select().from(schema.providerSecret)
    expect(secrets.map((row) => row.key)).toEqual(['tokens'])
    expect(secrets[0]?.encryptedValue).not.toContain('fixture-access-token')
    await expect(
      finishYoutubeAuthorization(
        { state, code: 'fixture-code' },
        USER,
        SESSION,
      ),
    ).rejects.toBeDefined()
  })

  it('stays disconnected when Google reports a denial, and disconnects on request', async () => {
    const { authorizeYoutube, disconnectYoutube, finishYoutubeAuthorization } =
      await import('@/services/youtube-oauth')
    const authorization = await authorizeYoutube(USER, SESSION, APP_ORIGIN)
    const state = new URL(authorization.url).searchParams.get('state') ?? ''
    expect(
      await finishYoutubeAuthorization(
        { state, error: 'access_denied' },
        USER,
        SESSION,
      ),
    ).toEqual({ connected: false, returnOrigin: APP_ORIGIN })
    expect(request).not.toHaveBeenCalled()
    expect((await status()).account.connected).toBe(false)

    await connect()
    expect((await status()).account.connected).toBe(true)
    expect(await disconnectYoutube(USER)).toEqual({ disconnected: true })
    expect((await status()).account.connected).toBe(false)
  })

  it('refuses to sync without a connected account', async () => {
    const { queueYoutubeSync } = await import('@/services/youtube-sync-jobs')
    await expect(queueYoutubeSync(USER)).rejects.toMatchObject({
      message: 'Connect a YouTube account in Subscriptions before syncing.',
    })
    expect(await syncJobs()).toHaveLength(0)
  })
})

describe('YouTube subscription sync jobs with offline HTTP and a temporary database', () => {
  it('reads every subscription and upload as chained jobs', async () => {
    await connect()
    const done = await syncToEnd()

    expect(done).toMatchObject({
      state: 'complete',
      phase: 'items',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 7,
      storedSources: 3,
      storedItems: 7,
      resumeAfter: null,
      errorMessage: null,
    })
    // Two subscription pages with their channel details, then each channel's
    // Shorts list and uploads in channel ID order; the channel without uploads
    // answers 404.
    expect(apiPaths()).toEqual([
      'subscriptions',
      'channels',
      'subscriptions',
      'channels',
      'playlistItems',
      'playlistItems',
      'videos',
      'playlistItems',
      'videos',
      'playlistItems',
      'playlistItems',
      'playlistItems',
      'playlistItems',
      'videos',
      'playlistItems',
      'videos',
      'playlistItems',
      'videos',
    ])
    expect(shortsRequests()).toEqual([`${COOKS}:`, `${EMPTY}:`, `${ORBITAL}:`])
    expect(
      new Headers(request.mock.calls[1]?.[1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-access-token')

    const jobs = await syncJobs()
    expect(jobs.length).toBeGreaterThan(1)
    expect(new Set(jobs.map((job) => `${job.provider}:${job.status}`))).toEqual(
      new Set(['youtube:succeeded']),
    )
    expect(jobs[0]?.options).toEqual({ task: 'youtube-subscription-sync' })
    expect(jobs[1]?.options).toEqual({
      task: 'youtube-subscription-sync',
      continues: jobs[0]?.id,
    })
    const { getJob, listJobs } = await import('@/services/jobs')
    expect((await getJob(jobs.at(-1)?.id ?? ''))?.logs.at(-1)?.message).toBe(
      'Sync complete. 7 new videos; 7 videos from 3 subscribed channels are stored.',
    )
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)

    // The Subscriptions endpoints report the same run.
    const { getSubscriptionSyncStatus, setSubscriptionSyncSchedule } =
      await import('@/services/subscription-sync')
    expect(done).toMatchObject({ provider: 'youtube', schedule: 'daily' })
    expect(await getSubscriptionSyncStatus('youtube', USER)).toEqual(done)
    expect(
      await setSubscriptionSyncSchedule('youtube', USER, 'weekly'),
    ).toMatchObject({ schedule: 'weekly' })
    expect((await status()).schedule).toBe('weekly')
    // The podcast sync has its own checkpoint and counts.
    expect(await getSubscriptionSyncStatus('spotify', USER)).toMatchObject({
      provider: 'spotify',
      state: 'never',
      storedSources: 0,
      storedItems: 0,
    })

    expect(await youtubeChannels()).toEqual([
      {
        type: 'youtube',
        id: EMPTY,
        title: 'Empty Channel Fixture',
        handle: null,
        description: 'About Empty Channel Fixture',
        thumbnailUrl: `https://yt3.example/${EMPTY}.jpg`,
        url: `https://www.youtube.com/channel/${EMPTY}`,
        subscriberCount: 1200,
        storedItems: 0,
        latestItemAt: null,
        historyComplete: true,
      },
      expect.objectContaining({
        id: ORBITAL,
        handle: '@keplermechanicslab',
        storedItems: 4,
        latestItemAt: '2026-04-01T18:00:00.000Z',
        historyComplete: true,
      }),
      expect.objectContaining({
        id: COOKS,
        title: 'The Who Cooks',
        storedItems: 3,
        historyComplete: true,
      }),
    ])
    const stored = await search({
      filters: fromChannels(ORBITAL),
      sortBy: 'publishedAt',
    })
    expect(stored.items[1]).toEqual({
      type: 'youtube',
      id: videoId('a1'),
      sourceId: ORBITAL,
      sourceTitle: 'Kepler Mechanics Lab',
      sourceThumbnailUrl: `https://yt3.example/${ORBITAL}.jpg`,
      title: 'Transfer orbits explained',
      description: 'Hohmann transfers and delta-v budgets.',
      tags: ['spaceflight'],
      publishedAt: '2026-03-01T23:30:00.000Z',
      publishedPrecision: 'time',
      durationSec: 750,
      url: `https://www.youtube.com/watch?v=${videoId('a1')}`,
      viewCount: 5000,
      likeCount: 7,
      commentCount: null,
      live: 'none',
    })
    expect(stored.items[0]).toMatchObject({
      id: videoId('a3'),
      durationSec: null,
      viewCount: null,
      live: 'upcoming',
    })
  })

  it('reads only the newest page of a stored channel, and follows subscription changes', async () => {
    await connect()
    await syncToEnd()
    request.mockClear()
    const orbital = channel(ORBITAL)
    orbital.title = 'Kepler Dynamics Lab'
    orbital.videos = orbital.videos.map((video) =>
      video.id === videoId('a3')
        ? { ...video, title: 'Launch window replay' }
        : video,
    )
    orbital.videos.unshift({
      id: videoId('a6'),
      title: 'Gravity assists',
      publishedAt: '2026-05-01T12:00:00Z',
      duration: 'PT9M',
      views: 10,
    })
    channel(COOKS).subscribed = false

    const second = await syncToEnd()
    expect(second).toMatchObject({
      state: 'complete',
      sourcesDone: 2,
      sourcesTotal: 2,
      newItems: 1,
      storedSources: 2,
      storedItems: 5,
    })
    // The Shorts list and one page of uploads of the channel with a new
    // video: its first page already holds a known video. The channel without
    // uploads is unchanged and not read.
    expect(apiPaths()).toEqual([
      'subscriptions',
      'channels',
      'playlistItems',
      'playlistItems',
      'videos',
    ])
    expect(shortsRequests()).toEqual([`${ORBITAL}:`])
    expect(uploadsRead()).toEqual([ORBITAL])
    // The refreshed first page updates stored videos and the renamed channel is searchable.
    expect((await search({ q: 'replay' })).ids).toEqual([videoId('a3')])
    expect(
      (await search({ q: 'dynamics', sortBy: 'publishedAt' })).ids,
    ).toEqual([
      videoId('a6'),
      videoId('a3'),
      videoId('a1'),
      videoId('a2'),
      videoId('a5'),
    ])
    expect((await search({ q: 'mechanics' })).ids).toEqual([])
    // An unsubscribed channel leaves the list and the search; its videos are kept.
    expect((await youtubeChannels()).map((item) => item.id)).toEqual([
      EMPTY,
      ORBITAL,
    ])
    expect((await search({ q: 'sourdough' })).ids).toEqual([])
    expect(
      await databaseClient.$count(
        schema.subscriptionItem,
        eq(schema.subscriptionItem.sourceId, COOKS),
      ),
    ).toBe(3)

    request.mockClear()
    channel(COOKS).subscribed = true
    const third = await syncToEnd()
    expect(third).toMatchObject({
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 0,
      storedItems: 8,
    })
    // The channel subscribed again has the video count of its last read, so
    // only the channel with an upcoming stream is read.
    expect(uploadsRead()).toEqual([ORBITAL])
    expect((await search({ q: 'sourdough' })).ids).toEqual([videoId('b1')])
  })

  it('skips channels whose video count is unchanged since their last read', async () => {
    const counts = async () =>
      Object.fromEntries(
        (
          await databaseClient
            .select()
            .from(schema.subscriptionSource)
            .orderBy(schema.subscriptionSource.id)
        ).map((row) => [row.id, [row.itemTotal, row.readItemTotal]]),
      )
    const views = async (id: string) =>
      (await search({ filters: fromChannels(ORBITAL, COOKS) })).items.find(
        (item) => item.id === id,
      )?.viewCount
    const listing = ['subscriptions', 'channels', 'subscriptions', 'channels']
    await connect()
    await syncToEnd()
    // Private videos are not counted; each read records the listed count.
    expect(await counts()).toEqual({
      [COOKS]: [3, 3],
      [EMPTY]: [0, 0],
      [ORBITAL]: [4, 4],
    })

    // Nothing was published. A channel with a stored upcoming stream is still
    // read, which stores the finished stream's length and status.
    request.mockClear()
    const orbital = channel(ORBITAL)
    orbital.videos = orbital.videos.map((video) =>
      video.id === videoId('a3')
        ? { ...video, duration: 'PT1H', live: undefined, views: 800 }
        : video,
    )
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 0,
      storedItems: 7,
    })
    expect(apiPaths()).toEqual([
      ...listing,
      'playlistItems',
      'playlistItems',
      'videos',
    ])
    expect(shortsRequests()).toEqual([`${ORBITAL}:`])
    expect(uploadsRead()).toEqual([ORBITAL])
    expect(
      (await search({ filters: fromChannels(ORBITAL), sortBy: 'publishedAt' }))
        .items[0],
    ).toMatchObject({ id: videoId('a3'), durationSec: 3600, live: 'none' })

    // Every channel is unchanged: only the subscription list is requested, and
    // the stored counts of a skipped channel's videos are not refreshed.
    request.mockClear()
    orbital.videos = orbital.videos.map((video) =>
      video.id === videoId('a1') ? { ...video, views: 6000 } : video,
    )
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 0,
      storedItems: 7,
    })
    expect(apiPaths()).toEqual(listing)
    expect(await views(videoId('a1'))).toBe(5000)

    // A channel with a new video and a channel without a listed count are
    // read. An unchanged channel whose Shorts no sync has recorded has only
    // its Shorts list read, which removes a stored Short.
    request.mockClear()
    orbital.videos = orbital.videos.map((video) =>
      video.id === videoId('a5') ? { ...video, short: true } : video,
    )
    await databaseClient
      .update(schema.subscriptionSource)
      .set({ shortsRunId: null })
      .where(eq(schema.subscriptionSource.id, ORBITAL))
    channel(COOKS).videos.unshift({
      id: videoId('b4'),
      title: 'Proofing baskets',
      publishedAt: '2026-05-02T08:00:00Z',
      duration: 'PT6M',
      views: 20,
    })
    channel(EMPTY).noVideoCount = true
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 1,
      storedItems: 7,
    })
    expect(apiPaths()).toEqual([
      ...listing,
      'playlistItems',
      'playlistItems',
      'videos',
      'playlistItems',
      'playlistItems',
      'playlistItems',
    ])
    expect(shortsRequests()).toEqual([`${COOKS}:`, `${EMPTY}:`, `${ORBITAL}:`])
    expect(uploadsRead()).toEqual([COOKS, EMPTY])
    expect((await search({ q: 'torque' })).ids).toEqual([])
    expect(await counts()).toEqual({
      [COOKS]: [4, 4],
      [EMPTY]: [null, null],
      [ORBITAL]: [4, 4],
    })
    expect(await views(videoId('a1'))).toBe(5000)

    // One video removed and one published leaves the count unchanged, so the
    // channel is not read until its count changes.
    request.mockClear()
    const cooks = channel(COOKS)
    cooks.videos = [
      {
        id: videoId('b5'),
        title: 'Cast iron care',
        publishedAt: '2026-05-03T08:00:00Z',
      },
      ...cooks.videos.filter((video) => video.id !== videoId('b3')),
    ]
    expect(await syncToEnd()).toMatchObject({ newItems: 0, storedItems: 7 })
    expect(shortsRequests()).toEqual([`${EMPTY}:`])
    expect(uploadsRead()).toEqual([EMPTY])
  })

  it('leaves Shorts out, removes stored ones, and reads the Shorts list only as far as a known Short', async () => {
    await connect()
    await syncToEnd()
    expect((await search({ q: 'torque' })).ids).toEqual([videoId('a5')])

    // Three stored uploads turn out to be Shorts, and a new Short is published.
    const orbital = channel(ORBITAL)
    const shorts = [videoId('a1'), videoId('a2'), videoId('a5')]
    orbital.videos = orbital.videos.map((video) =>
      shorts.includes(video.id) ? { ...video, short: true } : video,
    )
    orbital.videos.unshift({
      id: videoId('s1'),
      title: 'Thirty seconds of thrust',
      publishedAt: '2026-05-02T12:00:00Z',
      duration: 'PT30S',
      short: true,
    })
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      newItems: 0,
      storedItems: 4,
    })
    // Nothing recorded yet, so every page of the changed channel's Shorts
    // list is read; the unchanged channels are not requested.
    expect(shortsRequests()).toEqual([`${ORBITAL}:`, `${ORBITAL}:2`])
    expect(
      await databaseClient
        .select({ id: schema.subscriptionItem.id })
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.sourceId, ORBITAL)),
    ).toEqual([{ id: videoId('a3') }])
    expect((await search({ q: 'torque' })).ids).toEqual([])
    expect(await databaseClient.$count(schema.subscriptionShort)).toBe(4)
    const requested = () =>
      apiUrls()
        .filter((url) => url.pathname.endsWith('/videos'))
        .flatMap((url) => (url.searchParams.get('id') ?? '').split(','))
    expect(requested()).not.toContain(videoId('s1'))

    // A later Short shares its page with a recorded one, which ends both lists.
    orbital.videos.unshift({
      id: videoId('s2'),
      title: 'A minute of orbital decay',
      publishedAt: '2026-05-03T12:00:00Z',
      duration: 'PT1M',
      short: true,
    })
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({ newItems: 0, storedItems: 4 })
    expect(shortsRequests()).toEqual([`${ORBITAL}:`])
    expect(apiPaths()).toEqual([
      'subscriptions',
      'channels',
      'subscriptions',
      'channels',
      'playlistItems',
      'playlistItems',
    ])
    expect(requested()).toEqual([])
    expect(await databaseClient.$count(schema.subscriptionShort)).toBe(5)
  })

  it('leaves podcast sources and episodes out of the YouTube sync, counts and search', async () => {
    const show = 'podcastshowfixture0001'
    await databaseClient.insert(schema.subscriptionSource).values({
      id: show,
      type: 'spotify',
      title: 'Orbit Talk Fixture',
      itemTotal: 1,
      seenRunId: 'podcast-run',
    })
    await databaseClient.insert(schema.subscriptionItem).values({
      id: 'podcastepisodefixture1',
      sourceId: show,
      type: 'spotify',
      title: 'Orbits for beginners',
      publishedAt: new Date('2026-03-02T00:00:00Z'),
      publishedPrecision: 'day',
      durationSec: 1800,
      search: sql`to_tsvector('simple', 'Orbits for beginners Orbit Talk Fixture')`,
    })
    await connect()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesTotal: 3,
      storedSources: 3,
      storedItems: 7,
    })
    channel(COOKS).subscribed = false
    expect(await syncToEnd()).toMatchObject({
      sourcesTotal: 2,
      storedSources: 2,
    })

    const [source] = await databaseClient
      .select()
      .from(schema.subscriptionSource)
      .where(eq(schema.subscriptionSource.id, show))
    expect(source).toMatchObject({
      type: 'spotify',
      subscribed: true,
      seenRunId: 'podcast-run',
    })
    expect(
      await databaseClient.$count(
        schema.subscriptionItem,
        eq(schema.subscriptionItem.sourceId, show),
      ),
    ).toBe(1)
    expect((await youtubeChannels()).map((item) => item.id)).toEqual([
      EMPTY,
      ORBITAL,
    ])
    expect((await search({ q: 'orbits', filters: [youtubeOnly] })).ids).toEqual(
      [videoId('a1'), videoId('a2')],
    )
    expect((await search({ q: 'orbits' })).ids).toContain(
      'podcastepisodefixture1',
    )
    expect((await search({ filters: fromChannels(ORBITAL) })).totalCount).toBe(
      4,
    )
    const { listSubscribedSourceNames } =
      await import('@/services/subscription-source-names')
    expect(
      (await listSubscribedSourceNames()).map((item) => [item.type, item.id]),
    ).toEqual([
      ['youtube', EMPTY],
      ['youtube', ORBITAL],
      ['spotify', show],
    ])
  })

  it('returns the active job instead of queueing a second sync', async () => {
    await connect()
    const { queueYoutubeSync } = await import('@/services/youtube-sync-jobs')
    const first = await queueYoutubeSync(USER)
    const second = await queueYoutubeSync(USER)
    expect(first.state).toBe('running')
    expect(second.job).toEqual(first.job)
    expect(await syncJobs()).toHaveLength(1)
  })

  it('pauses on the YouTube quota and lets the schedule resume from the checkpoint', async () => {
    await connect()
    const { queueDueYoutubeSync } = await import('@/services/youtube-sync-jobs')
    // The subscription list, the first channel's Shorts list and its first
    // uploads page fit; the next request does not.
    api.quotaAfter = 7
    const before = Date.now()
    const paused = await syncToEnd()

    expect(paused).toMatchObject({
      state: 'paused',
      phase: 'items',
      sourcesDone: 0,
      sourcesTotal: 3,
      storedItems: 2,
      errorMessage: null,
    })
    const resumeAfter = Date.parse(paused.resumeAfter ?? '')
    expect(resumeAfter).toBeGreaterThanOrEqual(before + 60 * 60 * 1000)
    expect(paused.nextScheduledAt).toBe(paused.resumeAfter)
    const jobs = await syncJobs()
    expect(jobs.at(-1)?.status).toBe('succeeded')
    const { getJob, listJobs } = await import('@/services/jobs')
    expect((await getJob(jobs.at(-1)?.id ?? ''))?.logs.at(-1)?.message).toMatch(
      /^Paused: Provider rate limit reached\. Stored videos are kept;/,
    )
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)
    const [channelRow] = await databaseClient
      .select()
      .from(schema.subscriptionSource)
      .where(eq(schema.subscriptionSource.id, ORBITAL))
    expect(channelRow?.historyComplete).toBe(false)

    // Not due yet, and still held while the provider cools down.
    expect(await queueDueYoutubeSync(resumeAfter - 1000)).toBe(false)
    expect(await queueDueYoutubeSync(resumeAfter + 1000)).toBe(false)
    await clearProviderState()
    api.quotaAfter = Infinity
    request.mockClear()
    expect(await queueDueYoutubeSync(resumeAfter + 1000)).toBe(true)
    const done = await drain()
    expect(done).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      newItems: 7,
      storedItems: 7,
      resumeAfter: null,
    })
    // The run continues at the second uploads page; nothing is read twice.
    expect(apiPaths().slice(0, 2)).toEqual(['playlistItems', 'videos'])
    expect(
      new URL(String(request.mock.calls[0]?.[0])).searchParams.get('pageToken'),
    ).toBe('2')
    expect(apiPaths().includes('subscriptions')).toBe(false)
  })

  it('pauses until midnight UTC when the daily request budget is used, and waits for the owner when the schedule is off', async () => {
    await connect()
    const { setYoutubeSyncSchedule } = await import('@/services/youtube-sync')
    const { queueDueYoutubeSync } = await import('@/services/youtube-sync-jobs')
    await setYoutubeSyncSchedule(USER, 'off')
    // The sign-in used one request; four more read the subscription list.
    await databaseClient
      .update(schema.providerRequestState)
      .set({ requestBudgetOverride: { period: 'day', limit: 5 } })
      .where(eq(schema.providerRequestState.provider, 'youtube'))

    const paused = await syncToEnd()
    const day = 24 * 60 * 60 * 1000
    expect(paused).toMatchObject({
      state: 'paused',
      phase: 'items',
      storedSources: 3,
      storedItems: 0,
      resumeAfter: new Date(Math.ceil(Date.now() / day) * day).toISOString(),
      nextScheduledAt: null,
    })
    expect(await queueDueYoutubeSync(Date.now() + 365 * day)).toBe(false)

    await databaseClient
      .update(schema.providerRequestState)
      .set({ requestBudgetOverride: null })
      .where(eq(schema.providerRequestState.provider, 'youtube'))
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 7,
    })
  })

  it('fails on a provider error without an automatic retry, then resumes on request', async () => {
    await connect()
    const { queueDueYoutubeSync } = await import('@/services/youtube-sync-jobs')
    api.failAt = 8
    const failed = await syncToEnd()
    expect(failed).toMatchObject({
      state: 'failed',
      storedItems: 2,
      errorMessage: 'Provider request failed (HTTP 500)',
      nextScheduledAt: null,
      job: { status: 'failed' },
    })
    const { listJobs } = await import('@/services/jobs')
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(1)
    await clearProviderState()
    // The schedule never resumes a failed run.
    expect(await queueDueYoutubeSync(Date.now() + 365 * 86400000)).toBe(false)

    api.failAt = 0
    const done = await syncToEnd()
    expect(done).toMatchObject({ state: 'complete', storedItems: 7 })
    const jobs = await syncJobs()
    const original = jobs.find((job) => job.status === 'failed')
    expect(original?.options['retryJobId']).toEqual(expect.any(String))
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)
  })

  it('discards the in-flight page when the job is cancelled and resumes on request', async () => {
    await connect()
    const { bulkCancelJobs } = await import('@/services/jobs')
    api.before = async (count) => {
      if (count !== 7) return
      const running = (await syncJobs()).find((job) => job.status === 'running')
      await bulkCancelJobs(
        { jobIds: [running?.id ?? ''], confirmRunning: true },
        null,
      )
    }
    const stopped = await syncToEnd()
    expect(stopped).toMatchObject({
      state: 'stopped',
      phase: 'items',
      storedItems: 0,
      job: { status: 'cancelled' },
    })

    api.before = idle
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 7,
    })
  })

  it('renews an expired access token, and asks for a new sign-in when Google rejects it', async () => {
    api.expiresIn = 1
    await connect()
    const done = await syncToEnd()
    expect(done.state).toBe('complete')
    const refresh = request.mock.calls
      .map(([input, init]) => ({
        host: new URL(String(input)).host,
        form: new URLSearchParams(String(init?.body)),
      }))
      .filter((call) => call.host === 'oauth2.googleapis.com')
      .at(-1)
    expect(Object.fromEntries(refresh?.form ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'fixture-refresh-token',
      client_id: 'fixture-client.apps.googleusercontent.com',
      client_secret: 'offline-fixture-secret',
    })

    api.refreshStatus = 400
    const failed = await syncToEnd()
    expect(failed).toMatchObject({
      state: 'failed',
      errorMessage:
        'Google rejected the saved YouTube sign-in. Connect the account again.',
    })

    await clearProviderState()
    api.refreshStatus = 200
    api.expiresIn = 3600
    await connect()
    expect(await syncToEnd()).toMatchObject({ state: 'complete' })
  })

  it.each([
    { schedule: '1h', minutes: 60 },
    { schedule: 'daily', minutes: 1440 },
    { schedule: 'weekly', minutes: 10080 },
  ])(
    'queues a $schedule sync only when due after a completed sync',
    async ({ schedule, minutes }) => {
      const { YoutubeSyncScheduleSchema } =
        await import('@repo/schemas/youtube')
      const { setYoutubeSyncSchedule } = await import('@/services/youtube-sync')
      const { queueDueYoutubeSync } =
        await import('@/services/youtube-sync-jobs')
      const day = 24 * 60 * 60 * 1000
      await connect()

      // The setting can be saved first, but the schedule never starts the first sync.
      expect(await setYoutubeSyncSchedule(USER, 'weekly')).toMatchObject({
        state: 'never',
        schedule: 'weekly',
        nextScheduledAt: null,
        startedAt: null,
      })
      expect(await queueDueYoutubeSync(Date.now() + 365 * day)).toBe(false)

      const completed = await syncToEnd()
      const completedAt = Date.parse(completed.lastCompletedAt ?? '')
      const interval = minutes * 60 * 1000
      expect(
        (
          await setYoutubeSyncSchedule(
            USER,
            YoutubeSyncScheduleSchema.parse(schedule),
          )
        ).nextScheduledAt,
      ).toBe(new Date(completedAt + interval).toISOString())
      expect(await queueDueYoutubeSync(completedAt + interval - 1000)).toBe(
        false,
      )
      expect(await queueDueYoutubeSync(completedAt + interval)).toBe(true)
      // The queued job is found instead of adding a second one.
      expect(await queueDueYoutubeSync(completedAt + interval)).toBe(false)
      expect((await drain()).state).toBe('complete')
    },
  )
})

describe('YouTube video search over stored videos', () => {
  const all = ['a3', 'a1', 'a2', 'b1', 'a5', 'b2', 'b3'].map(videoId)

  beforeEach(async () => {
    await connect()
    await syncToEnd()
    request.mockClear()
  })

  it('lists newest first without a search, with totals for paging', async () => {
    expect((await search({})).ids).toEqual(all)
    expect(await search({ size: 2, page: 2 })).toMatchObject({
      ids: [videoId('a2'), videoId('b1')],
      totalCount: 7,
      page: 2,
      size: 2,
      pageCount: 4,
    })
    expect((await search({ direction: 'asc' })).ids).toEqual([...all].reverse())
    expect(request).not.toHaveBeenCalled()
  })

  it('matches every word across the title, tags, channel name and description', async () => {
    // Word forms match, and a title match ranks above a description match.
    expect((await search({ q: 'orbit' })).ids).toEqual([
      videoId('a1'),
      videoId('a2'),
    ])
    expect((await search({ q: 'orbits', fields: 'title' })).ids).toEqual([
      videoId('a1'),
    ])
    expect((await search({ q: 'spaceflight' })).ids).toEqual([videoId('a1')])
    expect((await search({ q: 'cooks sourdough' })).ids).toEqual([
      videoId('b1'),
    ])
    expect((await search({ q: 'sourdough wrenches' })).ids).toEqual([])
    expect((await search({ q: 'explained -orbits' })).ids).toEqual([
      videoId('b2'),
    ])
    expect((await search({ q: '"cloud chamber"' })).ids).toEqual([
      videoId('a2'),
    ])
    expect(
      (await search({ q: 'sourdough or wrenches', sortBy: 'publishedAt' })).ids,
    ).toEqual([videoId('b1'), videoId('a5')])
    // Relevance is the default with a search; any other sort can replace it.
    expect(
      (
        await search({
          q: 'orbit',
          sortBy: 'publishedAt',
          direction: 'asc',
        })
      ).ids,
    ).toEqual([videoId('a2'), videoId('a1')])
  })

  it('matches a partial word as the start of a stored word', async () => {
    expect((await search({ q: 'depressio' })).ids).toEqual([videoId('a3')])
    expect((await search({ q: 'DEPRES' })).ids).toEqual([videoId('a3')])
    expect((await search({ q: 'sourdo' })).ids).toEqual([videoId('b1')])
    expect((await search({ q: 'whetst' })).ids).toEqual([videoId('b2')])
    expect((await search({ q: 'transf orbi' })).ids).toEqual([videoId('a1')])
    expect(
      (await search({ q: 'kepler mech', sortBy: 'publishedAt' })).ids,
    ).toEqual(['a3', 'a1', 'a2', 'a5'].map(videoId))
    // A form that is not a prefix of the stored word still matches its stem.
    expect((await search({ q: 'orbiting' })).ids).toEqual([
      videoId('a1'),
      videoId('a2'),
    ])
    // Titles only leaves out a description-only match.
    expect((await search({ q: 'depressio', fields: 'title' })).ids).toEqual([])
    expect((await search({ q: 'sourdo', fields: 'title' })).ids).toEqual([
      videoId('b1'),
    ])
    // Quoted phrases match whole words.
    expect((await search({ q: '"cloud chamb"' })).ids).toEqual([])
    expect((await search({ q: '"cloud chamber"' })).ids).toEqual([
      videoId('a2'),
    ])
    expect(
      (await search({ q: 'sourdo or wrench', sortBy: 'publishedAt' })).ids,
    ).toEqual([videoId('b1'), videoId('a5')])
    expect((await search({ q: 'explained -whetst' })).ids).toEqual([
      videoId('a1'),
    ])
    expect((await search({ q: '-"cloud chamber"' })).totalCount).toBe(6)
    expect(request).not.toHaveBeenCalled()
  })

  it('treats operator characters in a search as plain text', async () => {
    // Unbalanced quotes run to the end of the search.
    expect((await search({ q: '"cloud chamber' })).ids).toEqual([videoId('a2')])
    for (const q of ['orbit:*', '!orbit', '(orbit)', 'orbit\\', "orbit'"])
      expect((await search({ q })).ids).toEqual([videoId('a1'), videoId('a2')])
    for (const q of ['sourdough & wrenches', 'sourdough | wrenches'])
      expect((await search({ q })).ids).toEqual([])
    for (const q of [
      '"',
      '""',
      "'",
      '-',
      ':*',
      '&',
      '|',
      '!',
      '!!',
      '()',
      '(',
      '\\',
      '%',
      '_',
      '50%_',
      "'orbit':* & !(",
      'or',
      'or or -',
    ])
      expect(await search({ q })).toMatchObject({ page: 1 })
    for (const q of ['%', '_', '\\', ':*', '&', '|', '!', '()'])
      expect((await search({ q })).totalCount).toBe(0)
  })

  it('falls back to the literal text when a search has only stop words', async () => {
    expect((await search({ q: 'the who' })).ids).toEqual(
      ['b1', 'b2', 'b3'].map(videoId),
    )
    expect((await search({ q: 'the' })).totalCount).toBe(3)
    expect(
      (await search({ q: 'the', filters: fromChannels(ORBITAL) })).totalCount,
    ).toBe(0)
    // Stop words beside other words are ignored.
    expect((await search({ q: 'the orbit' })).ids).toEqual([
      videoId('a1'),
      videoId('a2'),
    ])
  })

  it('rebuilds stored search text in the migration exactly as a sync writes it', async () => {
    // The renamed channel's older videos keep the vector written on rename.
    channel(COOKS).title = 'The Who Cooks Again'
    await syncToEnd()
    const vectors = async () =>
      (
        await pool.query<{ id: string; search: string }>(
          'select id, search::text as search from subscription_item order by id',
        )
      ).rows
    const synced = await vectors()
    expect(synced).toHaveLength(7)
    expect(synced.find((row) => row.id === videoId('a3'))?.search).toContain(
      "'depression':",
    )
    await pool.query(
      "update subscription_item set search = to_tsvector('english', 'stale')",
    )
    await pool.query(await renamedSearchMigration())
    expect(await vectors()).toEqual(synced)
  })

  it('filters by channel, length and published day', async () => {
    expect((await search({ filters: fromChannels(COOKS) })).ids).toEqual(
      ['b1', 'b2', 'b3'].map(videoId),
    )
    expect(
      (await search({ filters: fromChannels(COOKS, ORBITAL) })).totalCount,
    ).toBe(7)
    expect((await search({ filters: fromChannels(EMPTY) })).totalCount).toBe(0)
    // An unfinished live stream has no duration and is in no length range.
    expect((await search({ ranges: [duration(null, 239)] })).ids).toEqual([
      videoId('a5'),
    ])
    expect((await search({ ranges: [duration(240, 1200)] })).ids).toEqual(
      ['a1', 'b1'].map(videoId),
    )
    expect((await search({ ranges: [duration(1201, null)] })).ids).toEqual(
      ['a2', 'b2', 'b3'].map(videoId),
    )
    // Both days are inclusive in UTC.
    expect(
      (await search({ ranges: [published('2026-02-01', '2026-03-01')] })).ids,
    ).toEqual(['a1', 'a2'].map(videoId))
    expect(
      (await search({ ranges: [published(null, '2023-12-31')] })).ids,
    ).toEqual([videoId('b3')])
    expect(
      (
        await search({
          q: 'explained',
          filters: fromChannels(COOKS),
          ranges: [duration(1201, null)],
        })
      ).ids,
    ).toEqual([videoId('b2')])
  })

  it('sorts by views and duration', async () => {
    // Videos without a view count sort last in either direction.
    expect((await search({ sortBy: 'viewCount' })).ids).toEqual(
      ['a2', 'b1', 'a1', 'b2', 'a5', 'b3', 'a3'].map(videoId),
    )
    expect(
      (await search({ sortBy: 'viewCount', direction: 'asc' })).ids,
    ).toEqual(['b3', 'a5', 'b2', 'a1', 'b1', 'a2', 'a3'].map(videoId))
    expect((await search({ sortBy: 'durationSec' })).ids).toEqual(
      ['b3', 'a2', 'b2', 'a1', 'b1', 'a5', 'a3'].map(videoId),
    )
    // Relevance without a search is newest first.
    expect((await search({ sortBy: 'relevance' })).ids).toEqual(all)
  })
})

describe('subscription library migration', () => {
  it('moves stored channels, videos and a paused checkpoint into the subscription tables, then resumes the run', async () => {
    const name = `${database}_migration`
    await admin.query(`create database ${name}`)
    const migrationPool = new pg.Pool({ ...connection, database: name })
    const query = async (text: string) => (await migrationPool.query(text)).rows
    try {
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
      const index = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('ALTER TABLE "youtube_channel" RENAME TO'),
        ),
      )
      const target = migrations[index]
      if (!target) throw new Error('Missing subscription library migration')
      const client = await migrationPool.connect()
      try {
        await client.query('begin')
        for (const previous of migrations.slice(0, index))
          for (const statement of previous.sql) await client.query(statement)
        await client.query('commit')
      } finally {
        client.release()
      }

      // As a sync left them when the quota ran out on the second uploads page
      // of the first channel in ID order.
      await migrationPool.query(`
        insert into "user" (id, name, email) values
          ('${USER}', 'Owner Fixture', 'owner@example.test');
        insert into youtube_channel
          (id, title, handle, thumbnail_url, uploads_playlist_id, subscriber_count, seen_run_id) values
          ('${ORBITAL}', 'Kepler Mechanics Lab', '@keplermechanicslab', 'https://yt3.example/${ORBITAL}.jpg', 'UU${ORBITAL.slice(2)}', 1200, 'run-before'),
          ('${COOKS}', 'The Who Cooks', null, null, 'UU${COOKS.slice(2)}', 1200, 'run-before'),
          ('${EMPTY}', 'Empty Channel Fixture', null, null, 'UU${EMPTY.slice(2)}', 1200, 'run-before');
        insert into youtube_video
          (id, channel_id, title, description, tags, published_at, duration_sec, view_count, like_count, live, search) values
          ('${videoId('b1')}', '${COOKS}', 'Sourdough starter from scratch', 'Flour, water, patience.', '["baking"]', '2026-01-15T08:00:00', 480, 12000, 7, 'none', ''),
          ('${videoId('b2')}', '${COOKS}', 'Knife sharpening basics', 'Whetstones explained for beginners.', '[]', '2024-06-10T08:00:00', 1320, 700, 7, 'none', '');
        insert into youtube_sync
          (user_id, status, schedule, run_id, phase, page_token, channel_cursor,
           channels_done, channels_total, new_videos, resume_after, started_at) values
          ('${USER}', 'paused', 'daily', 'run-before', 'videos', '2', null,
           0, 3, 2, now() - interval '1 minute', now() - interval '1 hour');
      `)
      await migrationPool.query(await searchMigration())
      const vectors = () =>
        query(
          'select id, search::text as search from youtube_video order by id',
        )
      const before = await vectors()
      expect(before[0]?.search).toContain("'baking':")

      const migrating = await migrationPool.connect()
      try {
        await migrating.query('begin')
        for (const statement of target.sql) await migrating.query(statement)
        await migrating.query('commit')
      } finally {
        migrating.release()
      }

      expect(
        await query(
          "select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'youtube%' or table_name like 'subscription%') order by table_name",
        ),
      ).toEqual([
        { table_name: 'subscription_item' },
        { table_name: 'subscription_source' },
        { table_name: 'subscription_sync' },
      ])
      expect(
        await query(
          'select id, type, item_total, subscribed from subscription_source order by id',
        ),
      ).toEqual(
        [COOKS, EMPTY, ORBITAL].map((id) => ({
          id,
          type: 'youtube',
          item_total: null,
          subscribed: true,
        })),
      )
      expect(
        await query(
          'select id, source_id, type, published_precision, artwork_url from subscription_item order by id',
        ),
      ).toEqual(
        ['b1', 'b2'].map((key) => ({
          id: videoId(key),
          source_id: COOKS,
          type: 'youtube',
          published_precision: 'time',
          artwork_url: null,
        })),
      )
      expect(
        await query(
          'select id, search::text as search from subscription_item order by id',
        ),
      ).toEqual(before)
      expect(
        await query(
          'select user_id, provider, status, phase, page_token, source_cursor, sources_done, sources_total, new_items from subscription_sync',
        ),
      ).toEqual([
        {
          user_id: USER,
          provider: 'youtube',
          status: 'paused',
          phase: 'items',
          page_token: '2',
          source_cursor: null,
          sources_done: 0,
          sources_total: 3,
          new_items: 2,
        },
      ])
      expect(
        await query(`
          select conrelid::regclass::text as "table", conname as name,
            pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid in ('subscription_source'::regclass,
            'subscription_item'::regclass, 'subscription_sync'::regclass)
          order by 1, 2`),
      ).toEqual([
        {
          table: 'subscription_item',
          name: 'subscription_item_pkey',
          definition: 'PRIMARY KEY (id)',
        },
        {
          table: 'subscription_item',
          name: 'subscription_item_source_id_subscription_source_id_fk',
          definition:
            'FOREIGN KEY (source_id) REFERENCES subscription_source(id) ON DELETE CASCADE',
        },
        {
          table: 'subscription_source',
          name: 'subscription_source_pkey',
          definition: 'PRIMARY KEY (id)',
        },
        {
          table: 'subscription_source',
          name: 'subscription_source_type_check',
          definition: expect.stringContaining("'spotify'"),
        },
        {
          table: 'subscription_sync',
          name: 'subscription_sync_user_id_provider_pk',
          definition: 'PRIMARY KEY (user_id, provider)',
        },
        {
          table: 'subscription_sync',
          name: 'subscription_sync_user_id_user_id_fk',
          definition:
            'FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE',
        },
      ])
      expect(
        (
          await query(
            "select indexname from pg_indexes where tablename like 'subscription%' order by indexname",
          )
        ).map((row) => row.indexname),
      ).toEqual([
        'subscription_item_duration_idx',
        'subscription_item_pkey',
        'subscription_item_published_idx',
        'subscription_item_search_idx',
        'subscription_item_source_published_idx',
        'subscription_item_views_idx',
        'subscription_source_pkey',
        'subscription_source_type_subscribed_idx',
        'subscription_sync_user_id_provider_pk',
      ])
      // Types are no longer defaulted: each writer states its own.
      await expect(
        migrationPool.query(
          "insert into subscription_source (id, title) values ('podcastshowfixture0001', 'Missing type')",
        ),
      ).rejects.toThrow()
      await expect(
        migrationPool.query(
          "insert into subscription_source (id, type, title) values ('podcastshowfixture0001', 'other', 'Unknown type')",
        ),
      ).rejects.toThrow()

      // Later migrations bring the tables to the shape the sync reads.
      const finishing = await migrationPool.connect()
      try {
        await finishing.query('begin')
        for (const later of migrations.slice(index + 1))
          for (const statement of later.sql) await finishing.query(statement)
        await finishing.query('commit')
      } finally {
        finishing.release()
      }

      // The migrated checkpoint resumes at the second uploads page; a channel
      // resumed inside its uploads has its Shorts recorded by the next run.
      active.client = drizzle(migrationPool, { schema })
      await connect()
      request.mockClear()
      const { queueDueYoutubeSync } =
        await import('@/services/youtube-sync-jobs')
      expect(await queueDueYoutubeSync()).toBe(true)
      expect(await drain()).toMatchObject({
        state: 'complete',
        phase: 'items',
        sourcesDone: 3,
        sourcesTotal: 3,
        newItems: 7,
        storedSources: 3,
        storedItems: 7,
      })
      expect(apiPaths().slice(0, 2)).toEqual(['playlistItems', 'videos'])
      expect(
        new URL(String(request.mock.calls[0]?.[0])).searchParams.get(
          'pageToken',
        ),
      ).toBe('2')
      expect(apiPaths().includes('subscriptions')).toBe(false)
    } finally {
      active.client = databaseClient
      await migrationPool.end()
      await admin.query(`drop database ${name}`)
    }
  })
})
