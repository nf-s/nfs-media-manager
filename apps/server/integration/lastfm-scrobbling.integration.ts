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
import * as schema from '@/schemas/db'
import type { LastfmPlay } from '@repo/schemas/lastfm'

const database = `lastfm_scrobbling_${randomUUID().replaceAll('-', '')}`
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
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...actual.env,
      APP_URL: 'https://web.example.test',
      AUTH_BASE_URL: 'https://api.example.test',
      TRUSTED_ORIGINS: ['https://web.example.test', 'https://api.example.test'],
    },
  }
})
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    apiKey: 'offline-fixture-key',
    apiSecret: 'offline-fixture-secret',
  }),
}))

const USER = 'fixture-user'
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const TRACK_A = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA'
const TRACK_B = 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB'

function play(trackUri: string, startedAt: number, name = 'Fixture Track') {
  return {
    trackUri,
    track: name,
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    durationMs: 200000,
    startedAt,
  } satisfies LastfmPlay
}

const entry = (code: number) => ({
  ignoredMessage: { code: String(code), '#text': '' },
  timestamp: '1762000000',
})
function answer(codes: number[]) {
  const entries = codes.map(entry)
  return {
    scrobbles: {
      scrobble: entries.length === 1 ? entries[0] : entries,
      '@attr': {
        accepted: codes.filter((code) => code === 0).length,
        ignored: codes.filter((code) => code !== 0).length,
      },
    },
  }
}
/** Answers each scrobble request with every scrobble accepted. */
function acceptAll() {
  request.mockImplementation(async (_url, init) => {
    const body = new URLSearchParams(String(init?.body))
    const count = [...body.keys()].filter((key) =>
      key.startsWith('artist['),
    ).length
    return Response.json(answer(Array.from({ length: count }, () => 0)))
  })
}
function sentForm(call: number) {
  return new URLSearchParams(String(request.mock.calls[call]?.[1]?.body))
}

async function service() {
  return import('@/services/lastfm-scrobbling')
}
async function plays() {
  return databaseClient
    .select()
    .from(schema.lastfmPlay)
    .orderBy(schema.lastfmPlay.startedAt)
}
async function providerState() {
  const [state] = await databaseClient
    .select()
    .from(schema.providerRequestState)
    .where(eq(schema.providerRequestState.provider, 'lastfm'))
  return state
}

async function signIn() {
  const { authorizeLastfmScrobbling, finishLastfmScrobbling } = await service()
  const { url } = await authorizeLastfmScrobbling(
    USER,
    'fixture-session',
    'https://web.example.test',
  )
  const callback = new URL(new URL(url).searchParams.get('cb') ?? '')
  const state = callback.pathname.split('/').at(-1) ?? ''
  request.mockImplementationOnce(async () =>
    Response.json({
      session: { name: 'fixture-listener', key: 'fixture-sk', subscriber: 0 },
    }),
  )
  return finishLastfmScrobbling(
    state,
    { token: 'fixturetoken0123456789abcdef01' },
    USER,
    'fixture-session',
  )
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.user).values({
    id: USER,
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 'admin',
  })
})
beforeEach(async () => {
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.lastfmPlay)
  await databaseClient.delete(schema.providerSecret)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  expect(await signIn()).toEqual({
    connected: true,
    returnOrigin: 'https://web.example.test',
  })
  request.mockClear()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('Last.fm scrobbling with offline HTTP and a temporary database', () => {
  it('signs in, keeps new plays once and scrobbles them in one signed POST', async () => {
    const { getLastfmScrobblingStatus, scrobbleLastfmPlays } = await service()
    expect(await getLastfmScrobblingStatus(USER)).toEqual({
      configured: true,
      connected: true,
      account: 'fixture-listener',
    })
    const now = Date.now()
    acceptAll()
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [
          play(TRACK_A, now - 10 * MINUTE),
          // The same play reported again with a slightly different clock.
          play(TRACK_A, now - 10 * MINUTE + 4000),
          play(TRACK_B, now - 6 * MINUTE, 'Second Track'),
        ],
      }),
    ).toEqual({ connected: true, accepted: 2, scrobbled: 2, waiting: 0 })
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0] ?? []
    expect(url).toBe('https://ws.audioscrobbler.com/2.0/')
    expect(init?.method).toBe('POST')
    const form = sentForm(0)
    expect(Object.fromEntries(form)).toMatchObject({
      method: 'track.scrobble',
      api_key: 'offline-fixture-key',
      sk: 'fixture-sk',
      format: 'json',
      'artist[0]': 'Fixture Artist',
      'track[0]': 'Fixture Track',
      'album[0]': 'Fixture Album',
      'duration[0]': '200',
      'timestamp[0]': String(Math.floor((now - 10 * MINUTE) / 1000)),
      'track[1]': 'Second Track',
    })
    expect(form.get('api_sig')).toMatch(/^[0-9a-f]{32}$/)
    expect(form.toString()).not.toContain('offline-fixture-secret')
    expect((await plays()).map((row) => row.status)).toEqual(['sent', 'sent'])

    // A later report of the same plays keeps nothing and sends nothing.
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [play(TRACK_B, now - 6 * MINUTE + 1000, 'Second Track')],
      }),
    ).toEqual({ connected: true, accepted: 0, scrobbled: 0, waiting: 0 })
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps one copy of a play several pages report at the same time', async () => {
    const { scrobbleLastfmPlays } = await service()
    const now = Date.now()
    acceptAll()
    // Open enough pooled connections that the reports overlap in the database.
    await Promise.all(
      Array.from({ length: 8 }, () => pool.query('select pg_sleep(0.02)')),
    )
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        scrobbleLastfmPlays(USER, {
          plays: [play(TRACK_A, now - 5 * MINUTE + index * 1000)],
        }),
      ),
    )
    expect(results.map((result) => result.accepted).sort()).toEqual([
      0, 0, 0, 0, 0, 1,
    ])
    expect(results.reduce((sum, result) => sum + result.scrobbled, 0)).toBe(1)
    expect(await plays()).toHaveLength(1)
    expect(request).toHaveBeenCalledOnce()
  })

  it('sends waiting plays oldest first in batches of 50 and records ignored scrobbles', async () => {
    const { scrobbleLastfmPlays } = await service()
    const now = Date.now()
    await databaseClient.insert(schema.lastfmPlay).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: `waiting-${index}`,
        userId: USER,
        trackUri: TRACK_A,
        artist: 'Fixture Artist',
        track: `Track ${index}`,
        startedAt: new Date(now - 2 * DAY + index * 5 * MINUTE),
      })),
    )
    const codes = [
      Array.from({ length: 50 }, (_, index) => (index === 3 ? 1 : 0)),
      Array.from({ length: 50 }, () => 0),
      [0],
    ]
    for (const batch of codes)
      request.mockImplementationOnce(async () => Response.json(answer(batch)))
    expect(
      await scrobbleLastfmPlays(USER, { plays: [play(TRACK_B, now - MINUTE)] }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 100, waiting: 0 })
    expect(request).toHaveBeenCalledTimes(3)
    expect(sentForm(0).get('track[0]')).toBe('Track 0')
    expect(sentForm(0).has('track[49]')).toBe(true)
    expect(sentForm(0).has('track[50]')).toBe(false)
    expect(sentForm(1).get('track[0]')).toBe('Track 50')
    // A batch of one is answered as an object rather than an array.
    expect(sentForm(2).get('track[0]')).toBe('Fixture Track')
    expect(sentForm(2).has('album[0]')).toBe(true)
    const ignored = (await plays()).filter((row) => row.status === 'ignored')
    expect(ignored.map((row) => [row.track, row.ignoredCode])).toEqual([
      ['Track 3', 1],
    ])
  })

  it('leaves plays waiting when Last.fm is unavailable, without a provider cooldown', async () => {
    const { scrobbleLastfmPlays } = await service()
    const now = Date.now()
    request.mockImplementationOnce(
      async () => new Response('Service Unavailable', { status: 503 }),
    )
    expect(
      await scrobbleLastfmPlays(USER, { plays: [play(TRACK_A, now - MINUTE)] }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 0, waiting: 1 })
    request.mockImplementationOnce(async () =>
      Response.json({ error: 16, message: 'Temporary error' }),
    )
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [play(TRACK_B, now - 30000, 'Second Track')],
      }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 0, waiting: 2 })
    const state = await providerState()
    expect(state?.halted).toBe(false)
    expect(state?.cooldownUntil).toBeNull()

    acceptAll()
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [play(TRACK_A, now - MINUTE)],
      }),
    ).toEqual({ connected: true, accepted: 0, scrobbled: 2, waiting: 0 })
    expect(sentForm(2).get('track[0]')).toBe('Fixture Track')
    expect(sentForm(2).get('track[1]')).toBe('Second Track')
  })

  it('starts the provider cooldown on a rate limit and sends nothing while it lasts', async () => {
    const { scrobbleLastfmPlays } = await service()
    const now = Date.now()
    request.mockImplementationOnce(async () =>
      Response.json({ error: 29, message: 'Rate Limit Exceeded' }),
    )
    expect(
      await scrobbleLastfmPlays(USER, { plays: [play(TRACK_A, now - MINUTE)] }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 0, waiting: 1 })
    expect((await providerState())?.cooldownUntil?.getTime()).toBeGreaterThan(
      Date.now(),
    )
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [play(TRACK_B, now - 30000)],
      }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 0, waiting: 2 })
    expect(request).toHaveBeenCalledOnce()
  })

  it('asks for a new sign-in when Last.fm refuses the session, without halting the provider', async () => {
    const { getLastfmScrobblingStatus, scrobbleLastfmPlays } = await service()
    const now = Date.now()
    request.mockImplementationOnce(async () =>
      Response.json(
        { error: 9, message: 'Invalid session key - Please re-authenticate' },
        { status: 403 },
      ),
    )
    expect(
      await scrobbleLastfmPlays(USER, { plays: [play(TRACK_A, now - MINUTE)] }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 0, waiting: 1 })
    expect(await getLastfmScrobblingStatus(USER)).toEqual({
      configured: true,
      connected: false,
      account: null,
    })
    expect((await providerState())?.halted ?? false).toBe(false)
    expect(
      await scrobbleLastfmPlays(USER, { plays: [play(TRACK_B, now)] }),
    ).toEqual({ connected: false, accepted: 0, scrobbled: 0, waiting: 0 })
    expect((await plays()).map((row) => row.status)).toEqual(['waiting'])
  })

  it('halts the provider when Last.fm refuses the API key, as the history sync does', async () => {
    const { scrobbleLastfmPlays } = await service()
    request.mockImplementationOnce(async () =>
      Response.json({ error: 10, message: 'Invalid API key' }, { status: 403 }),
    )
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [play(TRACK_A, Date.now() - MINUTE)],
      }),
    ).toEqual({ connected: true, accepted: 1, scrobbled: 0, waiting: 1 })
    expect((await providerState())?.halted).toBe(true)
  })

  it('drops plays Last.fm would refuse as too old instead of sending them', async () => {
    const { scrobbleLastfmPlays } = await service()
    const now = Date.now()
    await databaseClient.insert(schema.lastfmPlay).values([
      {
        id: 'stale',
        userId: USER,
        trackUri: TRACK_A,
        artist: 'Fixture Artist',
        track: 'Stale Track',
        startedAt: new Date(now - 14 * DAY - MINUTE),
      },
      {
        id: 'expired',
        userId: USER,
        trackUri: TRACK_A,
        artist: 'Fixture Artist',
        track: 'Expired Track',
        status: 'sent',
        startedAt: new Date(now - 16 * DAY),
      },
    ])
    acceptAll()
    expect(
      await scrobbleLastfmPlays(USER, {
        plays: [
          play(TRACK_B, now - 14 * DAY - MINUTE),
          play(TRACK_B, now + 6 * MINUTE),
        ],
      }),
    ).toEqual({ connected: true, accepted: 0, scrobbled: 0, waiting: 0 })
    expect(request).not.toHaveBeenCalled()
    expect(
      (await plays()).map((row) => [row.id, row.status, row.ignoredCode]),
    ).toEqual([['stale', 'ignored', null]])
  })

  it('disconnects by deleting the session and the plays still waiting', async () => {
    const { disconnectLastfmScrobbling, getLastfmScrobblingStatus } =
      await service()
    const now = Date.now()
    await databaseClient.insert(schema.lastfmPlay).values(
      ['waiting', 'sent'].map((status, index) => ({
        id: status,
        userId: USER,
        trackUri: TRACK_A,
        artist: 'Fixture Artist',
        track: 'Fixture Track',
        status,
        startedAt: new Date(now - (index + 1) * 10 * MINUTE),
      })),
    )
    expect(await disconnectLastfmScrobbling(USER)).toEqual({
      disconnected: true,
    })
    expect((await getLastfmScrobblingStatus(USER)).connected).toBe(false)
    expect((await plays()).map((row) => row.id)).toEqual(['sent'])
    expect(await databaseClient.select().from(schema.providerSecret)).toEqual(
      [],
    )
  })
})
