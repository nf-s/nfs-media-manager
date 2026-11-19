import { createHash, randomUUID } from 'node:crypto'
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
import {
  API_KEY_MAX_REQUESTS,
  API_KEY_MAX_WINDOW_SECONDS,
  ApiKeySchema,
  ApiKeysSchema,
  CreatedApiKeySchema,
  DEFAULT_API_KEY_RATE_LIMIT,
} from '@repo/schemas/api-key'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createApiKey } from '@/services/api-keys'

const fixture = vi.hoisted(() => ({
  ownerId: 'fixture-owner',
  ownerEmail: 'owner@example.test',
  origin: 'https://media.example.test',
}))
const { ownerId, ownerEmail, origin } = fixture
const otherId = 'fixture-other'
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
    },
  }
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))

const database = `media_api_keys_test_${randomUUID().replaceAll('-', '')}`
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
  throw new Error('Outbound requests are blocked in API key tests')
})
const createdKeyResponse = z.object({ data: CreatedApiKeySchema })
const updatedKeyResponse = z.object({ data: ApiKeySchema })
let created = false
let cookie = ''

async function request(path: string, init?: RequestInit) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, origin), init)
}

function bearer(key: string) {
  return { authorization: `Bearer ${key}` }
}

const ownerHeaders = () => ({ cookie, origin })

async function createKey(input: object) {
  const response = await request('/api/v1/user/api-keys', {
    method: 'POST',
    headers: { ...ownerHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toContain('no-store')
  return createdKeyResponse.parse(await response.json()).data
}

function patchKey(id: string, body: object, headers = ownerHeaders()) {
  return request(`/api/v1/user/api-keys/${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.user).values([
    { id: ownerId, name: 'Owner', email: ownerEmail, role: 'admin' },
    { id: otherId, name: 'Other', email: 'other@example.test', role: 'admin' },
  ])
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
  expect(network).not.toHaveBeenCalled()
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('production API key access', () => {
  it('issues owner-bound keys with only their digest stored and exposes metadata for management', async () => {
    const { apiKey, key } = await createKey({ name: ' Default expiry ' })
    expect(apiKey.name).toBe('Default expiry')
    expect(apiKey.enabled).toBe(true)
    expect(apiKey.rateLimit).toEqual(DEFAULT_API_KEY_RATE_LIMIT)
    expect(apiKey.requestsUsed).toBe(0)
    expect(
      Date.parse(apiKey.expiresAt ?? '') - Date.parse(apiKey.createdAt),
    ).toBe(30 * 24 * 60 * 60 * 1000)
    const stored = await databaseClient.query.apikey.findFirst({
      where: eq(schema.apikey.id, apiKey.id),
    })
    expect(stored?.key === createHash('sha256').update(key).digest('hex')).toBe(
      true,
    )
    expect(stored?.referenceId).toBe(ownerId)
    expect(apiKey.start === key.slice(0, 11)).toBe(true)
    expect(
      (await createKey({ name: 'No expiry', expiresIn: null })).apiKey
        .expiresAt,
    ).toBeNull()
    const other = await createApiKey(otherId, {
      name: 'Other user',
      expiresIn: null,
    })

    const grant = await request('/api/v1/user/agent-access', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: null }),
    })
    expect(grant.status).toBe(201)
    expect(grant.headers.get('cache-control')).toContain('no-store')
    const agent = createdKeyResponse.parse(await grant.json()).data
    expect(agent.apiKey.rateLimit).toEqual(DEFAULT_API_KEY_RATE_LIMIT)
    expect(
      Date.parse(agent.apiKey.expiresAt ?? '') -
        Date.parse(agent.apiKey.createdAt),
    ).toBe(3600 * 1000)

    const list = await request('/api/v1/user/api-keys', { headers: { cookie } })
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toContain('no-store')
    const rawList: unknown = await list.json()
    expect(
      JSON.stringify(rawList).includes(key) ||
        JSON.stringify(rawList).includes(agent.key),
    ).toBe(false)
    const keys = z.object({ data: ApiKeysSchema }).parse(rawList).data
    expect(keys.map(({ id }) => id)).toContain(apiKey.id)
    expect(keys.map(({ id }) => id)).not.toContain(other.apiKey.id)

    const revoked = await request(`/api/v1/user/api-keys/${apiKey.id}`, {
      method: 'DELETE',
      headers: ownerHeaders(),
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ data: { id: apiKey.id } })
    expect(
      (await request('/api/v1/doc', { headers: bearer(key) })).status,
    ).toBe(401)
    expect(
      (
        await request(`/api/v1/user/api-keys/${other.apiKey.id}`, {
          method: 'DELETE',
          headers: ownerHeaders(),
        })
      ).status,
    ).toBe(404)
  })

  it('accepts bearer credentials on protected docs and library operations without issuing a session', async () => {
    const { apiKey, key } = await createKey({ name: 'Library access' })
    const headers = bearer(key)
    for (const path of [
      '/api/v1/doc',
      '/api/v1/scalar',
      '/api/v1/spotify/status',
    ]) {
      expect((await request(path)).status).toBe(401)
      const response = await request(path, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('set-cookie')).toBeNull()
      if (path === '/api/v1/doc') {
        expect(await response.json()).toMatchObject({
          servers: [{ url: '/' }],
          security: [{ ownerSession: [] }, { bearerAuth: [] }],
          components: {
            securitySchemes: {
              bearerAuth: { type: 'http', scheme: 'bearer' },
              ownerSession: { type: 'apiKey', in: 'cookie' },
            },
          },
          paths: {
            '/api/v1/healthcheck': { get: { security: [] } },
            '/api/v1/user/api-keys': {
              get: { security: [{ ownerSession: [] }] },
            },
            '/api/v1/user/agent-access': {
              post: { security: [{ ownerSession: [] }] },
            },
            '/api/v1/user/api-keys/{id}': {
              delete: { security: [{ ownerSession: [] }] },
            },
            '/api/v1/spotify/playback/token': {
              post: { security: [{ ownerSession: [] }] },
            },
          },
        })
      }
    }

    await databaseClient.insert(schema.mediaItem).values({
      id: 'fixture-album',
      mediaType: 'album',
      title: 'Fixture album',
      slug: 'fixture-album',
    })
    await databaseClient
      .insert(schema.album)
      .values({ mediaItemId: 'fixture-album' })
    const album = '/api/v1/albums/fixture-album'
    const patch = (requestHeaders: Record<string, string>) =>
      request(album, {
        method: 'PATCH',
        headers: { ...requestHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Edited album' }),
      })

    for (const rejected of [
      { ...headers, origin: 'https://other.example.test' },
      { ...headers, referer: 'https://other.example.test/form' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
      { cookie },
    ]) {
      expect((await patch(rejected)).status).toBe(403)
    }
    expect((await patch({ ...bearer('invalid'), cookie })).status).toBe(401)
    expect((await patch(headers)).status).toBe(200)
    expect(
      await databaseClient.query.mediaOverride.findFirst({
        where: eq(schema.mediaOverride.mediaItemId, 'fixture-album'),
      }),
    ).toMatchObject({ value: 'Edited album', createdByUserId: ownerId })
    const counted = await databaseClient.query.apikey.findFirst({
      where: eq(schema.apikey.id, apiKey.id),
    })
    expect(counted?.requestCount).toBe(4)
    expect(counted?.lastRequest).toBeInstanceOf(Date)
  })

  it('requires a browser session for credential management and validates key creation', async () => {
    const { apiKey, key } = await createKey({ name: 'Existing key' })
    const headers = bearer(key)
    for (const { method, path } of [
      { method: 'GET', path: '/api/v1/user/api-keys' },
      { method: 'POST', path: '/api/v1/user/api-keys' },
      { method: 'POST', path: '/api/v1/user/agent-access' },
      { method: 'PATCH', path: `/api/v1/user/api-keys/${apiKey.id}` },
      { method: 'DELETE', path: `/api/v1/user/api-keys/${apiKey.id}` },
      { method: 'GET', path: '/api/v1/providers/spotify/secrets' },
      { method: 'PATCH', path: '/api/v1/providers/spotify/secrets' },
      { method: 'POST', path: '/api/v1/providers/spotify/test' },
      { method: 'POST', path: '/api/v1/spotify/playback/token' },
      { method: 'POST', path: '/api/v1/spotify/authorize' },
      { method: 'POST', path: '/api/v1/youtube/authorize' },
    ]) {
      expect((await request(path, { method, headers })).status).toBe(403)
    }
    expect((await request('/api/auth/get-session', { headers })).status).toBe(
      401,
    )
    expect(
      (
        await request('/api/v1/user/api-keys', {
          headers: { ...headers, cookie },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request('/api/v1/user/api-keys', {
          headers: { ...bearer('invalid'), cookie },
        })
      ).status,
    ).toBe(401)

    for (const body of [
      { name: ' ' },
      { name: 'Too short', expiresIn: 59 },
      { name: 'Too long', expiresIn: 365 * 24 * 60 * 60 + 1 },
      { name: 'Unexpected field', userId: otherId },
    ]) {
      const response = await request('/api/v1/user/api-keys', {
        method: 'POST',
        headers: { ...ownerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(422)
    }
  })

  it('changes a single key allowance while preserving an active window across edits', async () => {
    const initialLimit = { enabled: true, maxRequests: 2, windowSeconds: 120 }
    const { key, apiKey } = await createKey({
      name: 'Custom limit',
      rateLimit: initialLimit,
    })
    expect(apiKey.rateLimit).toEqual(initialLimit)
    expect(apiKey.requestsUsed).toBe(0)
    const useKey = () =>
      request('/api/v1/spotify/status', { headers: bearer(key) })
    const condition = eq(schema.apikey.id, apiKey.id)
    expect((await useKey()).status).toBe(200)

    const lowerLimit = { enabled: true, maxRequests: 1, windowSeconds: 60 }
    const lowered = await patchKey(apiKey.id, { rateLimit: lowerLimit })
    expect(lowered.status).toBe(200)
    expect(lowered.headers.get('cache-control')).toContain('no-store')
    const raw: unknown = await lowered.json()
    expect(JSON.stringify(raw).includes(key)).toBe(false)
    expect(updatedKeyResponse.parse(raw).data).toMatchObject({
      rateLimit: lowerLimit,
      requestsUsed: 1,
      enabled: true,
      expiresAt: apiKey.expiresAt,
    })
    const blocked = await useKey()
    expect(blocked.status).toBe(429)
    const retryAfter = Number(blocked.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)

    const unlimited = await patchKey(apiKey.id, {
      rateLimit: { enabled: false },
    })
    expect(unlimited.status).toBe(200)
    expect(updatedKeyResponse.parse(await unlimited.json()).data).toMatchObject(
      {
        rateLimit: { enabled: false },
        requestsUsed: null,
      },
    )
    expect((await useKey()).status).toBe(200)
    expect((await useKey()).status).toBe(200)
    const row = await databaseClient.query.apikey.findFirst({
      where: condition,
    })
    expect(row?.requestCount).toBe(1)
    expect(row?.lastRequest).toBeInstanceOf(Date)

    expect((await patchKey(apiKey.id, { rateLimit: lowerLimit })).status).toBe(
      200,
    )
    expect((await useKey()).status).toBe(429)
    await databaseClient
      .update(schema.apikey)
      .set({ lastRefillAt: new Date(Date.now() - 90_000) })
      .where(condition)
    const extended = await patchKey(apiKey.id, { rateLimit: initialLimit })
    expect(extended.status).toBe(200)
    expect(
      updatedKeyResponse.parse(await extended.json()).data.requestsUsed,
    ).toBe(0)
    expect((await useKey()).status).toBe(200)
    const keys = await request('/api/v1/user/api-keys', { headers: { cookie } })
    expect(keys.status).toBe(200)
    const data = z.object({ data: ApiKeysSchema }).parse(await keys.json()).data
    expect(data.find(({ id }) => id === apiKey.id)?.requestsUsed).toBe(1)
  })

  it('requires an owner browser mutation and rejects invalid rate limit settings', async () => {
    const { key, apiKey } = await createKey({ name: 'Managed key' })
    const unowned = await createApiKey(otherId, {
      name: 'Other key',
      expiresIn: null,
    })
    const body = { rateLimit: { enabled: false } }
    const requestWithoutOwner = (headers: Record<string, string>) =>
      request(`/api/v1/user/api-keys/${apiKey.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await requestWithoutOwner({ origin })).status).toBe(401)
    expect((await requestWithoutOwner({ cookie })).status).toBe(403)
    expect(
      (
        await requestWithoutOwner({
          cookie,
          origin: 'https://other.example.test',
        })
      ).status,
    ).toBe(403)
    expect((await requestWithoutOwner(bearer(key))).status).toBe(403)
    expect(
      (await requestWithoutOwner({ ...bearer(key), ...ownerHeaders() })).status,
    ).toBe(403)
    expect((await patchKey(unowned.apiKey.id, body)).status).toBe(404)
    expect((await patchKey('missing-key', body)).status).toBe(404)
    for (const invalid of [
      {},
      { rateLimit: { enabled: true, maxRequests: 0, windowSeconds: 60 } },
      {
        rateLimit: {
          enabled: true,
          maxRequests: API_KEY_MAX_REQUESTS + 1,
          windowSeconds: 60,
        },
      },
      { rateLimit: { enabled: true, maxRequests: 1, windowSeconds: 0 } },
      {
        rateLimit: {
          enabled: true,
          maxRequests: 1,
          windowSeconds: API_KEY_MAX_WINDOW_SECONDS + 1,
        },
      },
      { rateLimit: { enabled: true, maxRequests: 1, windowSeconds: 1.5 } },
      { rateLimit: { enabled: true, maxRequests: 1 } },
      { rateLimit: { enabled: false, maxRequests: 1 } },
      { rateLimit: { enabled: false }, expiresIn: null },
    ]) {
      expect((await patchKey(apiKey.id, invalid)).status).toBe(422)
    }
  })

  it('preserves revoked and expired status and uses defaults for missing legacy limits', async () => {
    const { key, apiKey } = await createKey({
      name: 'No rate limit',
      rateLimit: { enabled: false },
    })
    expect(apiKey.rateLimit).toEqual({ enabled: false })
    expect(apiKey.requestsUsed).toBeNull()
    const condition = eq(schema.apikey.id, apiKey.id)
    await databaseClient
      .update(schema.apikey)
      .set({
        rateLimitEnabled: null,
        rateLimitMax: null,
        rateLimitTimeWindow: null,
      })
      .where(condition)
    expect(
      (await request('/api/v1/spotify/status', { headers: bearer(key) }))
        .status,
    ).toBe(200)
    const list = await request('/api/v1/user/api-keys', { headers: { cookie } })
    const keys = z.object({ data: ApiKeysSchema }).parse(await list.json()).data
    expect(keys.find(({ id }) => id === apiKey.id)).toMatchObject({
      rateLimit: DEFAULT_API_KEY_RATE_LIMIT,
      requestsUsed: 1,
    })
    const revoked = await request(`/api/v1/user/api-keys/${apiKey.id}`, {
      method: 'DELETE',
      headers: ownerHeaders(),
    })
    expect(revoked.status).toBe(200)
    const updated = await patchKey(apiKey.id, { rateLimit: { enabled: false } })
    expect(updated.status).toBe(200)
    expect(updatedKeyResponse.parse(await updated.json()).data.enabled).toBe(
      false,
    )
    expect(
      (await request('/api/v1/spotify/status', { headers: bearer(key) }))
        .status,
    ).toBe(401)

    const expired = await createKey({ name: 'Expired limit' })
    await databaseClient
      .update(schema.apikey)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.apikey.id, expired.apiKey.id))
    const changed = await patchKey(expired.apiKey.id, {
      rateLimit: { enabled: false },
    })
    expect(changed.status).toBe(200)
    expect(updatedKeyResponse.parse(await changed.json()).data.expiresAt).toBe(
      new Date(0).toISOString(),
    )
    expect(
      (
        await request('/api/v1/spotify/status', {
          headers: bearer(expired.key),
        })
      ).status,
    ).toBe(401)
  })

  it('rejects expired keys and rechecks the account attached to each credential', async () => {
    const expired = await createKey({ name: 'Expired' })
    await databaseClient
      .update(schema.apikey)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.apikey.id, expired.apiKey.id))
    const nonOwner = await createApiKey(otherId, {
      name: 'Non-owner',
      expiresIn: null,
    })
    for (const key of [expired.key, nonOwner.key]) {
      expect(
        (await request('/api/v1/doc', { headers: bearer(key) })).status,
      ).toBe(401)
    }
    const previousOwner = await createKey({ name: 'Previous owner' })
    await databaseClient
      .update(schema.user)
      .set({ role: 'user' })
      .where(eq(schema.user.id, ownerId))
    try {
      expect(
        (
          await request('/api/v1/scalar', {
            headers: bearer(previousOwner.key),
          })
        ).status,
      ).toBe(401)
    } finally {
      await databaseClient
        .update(schema.user)
        .set({ role: 'admin' })
        .where(eq(schema.user.id, ownerId))
    }
  })

  it('accounts for concurrent requests atomically and resets after the rate window', async () => {
    const { key, apiKey } = await createKey({ name: 'Rate-limited key' })
    const headers = bearer(key)
    const condition = eq(schema.apikey.id, apiKey.id)
    await databaseClient
      .update(schema.apikey)
      .set({
        requestCount: 9999,
        lastRefillAt: new Date(),
      })
      .where(condition)
    const responses = await Promise.all([
      request('/api/v1/doc', { headers }),
      request('/api/v1/doc', { headers }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429,
    ])
    expect(
      Number(
        responses
          .find((response) => response.status === 429)
          ?.headers.get('retry-after'),
      ),
    ).toBeGreaterThan(0)
    expect(
      (await databaseClient.query.apikey.findFirst({ where: condition }))
        ?.requestCount,
    ).toBe(10000)
    await databaseClient
      .update(schema.apikey)
      .set({ lastRefillAt: new Date(0) })
      .where(condition)
    expect((await request('/api/v1/doc', { headers })).status).toBe(200)
    expect(
      (await databaseClient.query.apikey.findFirst({ where: condition }))
        ?.requestCount,
    ).toBe(1)
  })
})
