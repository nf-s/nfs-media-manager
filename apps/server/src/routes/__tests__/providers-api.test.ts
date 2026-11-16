import { afterEach, describe, expect, it, vi } from 'vitest'

const listProviders = vi.fn()
const getProviderActivity = vi.fn()
const getProviderJobSummary = vi.fn()
const getProviderRequestSeries = vi.fn()
const getProviderLibraryCoverage = vi.fn()
const clearProviderCooldown = vi.fn()
const updateProviderBudget = vi.fn()
const getProvidersOverview = vi.fn()

vi.mock('@/services/providers-overview', () => ({
  getProvidersOverview: (...args: unknown[]) => getProvidersOverview(...args),
}))
vi.mock('@/services/provider-activity', () => ({
  getProviderActivity: (...args: unknown[]) => getProviderActivity(...args),
  getProviderJobSummary: (...args: unknown[]) => getProviderJobSummary(...args),
  getProviderRequestSeries: (...args: unknown[]) =>
    getProviderRequestSeries(...args),
  getProviderLibraryCoverage: (...args: unknown[]) =>
    getProviderLibraryCoverage(...args),
  clearProviderCooldown: (...args: unknown[]) => clearProviderCooldown(...args),
}))

describe('providers api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listProviders.mockReset()
    getProviderActivity.mockReset()
    getProviderJobSummary.mockReset()
    getProviderRequestSeries.mockReset()
    getProviderLibraryCoverage.mockReset()
    clearProviderCooldown.mockReset()
    updateProviderBudget.mockReset()
    getProvidersOverview.mockReset()
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
      (
        await app.request(
          'http://localhost/api/v1/providers/fixture/jobs/summary',
        )
      ).status,
    ).toBe(401)
    expect(getProviderJobSummary).not.toHaveBeenCalled()
    for (const path of ['requests/daily', 'coverage'])
      expect(
        (await app.request(`http://localhost/api/v1/providers/fixture/${path}`))
          .status,
      ).toBe(401)
    expect(getProviderRequestSeries).not.toHaveBeenCalled()
    expect(getProviderLibraryCoverage).not.toHaveBeenCalled()
    expect(
      (await app.request('http://localhost/api/v1/providers/overview')).status,
    ).toBe(401)
    expect(getProvidersOverview).not.toHaveBeenCalled()
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
        siteUrl: 'https://example.com',
        surface: 'provider',
        mediaTypes: ['album'],
        subscriptions: true,
        rateLimit: {
          maxConcurrent: 1,
          minTimeMs: 1500,
        },
        supportsScrape: false,
        supportsJobDispatchControl: true,
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
          siteUrl: 'https://example.com',
          subscriptions: true,
          supportsJobDispatchControl: true,
        },
      ],
    })
    expect(listProviders).toHaveBeenCalledTimes(1)
    const summary = {
      provider: 'fixture',
      total: 12,
      queued: 3,
      running: 1,
      succeeded: 5,
      failed: 2,
      cancelled: 1,
    }
    getProviderJobSummary.mockResolvedValue(summary)
    const jobs = await app.request(
      'http://localhost/api/v1/providers/fixture/jobs/summary',
    )
    expect(jobs.status).toBe(200)
    expect(await jobs.json()).toMatchObject({ data: summary })
    expect(getProviderJobSummary).toHaveBeenCalledWith('fixture')
    const series = {
      provider: 'fixture',
      recordedSince: '2026-09-01T00:00:00.000Z',
      daysFrom: '2026-08-19',
      daysTo: '2026-11-16',
      total: 7,
      days: [
        { date: '2026-11-02', count: 3 },
        { date: '2026-11-16', count: 4 },
      ],
    }
    getProviderRequestSeries.mockResolvedValue(series)
    const daily = await app.request(
      'http://localhost/api/v1/providers/fixture/requests/daily',
    )
    expect(daily.status).toBe(200)
    expect(await daily.json()).toMatchObject({ data: series })
    expect(getProviderRequestSeries).toHaveBeenCalledWith('fixture')
    const coverage = {
      provider: 'fixture',
      mediaTypes: [{ mediaType: 'album', covered: 96, total: 128 }],
    }
    getProviderLibraryCoverage.mockResolvedValue(coverage)
    const covered = await app.request(
      'http://localhost/api/v1/providers/fixture/coverage',
    )
    expect(covered.status).toBe(200)
    expect(await covered.json()).toMatchObject({ data: coverage })
    expect(getProviderLibraryCoverage).toHaveBeenCalledWith('fixture')
    const overview = {
      generatedAt: '2026-11-16T13:40:00.000Z',
      requestsFrom: '2026-11-15T13:40:00.000Z',
      providers: [],
    }
    getProvidersOverview.mockResolvedValue(overview)
    const overviewResponse = await app.request(
      'http://localhost/api/v1/providers/overview?mediaType=film',
    )
    expect(overviewResponse.status).toBe(200)
    expect(await overviewResponse.json()).toMatchObject({ data: overview })
    expect(getProvidersOverview).toHaveBeenCalledExactlyOnceWith(
      { mediaType: 'film' },
      'user-1',
    )
    expect(
      (
        await app.request(
          'http://localhost/api/v1/providers/overview?mediaType=track',
        )
      ).status,
    ).toBe(422)
    expect(getProvidersOverview).toHaveBeenCalledTimes(1)
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

  it('lists YouTube and Spotify in Subscriptions without giving YouTube a media type', async () => {
    const { getBuiltinProviderCatalog } = await import('@/lib/provider-catalog')
    const catalog = getBuiltinProviderCatalog()
    expect(
      catalog.filter((entry) => entry.subscriptions).map((entry) => entry.id),
    ).toEqual(['spotify', 'youtube'])
    // The hosted runtime starts an account-level dispatcher unpaused only without media types.
    expect(catalog.find((entry) => entry.id === 'youtube')?.mediaTypes).toEqual(
      [],
    )
    expect(catalog.find((entry) => entry.id === 'spotify')?.mediaTypes).toEqual(
      ['album'],
    )
  })
})
