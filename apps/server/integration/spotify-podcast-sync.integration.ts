import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
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
import {
  SubscriptionItemQuerySchema,
  type SubscriptionItemQueryInput,
} from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import type { LastfmSyncJobContext } from '@/services/lastfm-scrobbles'
import { subscriptionSearchVector } from '@/services/subscription-library'

const database = `spotify_podcast_sync_${randomUUID().replaceAll('-', '')}`
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
const USER = 'owner-fixture'
const account = vi.hoisted(() => ({ configured: true, connected: true }))

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
// No request spacing, so the fixture API answers immediately.
vi.mock('@/plugins/builtin/spotify', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/plugins/builtin/spotify')>()
  const manifest = actual.spotifyPlugin.manifest
  return {
    ...actual,
    spotifyPlugin: {
      ...actual.spotifyPlugin,
      manifest: {
        ...manifest,
        rateLimit: { ...manifest.rateLimit, minTimeMs: 0 },
      },
    },
  }
})
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'spotify'
      ? (await import('@/plugins/builtin/spotify')).spotifyPlugin
      : null,
  listLoadedScrapePlugins: async () => [],
}))
// The account connection has its own tests; the sync reads Spotify through
// the real request gate with a fixed account token.
vi.mock('@/services/spotify-oauth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/spotify-oauth')>()
  return {
    ...actual,
    getSpotifyAccountStatus: async () => ({
      configured: account.configured,
      connected: account.configured && account.connected,
      expiresAt: null,
      scope: account.connected ? 'user-library-read' : null,
      redirectUri: account.configured
        ? 'http://127.0.0.1:4001/api/v1/spotify/callback'
        : null,
      playback: false,
      playlists: false,
      playlistChanges: false,
    }),
    spotifyAccountToken: async () => 'fixture-access-token',
  }
})
// Two steps per job, so longer syncs chain follow-on jobs.
vi.mock('@/services/spotify-podcast-sync', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/spotify-podcast-sync')>()
  return {
    ...actual,
    runSpotifyPodcastSyncJob: (context: LastfmSyncJobContext) =>
      actual.runSpotifyPodcastSyncJob(context, { maxSteps: 2 }),
  }
})

type FakeEpisode = {
  id: string
  name: string
  description?: string
  date: string
  precision?: 'year' | 'month' | 'day'
  durationMs?: number
}
type FakeShow = {
  id: string
  name: string
  saved: boolean
  /** Spotify answers 404 for its episodes. */
  removed?: boolean
  /** Newest first, as Spotify lists them; null is an entry Spotify returns empty. */
  episodes: Array<FakeEpisode | null>
}

const spotifyId = (key: string) => key.padEnd(22, '0')
const ORBIT = spotifyId('orbittalk')
const KITCHEN = spotifyId('kitchennotes')
const QUIET = spotifyId('quiethours')
const episodeId = (key: string) => spotifyId(`ep${key}`)
// The fixture API pages by two whatever page size is requested.
const PAGE = 2

function library(): FakeShow[] {
  return [
    {
      id: ORBIT,
      name: 'Orbit Talk Fixture',
      saved: true,
      episodes: [
        {
          id: episodeId('o5'),
          name: 'Gravity assists in practice',
          description: 'Slingshots around the outer planets.',
          date: '2026-05-01',
          durationMs: 1_800_400,
        },
        {
          id: episodeId('o4'),
          name: 'Life aboard a station',
          date: '2026-04-01',
        },
        { id: episodeId('o3'), name: 'Docking procedures', date: '2026-03-01' },
        { id: episodeId('o2'), name: 'Reentry heat', date: '2026-02-01' },
        { id: episodeId('o1'), name: 'Pilot episode', date: '2026-01-01' },
      ],
    },
    {
      id: KITCHEN,
      name: 'Kitchen Notes Fixture',
      saved: true,
      episodes: [
        {
          id: episodeId('k3'),
          name: 'Fermentation basics',
          date: '2024-03',
          precision: 'day',
        },
        {
          id: episodeId('k2'),
          name: 'Knife care',
          date: '2022-05',
          precision: 'month',
        },
        {
          id: episodeId('k1'),
          name: 'Stocking a pantry',
          date: '2021',
          precision: 'year',
        },
      ],
    },
    {
      id: QUIET,
      name: 'Quiet Hours Fixture',
      saved: true,
      episodes: [
        { id: episodeId('q1'), name: 'Evening reading', date: '2025-11-20' },
      ],
    },
  ]
}

const idle: (count: number) => Promise<void> = async () => {}

const api: {
  shows: FakeShow[]
  /** Reported as the saved-show total instead of the real count. */
  listedTotal: number | null
  /** Answers this numbered API request with `failStatus`; a 429 carries Retry-After. */
  failAt: number
  failStatus: number
  apiRequests: number
  before: typeof idle
} = {
  shows: library(),
  listedTotal: null,
  failAt: 0,
  failStatus: 500,
  apiRequests: 0,
  before: idle,
}

function showJson(show: FakeShow) {
  return {
    id: show.id,
    name: show.name,
    description: `About ${show.name}`,
    html_description: `<p>About ${show.name}</p>`,
    images: [
      { url: `https://i.scdn.example/${show.id}.jpg`, height: 640, width: 640 },
    ],
    total_episodes: show.episodes.length,
    media_type: 'audio',
    explicit: false,
    languages: ['en'],
    is_externally_hosted: false,
    external_urls: { spotify: `https://open.spotify.com/show/${show.id}` },
    type: 'show',
    uri: `spotify:show:${show.id}`,
  }
}

function episodeJson(episode: FakeEpisode | null) {
  if (!episode) return null
  return {
    id: episode.id,
    name: episode.name,
    description: episode.description ?? '',
    html_description: episode.description ?? '',
    duration_ms: episode.durationMs ?? 600_000,
    release_date: episode.date,
    release_date_precision:
      episode.precision ??
      (episode.date.length === 4
        ? 'year'
        : episode.date.length === 7
          ? 'month'
          : 'day'),
    images: [{ url: `https://i.scdn.example/${episode.id}.jpg` }],
    explicit: false,
    is_playable: true,
    languages: ['en'],
    external_urls: {
      spotify: `https://open.spotify.com/episode/${episode.id}`,
    },
    type: 'episode',
    uri: `spotify:episode:${episode.id}`,
  }
}

function paged<T>(items: T[], url: URL, total = items.length) {
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const next = offset + PAGE
  return {
    href: url.toString(),
    limit: PAGE,
    offset,
    previous: null,
    total,
    items: items.slice(offset, next),
    next:
      next < items.length
        ? `${url.origin}${url.pathname}?offset=${next}`
        : null,
  }
}

async function fakeSpotify(input: Parameters<typeof fetch>[0]) {
  const url = new URL(String(input))
  if (url.host !== 'api.spotify.com') throw new Error('Unexpected request')
  api.apiRequests += 1
  await api.before(api.apiRequests)
  if (api.apiRequests === api.failAt)
    return api.failStatus === 429
      ? Response.json(
          { error: { status: 429, message: 'API rate limit exceeded' } },
          { status: 429, headers: { 'Retry-After': '120' } },
        )
      : Response.json(
          { error: { status: api.failStatus, message: 'Fixture failure' } },
          { status: api.failStatus },
        )
  if (url.pathname === '/v1/me/shows') {
    const saved = api.shows.filter((show) => show.saved)
    return Response.json(
      paged(
        saved.map((show) => ({
          added_at: '2026-01-01T00:00:00Z',
          show: showJson(show),
        })),
        url,
        api.listedTotal ?? saved.length,
      ),
    )
  }
  const match = /^\/v1\/shows\/([A-Za-z0-9]{22})\/episodes$/.exec(url.pathname)
  const show = api.shows.find((item) => item.id === match?.[1])
  if (!show) throw new Error('Unexpected request')
  if (show.removed)
    return Response.json(
      { error: { status: 404, message: 'Non existing id' } },
      { status: 404 },
    )
  return Response.json(paged(show.episodes.map(episodeJson), url))
}

function show(id: string) {
  const found = api.shows.find((item) => item.id === id)
  if (!found) throw new Error('Missing fixture show')
  return found
}

/** Each Spotify API request as `path@offset`. */
function apiCalls() {
  return request.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.host === 'api.spotify.com')
    .map(
      (url) =>
        `${url.pathname.replace('/v1/', '').replace(/\/episodes$/, '')}@${url.searchParams.get('offset')}`,
    )
}

async function status() {
  const { getSpotifyPodcastSyncStatus } =
    await import('@/services/spotify-podcast-sync')
  return getSpotifyPodcastSyncStatus(USER)
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
  const { queueSubscriptionSync } = await import('@/services/subscription-sync')
  await queueSubscriptionSync('spotify', USER)
  return drain()
}

// Stands in for a cooldown, request backoff or access halt being cleared.
async function clearProviderState() {
  await databaseClient.delete(schema.providerRequestState)
}

async function search(input: SubscriptionItemQueryInput) {
  const { listSubscriptionItems } =
    await import('@/services/subscription-library')
  const page = await listSubscriptionItems(
    SubscriptionItemQuerySchema.parse(input),
  )
  return { ...page, ids: page.items.map((item) => item.id) }
}

async function source(id: string) {
  const [row] = await databaseClient
    .select()
    .from(schema.subscriptionSource)
    .where(eq(schema.subscriptionSource.id, id))
  return row
}

const allEpisodes = ['o5', 'o4', 'o3', 'o2', 'o1', 'q1', 'k3', 'k2', 'k1'].map(
  episodeId,
)

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
    shows: library(),
    listedTotal: null,
    failAt: 0,
    failStatus: 500,
    apiRequests: 0,
    before: idle,
  })
  Object.assign(account, { configured: true, connected: true })
  request.mockReset()
  request.mockImplementation(fakeSpotify)
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.subscriptionItem)
  await databaseClient.delete(schema.subscriptionSource)
  await databaseClient.delete(schema.subscriptionSync)
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

describe('Spotify podcast sync jobs with offline HTTP and a temporary database', () => {
  it('refuses to sync until Spotify is configured and connected', async () => {
    const { queueSubscriptionSync } =
      await import('@/services/subscription-sync')
    account.configured = false
    expect((await status()).account).toEqual({
      configured: false,
      connected: false,
      redirectUri: null,
    })
    await expect(queueSubscriptionSync('spotify', USER)).rejects.toMatchObject({
      statusCode: 422,
      message:
        'Spotify is not configured. Configure and connect the account first.',
    })
    account.configured = true
    account.connected = false
    await expect(queueSubscriptionSync('spotify', USER)).rejects.toMatchObject({
      statusCode: 422,
      message: 'Connect a Spotify account before syncing podcasts.',
    })
    expect(await syncJobs()).toHaveLength(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('reads every saved podcast and episode as chained jobs', async () => {
    const done = await syncToEnd()
    expect(done).toMatchObject({
      provider: 'spotify',
      account: { configured: true, connected: true },
      state: 'complete',
      phase: 'items',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 9,
      storedSources: 3,
      storedItems: 9,
      schedule: 'daily',
      resumeAfter: null,
      errorMessage: null,
    })
    // Two pages of saved podcasts, then each podcast's episodes in ID order.
    expect(apiCalls()).toEqual([
      'me/shows@0',
      'me/shows@2',
      `shows/${KITCHEN}@0`,
      `shows/${KITCHEN}@2`,
      `shows/${ORBIT}@0`,
      `shows/${ORBIT}@2`,
      `shows/${ORBIT}@4`,
      `shows/${QUIET}@0`,
    ])
    expect(
      new URL(String(request.mock.calls[0]?.[0])).searchParams.get('limit'),
    ).toBe('50')
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-access-token')

    const jobs = await syncJobs()
    expect(jobs.length).toBeGreaterThan(1)
    expect(new Set(jobs.map((job) => `${job.provider}:${job.status}`))).toEqual(
      new Set(['spotify:succeeded']),
    )
    expect(jobs[0]?.options).toEqual({ task: 'spotify-podcast-sync' })
    expect(jobs[1]?.options).toEqual({
      task: 'spotify-podcast-sync',
      continues: jobs[0]?.id,
    })
    const { getJob } = await import('@/services/jobs')
    expect((await getJob(jobs.at(-1)?.id ?? ''))?.logs.at(-1)?.message).toBe(
      'Sync complete. 9 new episodes; 9 episodes from 3 saved podcasts are stored.',
    )

    const { listSubscriptionSources } =
      await import('@/services/subscription-library')
    expect((await listSubscriptionSources({ type: 'spotify' })).items).toEqual([
      expect.objectContaining({
        id: KITCHEN,
        type: 'spotify',
        title: 'Kitchen Notes Fixture',
        description: 'About Kitchen Notes Fixture',
        thumbnailUrl: `https://i.scdn.example/${KITCHEN}.jpg`,
        itemTotal: 3,
        storedItems: 3,
        historyComplete: true,
      }),
      expect.objectContaining({ id: ORBIT, itemTotal: 5, storedItems: 5 }),
      expect.objectContaining({ id: QUIET, itemTotal: 1, storedItems: 1 }),
    ])
    expect((await search({})).ids).toEqual(allEpisodes)
    expect((await search({ q: 'gravity' })).items[0]).toMatchObject({
      id: episodeId('o5'),
      type: 'spotify',
      sourceId: ORBIT,
      sourceTitle: 'Orbit Talk Fixture',
      title: 'Gravity assists in practice',
      description: 'Slingshots around the outer planets.',
      tags: [],
      publishedAt: '2026-05-01T00:00:00.000Z',
      publishedPrecision: 'day',
      durationSec: 1800,
      artworkUrl: `https://i.scdn.example/${episodeId('o5')}.jpg`,
    })
  })

  it('stores release dates at the precision Spotify reports', async () => {
    await syncToEnd()
    const items = (await search({ q: 'kitchen', sortBy: 'publishedAt' })).items
    expect(
      items.map((item) => [
        item.title,
        item.publishedAt,
        item.publishedPrecision,
      ]),
    ).toEqual([
      // A month-long date reported with day precision keeps the month.
      ['Fermentation basics', '2024-03-01T00:00:00.000Z', 'month'],
      ['Knife care', '2022-05-01T00:00:00.000Z', 'month'],
      ['Stocking a pantry', '2021-01-01T00:00:00.000Z', 'year'],
    ])
  })

  it('makes only the saved-podcast requests when nothing changed', async () => {
    await syncToEnd()
    request.mockClear()
    const second = await syncToEnd()
    expect(second).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 0,
      storedItems: 9,
    })
    expect(apiCalls()).toEqual(['me/shows@0', 'me/shows@2'])
  })

  it('reads only the newest page of a podcast with new episodes', async () => {
    await syncToEnd()
    request.mockClear()
    const orbit = show(ORBIT)
    orbit.name = 'Orbit Talk Renamed Fixture'
    orbit.episodes.unshift({
      id: episodeId('o6'),
      name: 'Solar sails',
      date: '2026-06-01',
    })

    const second = await syncToEnd()
    expect(second).toMatchObject({
      state: 'complete',
      newItems: 1,
      storedItems: 10,
    })
    // Its first page holds a known episode; the other podcasts are unchanged.
    expect(apiCalls()).toEqual(['me/shows@0', 'me/shows@2', `shows/${ORBIT}@0`])
    expect((await search({ q: 'solar' })).ids).toEqual([episodeId('o6')])
    // Episodes not read again are found under the new podcast name.
    expect((await search({ q: 'renamed pilot' })).ids).toEqual([
      episodeId('o1'),
    ])
    expect((await source(ORBIT))?.itemTotal).toBe(6)

    // An unchanged podcast is skipped again on the next sync.
    request.mockClear()
    await syncToEnd()
    expect(apiCalls()).toEqual(['me/shows@0', 'me/shows@2'])
  })

  it('reads every page of a podcast listed oldest first', async () => {
    show(ORBIT).episodes.reverse()
    await syncToEnd()
    request.mockClear()
    show(ORBIT).episodes.push({
      id: episodeId('o6'),
      name: 'Solar sails',
      date: '2026-06-01',
    })
    expect(await syncToEnd()).toMatchObject({ newItems: 1, storedItems: 10 })
    expect(apiCalls()).toEqual([
      'me/shows@0',
      'me/shows@2',
      `shows/${ORBIT}@0`,
      `shows/${ORBIT}@2`,
      `shows/${ORBIT}@4`,
    ])
  })

  it('hides an unsaved podcast without requesting it and leaves YouTube channels subscribed', async () => {
    const channel = `UC${'fixture'.padEnd(22, '0')}`
    await databaseClient.insert(schema.subscriptionSource).values({
      id: channel,
      type: 'youtube',
      title: 'Kepler Mechanics Lab',
      seenRunId: 'youtube-run',
    })
    await databaseClient.insert(schema.subscriptionItem).values({
      id: 'videofixt01',
      sourceId: channel,
      type: 'youtube',
      title: 'Transfer orbits explained',
      publishedAt: new Date('2026-03-01T23:30:00Z'),
      search: subscriptionSearchVector(
        sql`${'Transfer orbits explained'}::text`,
        sql`${'Kepler Mechanics Lab'}::text`,
        sql`''::text`,
        sql`''::text`,
      ),
    })
    await syncToEnd()
    request.mockClear()
    show(KITCHEN).saved = false

    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 2,
      sourcesTotal: 2,
      storedSources: 2,
      storedItems: 6,
    })
    expect(apiCalls()).toEqual(['me/shows@0'])
    expect(await source(KITCHEN)).toMatchObject({ subscribed: false })
    expect(await source(channel)).toMatchObject({
      type: 'youtube',
      subscribed: true,
      seenRunId: 'youtube-run',
    })
    // The episodes are kept but leave the library until the podcast is saved again.
    expect((await search({ q: 'knife' })).ids).toEqual([])
    expect(
      await databaseClient.$count(
        schema.subscriptionItem,
        eq(schema.subscriptionItem.sourceId, KITCHEN),
      ),
    ).toBe(3)
    expect((await search({ q: 'transfer' })).ids).toEqual(['videofixt01'])

    show(KITCHEN).saved = true
    expect(await syncToEnd()).toMatchObject({ storedItems: 9, newItems: 0 })
    expect((await search({ q: 'knife' })).ids).toEqual([episodeId('k2')])
  })

  it('skips a podcast Spotify no longer has and skips empty entries', async () => {
    show(QUIET).removed = true
    show(ORBIT).episodes.splice(2, 0, null)
    const done = await syncToEnd()
    expect(done).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      storedSources: 3,
      storedItems: 8,
      errorMessage: null,
    })
    expect(apiCalls()).toContain(`shows/${QUIET}@0`)
    expect(await source(QUIET)).toMatchObject({
      subscribed: true,
      historyComplete: false,
    })
    expect(await source(ORBIT)).toMatchObject({
      itemTotal: 6,
      historyComplete: true,
    })
    const { getProviderSafety } = await import('@/services/provider-requests')
    expect(await getProviderSafety('spotify')).toMatchObject({
      halted: false,
      cooldownUntil: null,
    })
  })

  it('pauses on a rate limit and lets the schedule resume from the checkpoint', async () => {
    const { queueDueSpotifyPodcastSync } =
      await import('@/services/spotify-podcast-sync-jobs')
    // The saved podcasts and the first episode page fit; the next request does not.
    api.failAt = 4
    api.failStatus = 429
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
    expect(resumeAfter).toBeGreaterThanOrEqual(before + 120_000)
    expect(paused.nextScheduledAt).toBe(paused.resumeAfter)
    const jobs = await syncJobs()
    expect(jobs.at(-1)?.status).toBe('succeeded')
    const { getJob, listJobs } = await import('@/services/jobs')
    expect((await getJob(jobs.at(-1)?.id ?? ''))?.logs.at(-1)?.message).toMatch(
      /^Paused: Provider rate limit reached\. Stored episodes are kept;/,
    )
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)

    // Not due yet, and still held while Spotify cools down.
    expect(await queueDueSpotifyPodcastSync(resumeAfter - 1000)).toBe(false)
    expect(await queueDueSpotifyPodcastSync(resumeAfter + 1000)).toBe(false)
    await clearProviderState()
    api.failAt = 0
    request.mockClear()
    expect(await queueDueSpotifyPodcastSync(resumeAfter + 1000)).toBe(true)
    expect(await drain()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      newItems: 9,
      storedItems: 9,
      resumeAfter: null,
    })
    // The run continues at the second episode page; nothing is read twice.
    expect(apiCalls()[0]).toBe(`shows/${KITCHEN}@2`)
    expect(apiCalls().some((call) => call.startsWith('me/shows'))).toBe(false)
  })

  it('halts Spotify and fails the run when Spotify rejects the token', async () => {
    api.failAt = 3
    api.failStatus = 401
    const failed = await syncToEnd()
    expect(failed).toMatchObject({
      state: 'failed',
      errorMessage: 'Provider request failed (HTTP 401)',
      nextScheduledAt: null,
      job: { status: 'failed' },
    })
    expect(apiCalls()).toHaveLength(3)
    const { getProviderSafety } = await import('@/services/provider-requests')
    expect((await getProviderSafety('spotify')).halted).toBe(true)
    const { queueSubscriptionSync } =
      await import('@/services/subscription-sync')
    await expect(queueSubscriptionSync('spotify', USER)).rejects.toMatchObject({
      statusCode: 429,
      message: 'Provider requests are halted after access denial',
    })
    expect(apiCalls()).toHaveLength(3)
  })

  it('fails on a provider error without an automatic retry, then resumes on request', async () => {
    const { queueDueSpotifyPodcastSync } =
      await import('@/services/spotify-podcast-sync-jobs')
    api.failAt = 5
    const failed = await syncToEnd()
    expect(failed).toMatchObject({
      state: 'failed',
      storedItems: 3,
      errorMessage: 'Provider request failed (HTTP 500)',
      nextScheduledAt: null,
    })
    await clearProviderState()
    // The schedule never resumes a failed run.
    expect(await queueDueSpotifyPodcastSync(Date.now() + 365 * 86400000)).toBe(
      false,
    )
    api.failAt = 0
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 9,
    })
    expect(apiCalls()[0]).toBe(`shows/${ORBIT}@0`)
  })

  it('discards the in-flight page when the job is cancelled and resumes on request', async () => {
    const { bulkCancelJobs } = await import('@/services/jobs')
    api.before = async (count) => {
      if (count !== 3) return
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
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 9,
    })
    expect(apiCalls()[0]).toBe(`shows/${KITCHEN}@0`)
  })

  it('fails when the saved podcasts change while they are read, and reads them again from the start', async () => {
    api.before = async (count) => {
      if (count === 2) api.listedTotal = 4
    }
    const failed = await syncToEnd()
    expect(failed).toMatchObject({
      state: 'failed',
      errorMessage:
        'The saved podcasts changed while they were read. Resume the sync to read the list from the start.',
      storedSources: 2,
    })
    const { getProviderSafety } = await import('@/services/provider-requests')
    expect(await getProviderSafety('spotify')).toMatchObject({
      halted: false,
      cooldownUntil: null,
    })

    api.before = idle
    api.listedTotal = null
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 9,
    })
    expect(apiCalls().slice(0, 2)).toEqual(['me/shows@0', 'me/shows@2'])
  })

  it.each([
    { schedule: '1h', minutes: 60 },
    { schedule: 'daily', minutes: 1440 },
    { schedule: 'weekly', minutes: 10080 },
  ])(
    'queues a $schedule sync only when due after a completed sync',
    async ({ schedule, minutes }) => {
      const { SubscriptionSyncScheduleSchema } =
        await import('@repo/schemas/subscriptions')
      const { setSubscriptionSyncSchedule } =
        await import('@/services/subscription-sync')
      const { queueDueSpotifyPodcastSync } =
        await import('@/services/spotify-podcast-sync-jobs')
      const day = 24 * 60 * 60 * 1000

      // The setting can be saved first, but the schedule never starts the first sync.
      expect(
        await setSubscriptionSyncSchedule('spotify', USER, 'weekly'),
      ).toMatchObject({
        state: 'never',
        schedule: 'weekly',
        nextScheduledAt: null,
        startedAt: null,
      })
      expect(await queueDueSpotifyPodcastSync(Date.now() + 365 * day)).toBe(
        false,
      )

      const completed = await syncToEnd()
      const completedAt = Date.parse(completed.lastCompletedAt ?? '')
      const interval = minutes * 60 * 1000
      expect(
        (
          await setSubscriptionSyncSchedule(
            'spotify',
            USER,
            SubscriptionSyncScheduleSchema.parse(schedule),
          )
        ).nextScheduledAt,
      ).toBe(new Date(completedAt + interval).toISOString())
      expect(
        await queueDueSpotifyPodcastSync(completedAt + interval - 1000),
      ).toBe(false)
      expect(await queueDueSpotifyPodcastSync(completedAt + interval)).toBe(
        true,
      )
      // The queued job is found instead of adding a second one.
      expect(await queueDueSpotifyPodcastSync(completedAt + interval)).toBe(
        false,
      )
      const jobs = await syncJobs()
      expect(jobs.at(-1)?.options).toEqual({ task: 'spotify-podcast-sync' })
      expect((await drain()).state).toBe('complete')
    },
  )

  it('keeps the YouTube schedule and status separate', async () => {
    await syncToEnd()
    const { getSubscriptionSyncStatus } =
      await import('@/services/subscription-sync')
    expect(await getSubscriptionSyncStatus('youtube', USER)).toMatchObject({
      provider: 'youtube',
      state: 'never',
      storedSources: 0,
      storedItems: 0,
    })
  })
})

describe('podcast episodes in the Subscriptions library', () => {
  beforeEach(async () => {
    const channel = `UC${'orbitvideos'.padEnd(22, '0')}`
    await databaseClient.insert(schema.subscriptionSource).values({
      id: channel,
      type: 'youtube',
      title: 'Orbit Videos Fixture',
    })
    await databaseClient.insert(schema.subscriptionItem).values({
      id: 'videofixt02',
      sourceId: channel,
      type: 'youtube',
      title: 'Orbit talk recap',
      publishedAt: new Date('2026-07-01T00:00:00Z'),
      search: subscriptionSearchVector(
        sql`${'Orbit talk recap'}::text`,
        sql`${'Orbit Videos Fixture'}::text`,
        sql`''::text`,
        sql`''::text`,
      ),
    })
    await syncToEnd()
    request.mockClear()
  })

  it('finds an episode by its podcast name and by a partial word', async () => {
    expect((await search({ q: 'quiet hours' })).ids).toEqual([episodeId('q1')])
    expect((await search({ q: 'ferment' })).ids).toEqual([episodeId('k3')])
    expect((await search({ q: 'slingsh' })).ids).toEqual([episodeId('o5')])
    expect((await search({ q: 'gravity', fields: 'title' })).ids).toEqual([
      episodeId('o5'),
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it('filters by type', async () => {
    const podcasts = await search({
      filters: JSON.stringify([{ field: 'type', value: 'Podcast' }]),
    })
    expect(podcasts.ids).toEqual(allEpisodes)
    expect(new Set(podcasts.items.map((item) => item.type))).toEqual(
      new Set(['spotify']),
    )
    expect(
      (
        await search({
          q: 'orbit',
          filters: JSON.stringify([{ field: 'type', value: 'YouTube' }]),
        })
      ).ids,
    ).toEqual(['videofixt02'])
    expect(
      (
        await search({
          filters: JSON.stringify([
            { field: 'source', value: 'orbit talk fixture' },
          ]),
        })
      ).totalCount,
    ).toBe(5)
  })
})
