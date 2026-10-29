import { afterEach, describe, expect, it, vi } from 'vitest'

const listProviders = vi.fn()
const getProviderActivity = vi.fn()
const clearProviderCooldown = vi.fn()
const updateProviderBudget = vi.fn()

vi.mock('@/services/provider-activity', () => ({
  getProviderActivity: (...args: unknown[]) => getProviderActivity(...args),
  clearProviderCooldown: (...args: unknown[]) => clearProviderCooldown(...args),
}))

describe('providers api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listProviders.mockReset()
    getProviderActivity.mockReset()
    clearProviderCooldown.mockReset()
    updateProviderBudget.mockReset()
  })

  it('returns 401 when the request is unauthenticated', async () => {
    vi.doMock('@/env', () => ({
      env: {
        TRUSTED_ORIGINS: ['http://localhost:3000'],
        NODE_ENV: 'test',
      },
    }))

    vi.doMock('@/lib/db', () => ({
      db: {},
    }))

    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue(null),
        },
        handler: vi.fn(),
      },
    }))

    vi.doMock('@/services/providers', () => ({
      listProviders,
      getProviderSecrets: vi.fn(),
      testProviderSecrets: vi.fn(),
      updateProviderSecrets: vi.fn(),
      updateProviderBudget,
    }))

    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/providers')
    const payload = await response.json()

    expect(response.status).toBe(401)
    expect(payload).toMatchObject({
      statusCode: 401,
      message: 'Unauthorized',
    })
    expect(listProviders).not.toHaveBeenCalled()
    expect(
      (await app.request('http://localhost/api/v1/providers/fixture/activity'))
        .status,
    ).toBe(401)
    expect(
      (
        await app.request(
          'http://localhost/api/v1/providers/fixture/cooldown/clear',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              confirm: true,
              expectedCooldownUntil: new Date().toISOString(),
            }),
          },
        )
      ).status,
    ).toBe(401)
    expect(clearProviderCooldown).not.toHaveBeenCalled()
    expect(
      (
        await app.request('http://localhost/api/v1/providers/fixture/budget', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ period: 'day', limit: 1000 }),
        })
      ).status,
    ).toBe(401)
    expect(updateProviderBudget).not.toHaveBeenCalled()
  })

  it('returns provider summaries for an authenticated request', async () => {
    listProviders.mockResolvedValue([
      {
        id: 'spotify',
        displayName: 'Spotify',
        description: 'Album metadata',
        surface: 'provider',
        mediaTypes: ['album'],
        rateLimit: {
          maxConcurrent: 1,
          minTimeMs: 1500,
        },
        supportsScrape: false,
        supportsLegacyImport: true,
        secrets: [],
        pluginPath: null,
      },
    ])

    vi.doMock('@/env', () => ({
      env: {
        TRUSTED_ORIGINS: ['http://localhost:3000'],
        NODE_ENV: 'test',
      },
    }))

    vi.doMock('@/lib/db', () => ({
      db: {},
    }))

    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: {
              id: 'user-1',
              email: 'admin@example.com',
              name: 'Admin',
            },
            session: {
              id: 'session-1',
              userId: 'user-1',
            },
          }),
        },
        handler: vi.fn(),
      },
    }))

    vi.doMock('@/services/providers', () => ({
      listProviders,
      getProviderSecrets: vi.fn(),
      testProviderSecrets: vi.fn(),
      updateProviderSecrets: vi.fn(),
      updateProviderBudget,
    }))

    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/providers')
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      statusCode: 200,
      data: [
        {
          id: 'spotify',
          displayName: 'Spotify',
        },
      ],
    })
    expect(listProviders).toHaveBeenCalledTimes(1)
    for (const input of [
      { period: 'week', limit: 1000 },
      { period: 'day', limit: 0 },
      { period: 'day', limit: 1.5 },
      { period: 'day', limit: 100001 },
    ]) {
      expect(
        (
          await app.request(
            'http://localhost/api/v1/providers/fixture/budget',
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            },
          )
        ).status,
      ).toBe(422)
    }
    expect(updateProviderBudget).not.toHaveBeenCalled()
    updateProviderBudget.mockResolvedValue({
      budget: { period: 'day', limit: 1000 },
      used: 3,
      resetsAt: '2026-10-28T00:00:00.000Z',
    })
    expect(
      (
        await app.request('http://localhost/api/v1/providers/fixture/budget', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ period: 'day', limit: 1000 }),
        })
      ).status,
    ).toBe(200)
    expect(updateProviderBudget).toHaveBeenCalledWith(
      'fixture',
      { period: 'day', limit: 1000 },
      'user-1',
    )
    expect(
      (
        await app.request(
          'http://localhost/api/v1/providers/fixture/activity?range=forever',
        )
      ).status,
    ).toBe(422)
    expect(getProviderActivity).not.toHaveBeenCalled()
    getProviderActivity.mockResolvedValue({ provider: 'fixture', buckets: [] })
    expect(
      (
        await app.request(
          'http://localhost/api/v1/providers/fixture/activity?range=7d',
        )
      ).status,
    ).toBe(200)
    expect(getProviderActivity).toHaveBeenCalledWith('fixture', '7d')
    const expectedCooldownUntil = new Date().toISOString()
    expect(
      (
        await app.request(
          'http://localhost/api/v1/providers/fixture/cooldown/clear',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: false, expectedCooldownUntil }),
          },
        )
      ).status,
    ).toBe(422)
    expect(clearProviderCooldown).not.toHaveBeenCalled()
    clearProviderCooldown.mockResolvedValue({ cooldownUntil: null })
    expect(
      (
        await app.request(
          'http://localhost/api/v1/providers/fixture/cooldown/clear',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true, expectedCooldownUntil }),
          },
        )
      ).status,
    ).toBe(200)
    expect(clearProviderCooldown).toHaveBeenCalledWith(
      'fixture',
      expectedCooldownUntil,
      'user-1',
    )
  })
})
