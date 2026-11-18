import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PgTable } from 'drizzle-orm/pg-core'
import {
  ProviderRequestError,
  type MediaProviderPlugin,
  type PluginRateLimit,
} from '@repo/media-plugin-sdk'
import { providerRequestState } from '@/schemas/db'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  write: vi.fn<(table: PgTable, values: object) => void>(),
}))
let state: typeof providerRequestState.$inferSelect

vi.mock('@/lib/db', () => {
  const client = {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([state]), {
            for: async () => [state],
          }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    update: (table: PgTable) => ({
      set: (values: object) => ({
        where: async () => {
          mocks.write(table, values)
          if (table === providerRequestState) Object.assign(state, values)
        },
      }),
    }),
  }
  return {
    db: {
      ...client,
      transaction: async <T>(work: (tx: typeof client) => Promise<T>) =>
        work(client),
    },
  }
})

import { createDirectProviderRequest } from '../provider-requests'

function plugin(rateLimit: Partial<PluginRateLimit> = {}): MediaProviderPlugin {
  return {
    manifest: {
      id: 'direct-fixture',
      displayName: 'Direct fixture',
      description: '',
      mediaTypes: [],
      secrets: [],
      rateLimit: {
        maxConcurrent: 2,
        concurrentRequests: true,
        minTimeMs: 25,
        rateLimitCooldownMs: 60000,
        errorBackoffMs: 0,
        ...rateLimit,
      },
    },
  }
}

async function failure(work: Promise<unknown>) {
  try {
    await work
  } catch (error) {
    if (error instanceof ProviderRequestError) return error
    throw error
  }
  throw new Error('Expected the request to fail')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  mocks.write.mockReset()
  mocks.fetch.mockReset()
  mocks.fetch.mockRejectedValue(new Error('Unexpected network request'))
  vi.stubGlobal('fetch', mocks.fetch)
  state = {
    provider: 'direct-fixture',
    halted: false,
    requests: [],
    requestLeases: [],
    leaseId: null,
    leaseUntil: null,
    nextAllowedAt: null,
    cooldownUntil: null,
    failureCount: 0,
    lastError: null,
    requestBudgetOverride: null,
    budgetUpdatedByUserId: null,
    historyStartedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('direct provider requests', () => {
  it('sends the request without writing request state', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true }))
    const request = createDirectProviderRequest(plugin())
    const response = await request('https://provider.example.test/state', {
      headers: { Authorization: 'Bearer fake-token' },
    })
    expect(await response.json()).toEqual({ ok: true })
    const [url, init] = mocks.fetch.mock.calls[0] ?? []
    expect(url).toBe('https://provider.example.test/state')
    expect(init?.redirect).toBe('manual')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('sends nothing while the provider is halted or cooling down', async () => {
    const request = createDirectProviderRequest(plugin())
    state.halted = true
    const halted = await failure(request('https://provider.example.test/a'))
    expect(halted.code).toBe('access-denied')
    expect(halted.recorded).toBe(true)

    state.halted = false
    state.cooldownUntil = new Date(Date.now() + 30000)
    const cooling = await failure(request('https://provider.example.test/a'))
    expect(cooling.code).toBe('cooldown')
    expect(cooling.retryAt).toBe(Date.now() + 30000)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('starts the provider cooldown on a rate limit', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }))
    const request = createDirectProviderRequest(plugin())
    const error = await failure(request('https://provider.example.test/a'))
    expect(error.code).toBe('rate-limit')
    expect(error.recorded).toBe(true)
    expect(state.cooldownUntil?.getTime()).toBe(Date.now() + 60000)
    expect(state.failureCount).toBe(1)

    await failure(request('https://provider.example.test/a'))
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('halts the provider when access is denied', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const request = createDirectProviderRequest(plugin())
    const error = await failure(request('https://provider.example.test/a'))
    expect(error.code).toBe('access-denied')
    expect(error.message).toBe('Provider request failed (HTTP 401)')
    expect(state.halted).toBe(true)
  })

  it('reports a refused request without pausing the provider', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 400 }))
    const request = createDirectProviderRequest(plugin())
    const error = await failure(request('https://provider.example.test/a'))
    expect(error.code).toBe('request-failed')
    expect(error.message).toBe('Provider request failed (HTTP 400)')
    expect(error.retryAt).toBeNull()
    expect(state.cooldownUntil).toBeNull()
    expect(state.halted).toBe(false)
  })

  it('returns answered failure statuses to the caller unrecorded', async () => {
    state.failureCount = 1
    state.lastError = 'Provider request failed (HTTP 400)'
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ error: 9 }, { status: 403 }),
    )
    const request = createDirectProviderRequest(plugin(), [400, 403])
    const response = await request('https://provider.example.test/a', {
      method: 'POST',
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 9 })
    expect(state.halted).toBe(false)
    expect(state.failureCount).toBe(1)
    expect(mocks.write).not.toHaveBeenCalled()

    // Other failures are still recorded.
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const error = await failure(request('https://provider.example.test/a'))
    expect(error.code).toBe('access-denied')
    expect(state.halted).toBe(true)
  })

  it('records a request that never answers as a failure', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    const request = createDirectProviderRequest(plugin())
    const error = await failure(request('https://provider.example.test/a'))
    expect(error.message).toBe('Provider request failed or timed out')
    expect(state.failureCount).toBe(1)
  })

  it('clears earlier failures when a request succeeds', async () => {
    state.failureCount = 2
    state.lastError = 'Provider request failed (HTTP 400)'
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const request = createDirectProviderRequest(plugin())
    const response = await request('https://provider.example.test/a', {
      method: 'POST',
    })
    expect(response.status).toBe(204)
    expect(state.failureCount).toBe(0)
    expect(state.lastError).toBeNull()
  })

  it('sends at most the manifest concurrency at once', async () => {
    const answers: (() => void)[] = []
    mocks.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          answers.push(() => resolve(Response.json({}))),
        ),
    )
    const request = createDirectProviderRequest(plugin())
    const all = Promise.all(
      ['a', 'b', 'c'].map((path) =>
        request(`https://provider.example.test/${path}`),
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    answers[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    answers[1]?.()
    answers[2]?.()
    expect(await all).toHaveLength(3)
  })

  it('is refused for a provider with a request budget', () => {
    expect(() =>
      createDirectProviderRequest(plugin({ maxRequestsPerHour: 100 })),
    ).toThrow('request budget')
  })
})
