import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import { ApiKeysSchema, CreatedApiKeySchema } from '@repo/schemas/api-key'
import { CreatedDevicePairingSchema } from '@repo/schemas/device-auth'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createApiKey } from '@/services/api-keys'

const fixture = vi.hoisted(() => ({
  ownerId: 'fixture-owner',
  ownerEmail: 'owner@example.test',
  origin: 'https://media.example.test',
  deviceOrigins: new Array<string>(),
}))
const { ownerId, ownerEmail, origin } = fixture
const deviceOrigin = 'https://device.example.test'
const otherOrigin = 'https://other.example.test'
const password = 'fixture-owner-password'

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
      OWNER_EMAIL: fixture.ownerEmail,
      get DEVICE_ALLOWED_ORIGINS() {
        return fixture.deviceOrigins
      },
    },
  }
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))

const database = `media_device_pairing_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: 'postgres' })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Outbound requests are blocked in device pairing tests')
})
const pairingResponse = z.object({ data: CreatedDevicePairingSchema })
const exchangeResponse = z.object({ data: CreatedApiKeySchema })
const exchangePath = '/api/v1/device/pairings/exchange'
let created = false
let cookie = ''
let address = 0

async function request(path: string, init?: RequestInit) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, origin), init)
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')
// Each exchange comes from its own address unless a test shares one.
const nextAddress = () => `192.0.2.${(address += 1)}`

async function pair() {
  const response = await request('/api/v1/device/pairings', {
    method: 'POST',
    headers: { cookie, origin },
  })
  expect(response.status).toBe(201)
  return pairingResponse.parse(await response.json()).data
}

function exchange(
  body: object,
  headers: Record<string, string> = { 'x-forwarded-for': nextAddress() },
) {
  return request(exchangePath, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function exchanged(response: Response) {
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toContain('no-store')
  return exchangeResponse.parse(await response.json()).data
}

function sortedHeaders(response: Response) {
  return [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b))
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient
    .insert(schema.user)
    .values({ id: ownerId, name: 'Owner', email: ownerEmail, role: 'admin' })
  await databaseClient.insert(schema.account).values({
    id: 'fixture-owner-account',
    userId: ownerId,
    providerId: 'credential',
    accountId: ownerId,
    password: await hashPassword(password),
    updatedAt: new Date(),
  })
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
})

afterEach(() => {
  fixture.deviceOrigins = []
  expect(network).not.toHaveBeenCalled()
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('device pairing', () => {
  it('exchanges a one-time code for a device key that is listed and revoked with the other keys', async () => {
    const { code, expiresAt } = await pair()
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000)
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(
      10 * 60 * 1000,
    )
    const stored = await databaseClient.query.devicePairing.findFirst({
      where: eq(schema.devicePairing.codeHash, sha256(code)),
    })
    expect(stored?.userId).toBe(ownerId)
    expect(JSON.stringify(stored).includes(code)).toBe(false)

    const { apiKey, key } = await exchanged(
      await exchange({ code, deviceName: ' Phone ' }),
    )
    expect(apiKey).toMatchObject({
      kind: 'device',
      name: 'Phone',
      enabled: true,
      expiresAt: null,
    })
    expect(/^mm_[A-Za-z0-9_-]{43}$/.test(key)).toBe(true)
    const row = await databaseClient.query.apikey.findFirst({
      where: eq(schema.apikey.id, apiKey.id),
    })
    expect(row?.key === sha256(key)).toBe(true)
    expect(row?.referenceId).toBe(ownerId)
    expect(
      (
        await databaseClient.query.devicePairing.findFirst({
          where: eq(schema.devicePairing.codeHash, sha256(code)),
        })
      )?.consumedAt,
    ).toBeInstanceOf(Date)

    const status = await request('/api/v1/spotify/status', {
      headers: bearer(key),
    })
    expect(status.status).toBe(200)
    expect(status.headers.get('set-cookie')).toBeNull()

    expect((await exchange({ code, deviceName: 'Second phone' })).status).toBe(
      401,
    )

    const other = await createApiKey(ownerId, {
      name: 'Script',
      expiresIn: null,
    })
    const list = await request('/api/v1/user/api-keys', { headers: { cookie } })
    expect(list.status).toBe(200)
    const raw: unknown = await list.json()
    expect(JSON.stringify(raw).includes(key)).toBe(false)
    const keys = z.object({ data: ApiKeysSchema }).parse(raw).data
    expect(keys.find(({ id }) => id === apiKey.id)?.kind).toBe('device')
    expect(keys.find(({ id }) => id === other.apiKey.id)?.kind).toBe('api')

    const revoked = await request(`/api/v1/user/api-keys/${apiKey.id}`, {
      method: 'DELETE',
      headers: { cookie, origin },
    })
    expect(revoked.status).toBe(200)
    expect(
      (await request('/api/v1/spotify/status', { headers: bearer(key) }))
        .status,
    ).toBe(401)
  })

  it('rejects expired, wrong and malformed codes', async () => {
    const keysBefore = await databaseClient.$count(schema.apikey)
    const expired = await pair()
    await databaseClient
      .update(schema.devicePairing)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.devicePairing.codeHash, sha256(expired.code)))
    expect(
      (await exchange({ code: expired.code, deviceName: 'Phone' })).status,
    ).toBe(401)
    expect(
      (
        await exchange({
          code: randomBytes(32).toString('base64url'),
          deviceName: 'Phone',
        })
      ).status,
    ).toBe(401)
    const { code } = await pair()
    for (const body of [
      { code: 'short', deviceName: 'Phone' },
      { code, deviceName: ' ' },
      { code },
      { code, deviceName: 'Phone', userId: 'someone' },
    ])
      expect((await exchange(body)).status).toBe(422)
    expect(await databaseClient.$count(schema.apikey)).toBe(keysBefore)
  })

  it('gives a device key an API key’s access and no more', async () => {
    const { code } = await pair()
    const { key } = await exchanged(
      await exchange({ code, deviceName: 'Tablet' }),
    )
    const headers = bearer(key)
    for (const { method, path } of [
      { method: 'GET', path: '/api/v1/user/api-keys' },
      { method: 'POST', path: '/api/v1/user/api-keys' },
      { method: 'POST', path: '/api/v1/device/pairings' },
      { method: 'GET', path: '/api/v1/providers/spotify/secrets' },
    ])
      expect((await request(path, { method, headers })).status).toBe(403)
    expect((await request('/api/auth/get-session', { headers })).status).toBe(
      401,
    )
    expect(
      (await request('/api/v1/device/pairings', { method: 'POST' })).status,
    ).toBe(403)
    expect(
      (
        await request('/api/v1/device/pairings', {
          method: 'POST',
          headers: { origin },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request('/api/v1/device/pairings', {
          method: 'POST',
          headers: { cookie, origin: otherOrigin },
        })
      ).status,
    ).toBe(403)
  })

  it('limits exchange attempts for each client address', async () => {
    const headers = { 'x-forwarded-for': nextAddress() }
    const body = {
      code: randomBytes(32).toString('base64url'),
      deviceName: 'Phone',
    }
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await exchange(body, headers)).status).toBe(401)
    const limited = await exchange(body, headers)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await exchange(body)).status).toBe(401)
  })
})

describe('device client origins', () => {
  const preflight = (path: string, from: string) =>
    request(path, {
      method: 'OPTIONS',
      headers: {
        origin: from,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })

  it('answers device preflights and exchanges from an allowed origin without credentials', async () => {
    fixture.deviceOrigins = [deviceOrigin]
    const allowed = await preflight(exchangePath, deviceOrigin)
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      deviceOrigin,
    )
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull()
    expect(allowed.headers.get('access-control-allow-headers')).toBe(
      'Authorization,Content-Type',
    )
    expect(allowed.headers.get('access-control-allow-methods')).toBe(
      'GET,HEAD,POST',
    )

    const other = await preflight(exchangePath, otherOrigin)
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    // Only device routes answer a device origin.
    const existing = await preflight('/api/v1/spotify/status', deviceOrigin)
    expect(existing.headers.get('access-control-allow-origin')).toBeNull()

    const browser = {
      origin: deviceOrigin,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'x-forwarded-for': nextAddress(),
    }
    const response = await exchange(
      { code: (await pair()).code, deviceName: 'Web view' },
      browser,
    )
    expect(response.headers.get('access-control-allow-origin')).toBe(
      deviceOrigin,
    )
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    const { key } = await exchanged(response)
    expect(
      (
        await exchange(
          { code: (await pair()).code, deviceName: 'Web view' },
          { ...browser, origin: otherOrigin },
        )
      ).status,
    ).toBe(403)

    // The exchange exception does not extend to other requests from the origin.
    await databaseClient.insert(schema.mediaItem).values({
      id: 'fixture-album',
      mediaType: 'album',
      title: 'Fixture album',
      slug: 'fixture-album',
    })
    await databaseClient
      .insert(schema.album)
      .values({ mediaItemId: 'fixture-album' })
    for (const headers of [
      { ...bearer(key), origin: deviceOrigin },
      { cookie, origin: deviceOrigin },
    ])
      expect(
        (
          await request('/api/v1/albums/fixture-album', {
            method: 'PATCH',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Edited album' }),
          })
        ).status,
      ).toBe(403)
    expect(
      (
        await request('/api/v1/device/pairings', {
          method: 'POST',
          headers: { cookie, origin: deviceOrigin },
        })
      ).status,
    ).toBe(403)
  })

  it('leaves existing route headers unchanged', async () => {
    const { key } = await createApiKey(ownerId, {
      name: 'Headers',
      expiresIn: null,
    })
    const common = [
      ['cdn-cache-control', 'no-store'],
      ['cloudflare-cdn-cache-control', 'no-store'],
      ['referrer-policy', 'no-referrer'],
    ]
    const secure = [
      ['cross-origin-opener-policy', 'same-origin'],
      ['cross-origin-resource-policy', 'same-origin'],
      ['origin-agent-cluster', '?1'],
      ['strict-transport-security', 'max-age=15552000; includeSubDomains'],
      ['vary', 'Origin, Accept-Encoding'],
      ['x-content-type-options', 'nosniff'],
      ['x-dns-prefetch-control', 'off'],
      ['x-download-options', 'noopen'],
      ['x-frame-options', 'SAMEORIGIN'],
      ['x-permitted-cross-domain-policies', 'none'],
      ['x-xss-protection', '0'],
    ]
    const credentialed = [
      ['access-control-allow-credentials', 'true'],
      [
        'access-control-expose-headers',
        'Content-Type,Authorization,Retry-After',
      ],
    ]
    const preflightHeaders = [
      [
        'access-control-allow-headers',
        'Content-Type,Authorization,X-Sonos-Page,X-Sonos-Reason,X-Playback-Client',
      ],
      ['access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH'],
    ]
    const sorted = (entries: string[][]) =>
      [...entries].sort(([a = ''], [b = '']) => a.localeCompare(b))
    const allow = [['access-control-allow-origin', origin]]
    const get = sorted([
      ...credentialed,
      ['cache-control', 'no-store'],
      ['content-type', 'application/json'],
      ...common,
      ...secure,
    ])
    const options = sorted([
      ...credentialed,
      ...preflightHeaders,
      ['cache-control', 'private, no-store'],
      ...common,
      ['vary', 'Origin, Access-Control-Request-Headers'],
    ])
    // Recorded from the API before device origins existed.
    const before: Record<string, { status: number; headers: string[][] }> = {
      getTrusted: { status: 200, headers: sorted([...get, ...allow]) },
      getDevice: { status: 200, headers: get },
      preflightTrusted: {
        status: 204,
        headers: sorted([...options, ...allow]),
      },
      preflightDevice: { status: 204, headers: options },
    }
    const cases: Record<string, RequestInit> = {
      getTrusted: { headers: { ...bearer(key), origin } },
      getDevice: { headers: { ...bearer(key), origin: deviceOrigin } },
      preflightTrusted: {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      },
      preflightDevice: {
        method: 'OPTIONS',
        headers: {
          origin: deviceOrigin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      },
    }
    for (const allowed of [[], [deviceOrigin]]) {
      fixture.deviceOrigins = allowed
      for (const [name, init] of Object.entries(cases)) {
        const response = await request('/api/v1/spotify/status', init)
        expect({
          status: response.status,
          headers: sortedHeaders(response),
        }).toEqual(before[name])
      }
    }

    fixture.deviceOrigins = []
    const unset = await preflight(exchangePath, deviceOrigin)
    expect(sortedHeaders(unset)).toEqual(
      sorted([
        ...credentialed,
        ...preflightHeaders,
        ['cache-control', 'private, no-store'],
        ...common,
        ['vary', 'Origin, Access-Control-Request-Headers'],
      ]),
    )
    const blocked = await exchange(
      { code: (await pair()).code, deviceName: 'Web view' },
      { origin: deviceOrigin, 'x-forwarded-for': nextAddress() },
    )
    expect(blocked.status).toBe(403)
  })
})
