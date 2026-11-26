import { afterEach, describe, expect, it, vi } from 'vitest'
import { SONOS_PLAYBACK_CLIENT_HEADER } from '@repo/schemas/playback'
import type { PlaybackDiagnosticInput } from '@repo/schemas/playback-diagnostics'

const first = 'client-aaaaaaaa'
const second = 'client-bbbbbbbb'
const diagnosticsPath = '/api/v1/playback/diagnostics'
const diagnostic: PlaybackDiagnosticInput = {
  attemptId: '77001d4e-a2a4-4c85-8d81-5bb18b943d20',
  browser: 'android',
  stage: 'requested',
  target: 'local',
  source: 'similar-tracks',
  spotifyTrackId: 'aaaaaaaaaaaaaaaaaaaaaa',
  sourceItemId: '31d197e2-29a0-4c7d-ad41-70eef2cf034e',
}

const savedPlayback = {
  version: 1,
  savedAt: 1000,
  queue: [],
  sequence: 0,
  current: null,
  currentFromSource: false,
  session: null,
  snapshot: null,
  shuffle: false,
  target: { kind: 'spotify', device: null, browser: null },
  source: null,
}

function mockAppSession(authenticated: boolean) {
  vi.doMock('@/env', () => ({
    env: { TRUSTED_ORIGINS: ['http://localhost:3000'], NODE_ENV: 'test' },
  }))
  vi.doMock('@/lib/db', () => ({ db: {} }))
  vi.doMock('@/lib/auth', () => ({
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(
          authenticated
            ? {
                user: {
                  id: 'user-1',
                  email: 'admin@example.com',
                  name: 'Admin',
                },
                session: { id: 'session-1', userId: 'user-1' },
              }
            : null,
        ),
      },
      handler: vi.fn(),
    },
  }))
}

function mockOwnerKey() {
  vi.doMock('@/services/api-keys', async (original) => ({
    ...(await original<typeof import('@/services/api-keys')>()),
    authenticateApiKey: vi.fn().mockResolvedValue({
      status: 'authenticated',
      id: 'fixture-key',
      user: { id: 'user-1' },
    }),
  }))
}

function jsonRequest(
  body: unknown,
  origin = 'http://localhost:3000',
): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  }
}

function sync(body: Record<string, unknown>) {
  return jsonRequest({ clientName: 'Laptop', claim: false, ...body })
}

describe('Playback session API', () => {
  afterEach(() => {
    vi.doUnmock('@/services/sonos-oauth')
    vi.doUnmock('@/services/api-keys')
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('requires an owner browser session', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          '/api/v1/playback/session',
          sync({ clientId: first, revision: 0 }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(
          '/api/v1/playback/session/release',
          jsonRequest({ clientId: first, revision: 0 }),
        )
      ).status,
    ).toBe(401)
    expect((await app.request(diagnosticsPath)).status).toBe(401)
    expect(
      (await app.request(diagnosticsPath, jsonRequest(diagnostic))).status,
    ).toBe(401)
  })

  it('rejects cross-origin requests', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const path of ['session', 'session/release', 'diagnostics'])
      expect(
        (
          await app.request(
            `/api/v1/playback/${path}`,
            jsonRequest(
              { clientId: first, revision: 0 },
              'https://untrusted.example',
            ),
          )
        ).status,
      ).toBe(403)
    expect(
      (
        await app.request(diagnosticsPath, {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403)
  })

  it('records single events and batches in receipt order, with idempotent retries', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const retried = {
      ...diagnostic,
      eventId: 'b4449a0d-563d-4a15-a00d-16f5d5a4f057',
      stage: 'failed',
      reason: 'start-timeout',
      at: 1000,
    }
    const secondTap = {
      ...diagnostic,
      attemptId: 'b7cebcb7-31f0-4538-9c91-8b97397694a7',
      at: 1001,
      sourceItemId: 'track_0123456789abcdef0123',
    }
    const advance = {
      ...secondTap,
      stage: 'advance',
      reason: 'source',
      sourceIndex: 2,
      queued: 0,
      upcoming: 1,
      sourceItemId: 'library-track_123456789abcdef01234',
    }
    const batch = { events: [secondTap, advance] }
    for (const body of [diagnostic, { events: [retried] }, retried, batch]) {
      const response = await app.request(diagnosticsPath, jsonRequest(body))
      expect(response.status).toBe(204)
      expect(response.headers.get('cache-control')).toContain('no-store')
    }
    const response = await app.request(diagnosticsPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toMatchObject({
      data: {
        events: [diagnostic, retried, secondTap, advance].map((event) => ({
          ...event,
          receivedAt: expect.any(Number),
        })),
      },
    })
  })

  it('rejects unknown or invalid diagnostic data and oversized batches', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const invalid of [
      { ...diagnostic, privateFixtureField: 'fixture message' },
      { ...diagnostic, attemptId: 'device-identifier' },
      { ...diagnostic, at: -1 },
      { ...diagnostic, status: 600 },
      { ...diagnostic, sourceIndex: 1.5 },
      { ...diagnostic, reason: 'fixture message' },
      { ...diagnostic, spotifyTrackId: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' },
      { ...diagnostic, sourceItemId: 'device-identifier' },
      { ...diagnostic, sourceItemId: 'library-track_name' },
      { events: [] },
      { events: Array.from({ length: 33 }, () => diagnostic) },
      { events: [diagnostic, { ...diagnostic, url: 'https://example.com' }] },
    ]) {
      const response = await app.request(diagnosticsPath, jsonRequest(invalid))
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ data: null })
    }
    expect(
      (
        await app.request(
          diagnosticsPath,
          jsonRequest({ ...diagnostic, extra: 'x'.repeat(16 * 1024) }),
        )
      ).status,
    ).toBe(413)
    const response = await app.request(diagnosticsPath)
    expect(await response.json()).toMatchObject({ data: { events: [] } })
  })

  it('lets an owner API key retrieve diagnostics and requires a browser session to write', async () => {
    mockAppSession(true)
    mockOwnerKey()
    const { default: app } = await import('@/app')
    expect(
      (await app.request(diagnosticsPath, jsonRequest(diagnostic))).status,
    ).toBe(204)

    const headers = { Authorization: 'Bearer fixture-key' }
    const response = await app.request(diagnosticsPath, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toMatchObject({
      data: { events: [diagnostic] },
    })
    const docs = await app.request('/api/v1/doc', { headers })
    expect(docs.status).toBe(200)
    expect(await docs.json()).toMatchObject({
      paths: {
        [diagnosticsPath]: {
          get: { security: [{ ownerSession: [] }, { bearerAuth: [] }] },
          post: { security: [{ ownerSession: [] }] },
        },
      },
    })
    expect(
      (
        await app.request(diagnosticsPath, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(diagnostic),
        })
      ).status,
    ).toBe(403)
  })

  it('rejects invalid and oversized bodies', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          '/api/v1/playback/session',
          sync({ clientId: 'short', revision: 0 }),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await app.request(
          '/api/v1/playback/session/release',
          jsonRequest({ clientId: first, revision: 0, extra: true }),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await app.request(
          '/api/v1/playback/session',
          sync({
            clientId: first,
            revision: 0,
            clientName: 'x'.repeat(2 * 1024 * 1024),
          }),
        )
      ).status,
    ).toBe(413)
  })

  it('shares one session between two clients', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const post = async (path: string, init: RequestInit) => {
      const response = await app.request(`/api/v1/playback/${path}`, init)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toContain('no-store')
      const body: unknown = await response.json()
      return body
    }

    expect(
      await post(
        'session',
        sync({ clientId: first, revision: 0, state: savedPlayback }),
      ),
    ).toMatchObject({
      data: {
        revision: 1,
        role: 'driver',
        driver: { clientId: first, name: 'Laptop' },
        changed: false,
        state: null,
      },
    })

    expect(
      await post(
        'session',
        sync({ clientId: second, clientName: 'Phone', revision: 0 }),
      ),
    ).toMatchObject({
      data: {
        revision: 1,
        role: 'follower',
        driver: { clientId: first, name: 'Laptop' },
        changed: true,
        state: savedPlayback,
      },
    })

    expect(
      await post(
        'session/release',
        jsonRequest({ clientId: second, revision: 1, state: null }),
      ),
    ).toMatchObject({ data: { released: false, revision: 1 } })

    expect(
      await post(
        'session',
        sync({
          clientId: second,
          clientName: 'Phone',
          revision: 1,
          claim: true,
        }),
      ),
    ).toMatchObject({
      data: {
        revision: 1,
        role: 'driver',
        driver: { clientId: second, name: 'Phone' },
        changed: false,
      },
    })

    expect(
      await post(
        'session',
        sync({ clientId: first, revision: 1, state: null }),
      ),
    ).toMatchObject({
      data: { revision: 1, role: 'follower', changed: false, state: null },
    })

    expect(
      await post(
        'session/release',
        jsonRequest({ clientId: second, revision: 1, state: null }),
      ),
    ).toMatchObject({ data: { released: true, revision: 2 } })

    expect(
      await post('session', sync({ clientId: first, revision: 1 })),
    ).toMatchObject({
      data: { revision: 2, role: 'driver', changed: true, state: null },
    })
  })

  it('enforces the managed lease on Sonos routes and keeps owner key reads', async () => {
    mockAppSession(true)
    const rooms = vi.fn().mockResolvedValue({ households: [] })
    const command = vi.fn().mockResolvedValue({ done: true })
    vi.doMock('@/services/sonos-oauth', async (original) => ({
      ...(await original<typeof import('@/services/sonos-oauth')>()),
      getSonosRooms: rooms,
      sendSonosCommand: command,
    }))
    mockOwnerKey()
    const { default: app } = await import('@/app')
    const readRooms = (headers?: HeadersInit) =>
      app.request('/api/v1/sonos/rooms', { headers })
    const sendCommand = (clientId: string) => {
      const request = jsonRequest({ action: 'play' })
      const headers = new Headers(request.headers)
      headers.set(SONOS_PLAYBACK_CLIENT_HEADER, clientId)
      return app.request('/api/v1/sonos/groups/fixture-group/command', {
        ...request,
        headers,
      })
    }

    expect((await readRooms()).status).toBe(403)
    expect(
      (
        await app.request(
          '/api/v1/playback/session',
          sync({ clientId: first, revision: 0, sonosManaged: true }),
        )
      ).status,
    ).toBe(200)
    expect((await readRooms()).status).toBe(403)
    expect(
      (await readRooms({ [SONOS_PLAYBACK_CLIENT_HEADER]: second })).status,
    ).toBe(403)
    expect((await sendCommand(second)).status).toBe(403)
    expect(rooms).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()

    expect(
      (await readRooms({ [SONOS_PLAYBACK_CLIENT_HEADER]: first })).status,
    ).toBe(200)
    expect((await sendCommand(first)).status).toBe(200)
    expect(
      (await readRooms({ Authorization: 'Bearer fixture-key' })).status,
    ).toBe(200)
    expect(rooms).toHaveBeenCalledTimes(2)
    expect(command).toHaveBeenCalledOnce()
  })
})
