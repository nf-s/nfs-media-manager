import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { hashPassword } from 'better-auth/crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SONOS_PLAYBACK_CLIENT_HEADER } from '@repo/schemas/playback'
import {
  SONOS_SCOPE,
  SonosGroupStateSchema,
  SonosRoomsSchema,
} from '@repo/schemas/sonos'
import { eq } from 'drizzle-orm'
import { env } from '@/env'
import { encryptSecretValue } from '@/lib/crypto'
import { SONOS_CONTROL_API } from '@/lib/sonos-api'
import * as schema from '@/schemas/db'

const fixture = vi.hoisted(() => ({
  ownerId: 'fixture-owner',
  email: 'owner@example.test',
  origin: 'https://media.example.test',
}))
const clientId = 'fixture-driver'
const groupId = 'fixture-group'
const trackUri = 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV'
const statePath = `/api/v1/sonos/groups/${groupId}/state`
const roomsPath = '/api/v1/sonos/rooms'
const providerDelay = Number(process.env.SONOS_FIXTURE_PROVIDER_DELAY_MS ?? 0)

vi.mock('@/lib/load-workspace-env', () => ({
  loadWorkspaceEnv: () => {},
  findWorkspaceRootPath: () => null,
}))
vi.mock('@/env', async (importOriginal) => {
  const { env } = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...env,
      NODE_ENV: 'production',
      RUNTIME_KIND: 'node',
      APP_URL: fixture.origin,
      AUTH_BASE_URL: fixture.origin,
      TRUSTED_ORIGINS: [fixture.origin],
      OWNER_USER_ID: fixture.ownerId,
      OWNER_EMAIL: fixture.email,
    },
  }
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))

const database = `media_sonos_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: 'postgres' })
const pool = new pg.Pool({ ...connection, database })
const statements: string[] = []
const databaseClient = drizzle(pool, {
  schema,
  logger: {
    logQuery(query) {
      statements.push(query)
    },
  },
})
let created = false
let cookie = ''
const providerCalls: string[] = []
const groupPath = `/groups/${groupId}`
const providerResponses = new Map<string, unknown>([
  ['/households', { households: [{ id: 'fixture-home' }] }],
  [
    '/households/fixture-home/groups',
    {
      groups: [
        {
          id: groupId,
          name: 'Fixture room',
          coordinatorId: 'speaker',
          playerIds: ['speaker'],
        },
      ],
      players: [{ id: 'speaker', name: 'Fixture speaker' }],
    },
  ],
  [
    `${groupPath}/playback`,
    { playbackState: 'PLAYBACK_STATE_PLAYING', positionMillis: 1234 },
  ],
  [
    `${groupPath}/playbackMetadata`,
    {
      currentItem: {
        track: {
          name: 'Fixture track',
          durationMillis: 200000,
          id: {
            serviceId: '12',
            accountId: 'fixture-spotify',
            objectId: trackUri,
          },
        },
      },
    },
  ],
  [`${groupPath}/groupVolume`, { volume: 24, muted: false, fixed: false }],
])

async function request(path: string, init?: RequestInit) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, fixture.origin), init)
}

const browserHeaders = (client = clientId) => ({
  cookie,
  origin: fixture.origin,
  [SONOS_PLAYBACK_CLIENT_HEADER]: client,
})

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit) => {
    const url = String(input)
    const path = url.startsWith(`${SONOS_CONTROL_API}/`)
      ? url.slice(SONOS_CONTROL_API.length)
      : ''
    if (!providerResponses.has(path))
      throw new Error('Unexpected outbound request')
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer fixture-access-token',
    )
    providerCalls.push(path)
    if (providerDelay) await delay(providerDelay)
    return Response.json(providerResponses.get(path))
  })
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  const { ownerId, email } = fixture
  const password = 'fixture-owner-password'
  await databaseClient
    .insert(schema.user)
    .values({ id: ownerId, name: 'Owner', email, role: 'admin' })
  await databaseClient.insert(schema.account).values({
    id: 'fixture-owner-account',
    userId: ownerId,
    providerId: 'credential',
    accountId: ownerId,
    password: await hashPassword(password),
    updatedAt: new Date(),
  })
  const accountNamespace = `sonos-account-${createHash('sha256').update(ownerId).digest('hex')}`
  const row = (provider: string, key: string, value: string) => ({
    id: randomUUID(),
    provider,
    key,
    encryptedValue: encryptSecretValue(value),
    lastUpdatedByUserId: ownerId,
  })
  await databaseClient.insert(schema.providerSecret).values([
    row('sonos', 'clientId', 'fixture-client'),
    row('sonos', 'clientSecret', 'fixture-secret'),
    row('sonos', 'redirectUri', `${fixture.origin}/api/v1/sonos/callback`),
    row(
      accountNamespace,
      'tokens',
      JSON.stringify({
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        scope: SONOS_SCOPE,
        expiresAt: Date.now() + 3_600_000,
        clientId: 'fixture-client',
      }),
    ),
    row(
      accountNamespace,
      'spotify',
      JSON.stringify({
        'fixture-home': { serviceId: '12', accountId: 'fixture-spotify' },
      }),
    ),
  ])
  const signIn = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin: fixture.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(signIn.status).toBe(200)
  cookie = signIn.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ')
  expect(cookie).not.toBe('')
  await renewLease()
}, 40_000)

async function renewLease() {
  const session = await request('/api/v1/playback/session', {
    method: 'POST',
    headers: { ...browserHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientName: 'Fixture driver',
      claim: true,
      revision: 0,
      sonosManaged: true,
    }),
  })
  expect(session.status).toBe(200)
}

afterAll(async () => {
  vi.unstubAllGlobals()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

async function read(path: string) {
  await renewLease()
  statements.length = 0
  providerCalls.length = 0
  const start = performance.now()
  const response = await request(path, { headers: browserHeaders() })
  const payload: unknown = await response.json()
  const elapsedMs = Math.round(performance.now() - start)
  if (providerDelay)
    process.stdout.write(
      JSON.stringify({
        route: path === roomsPath ? 'rooms' : 'state',
        elapsedMs,
        statements: statements.length,
        providerCalls: providerCalls.length,
      }) + '\n',
    )
  expect(response.status).toBe(200)
  expect(
    statements.filter((query) => query.includes('from "provider_secret"')),
  ).toHaveLength(1)
  return payload
}

it('returns fresh playback, track and optional volume to the lease holder', async () => {
  const envelope = z.object({ data: SonosGroupStateSchema })
  const state = envelope.parse(await read(statePath)).data
  expect(state).toMatchObject({
    state: 'playing',
    positionMs: 1234,
    track: { uri: trackUri, name: 'Fixture track' },
  })
  expect(state).not.toHaveProperty('volume')
  expect(providerCalls.toSorted()).toEqual([
    `${groupPath}/playback`,
    `${groupPath}/playbackMetadata`,
  ])
  const withVolume = envelope.parse(await read(`${statePath}?volume=true`)).data
  expect(withVolume).toEqual({ ...state, volume: 0.24 })
  expect(providerCalls.toSorted()).toEqual([
    `${groupPath}/groupVolume`,
    `${groupPath}/playback`,
    `${groupPath}/playbackMetadata`,
  ])
}, 15_000)

it('lists the current rooms and their playable state', async () => {
  const { data } = z
    .object({ data: SonosRoomsSchema })
    .parse(await read(roomsPath))
  expect(data.households).toMatchObject([
    {
      id: 'fixture-home',
      rooms: [
        {
          id: groupId,
          name: 'Fixture room',
          players: ['Fixture speaker'],
          track: 'Fixture track',
          state: 'playing',
          playable: true,
        },
      ],
    },
  ])
  expect(providerCalls).toHaveLength(4)
}, 15_000)

it('rejects follower reads before making any provider calls', async () => {
  await renewLease()
  providerCalls.length = 0
  for (const path of [statePath, roomsPath]) {
    const response = await request(path, {
      headers: browserHeaders('fixture-follower'),
    })
    expect(response.status).toBe(403)
  }
  expect(providerCalls).toEqual([])
})

it('does not use a token row whose recorded owner differs from the signed-in owner', async () => {
  await renewLease()
  providerCalls.length = 0
  const otherOwner = 'fixture-other-owner'
  await databaseClient.insert(schema.user).values({
    id: otherOwner,
    name: 'Other fixture',
    email: 'other@example.test',
  })
  const tokens = eq(schema.providerSecret.key, 'tokens')
  try {
    await databaseClient
      .update(schema.providerSecret)
      .set({ lastUpdatedByUserId: otherOwner })
      .where(tokens)
    const response = await request(statePath, { headers: browserHeaders() })
    expect(response.status).toBe(422)
    expect(providerCalls).toEqual([])
  } finally {
    await databaseClient
      .update(schema.providerSecret)
      .set({ lastUpdatedByUserId: fixture.ownerId })
      .where(tokens)
  }
})

it('honors the Sonos cooldown before dispatching state or volume reads', async () => {
  await renewLease()
  providerCalls.length = 0
  await databaseClient.insert(schema.providerRequestState).values({
    provider: 'sonos',
    cooldownUntil: new Date(Date.now() + 60_000),
  })
  try {
    const response = await request(`${statePath}?volume=true`, {
      headers: browserHeaders(),
    })
    expect(response.status).toBe(422)
    expect(providerCalls).toEqual([])
  } finally {
    await databaseClient
      .delete(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'sonos'))
  }
})
