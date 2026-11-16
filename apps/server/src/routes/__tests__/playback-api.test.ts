import { afterEach, describe, expect, it, vi } from 'vitest'

const first = 'client-aaaaaaaa'
const second = 'client-bbbbbbbb'

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
  })

  it('rejects cross-origin requests', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const path of ['session', 'session/release'])
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
})
