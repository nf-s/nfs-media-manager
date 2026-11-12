import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { providerRequestState } from '@/schemas/db'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  write: vi.fn<(table: PgTable, values: object) => void>(),
}))
let state: typeof providerRequestState.$inferSelect

vi.mock('@/services/provider-transport', () => ({
  getProviderTransport: async () => null,
}))
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

import { createProviderRequest } from '../provider-requests'

function plugin(
  requestTimeoutMs?: number,
  concurrentRequests = false,
): MediaProviderPlugin {
  return {
    manifest: {
      id: 'timeout-fixture',
      displayName: 'Timeout fixture',
      description: '',
      mediaTypes: ['album'],
      secrets: [],
      rateLimit: {
        maxConcurrent: 2,
        minTimeMs: 250,
        concurrentRequests,
        requestTimeoutMs,
      },
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  mocks.write.mockClear()
  mocks.fetch.mockReset()
  mocks.fetch.mockRejectedValue(new Error('Unexpected network request'))
  vi.stubGlobal('fetch', mocks.fetch)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(
      () =>
        controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      milliseconds,
    )
    return controller.signal
  })
  state = {
    provider: 'timeout-fixture',
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

function delayedResponse(milliseconds: number) {
  mocks.fetch.mockImplementation(async (_url, init) => {
    const signal = init?.signal
    if (!signal) throw new Error('Missing request signal')
    signal.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(Response.json({ ok: true })),
        milliseconds,
      )
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(signal.reason)
        },
        { once: true },
      )
    })
  })
}

describe('provider-specific request timeout', () => {
  it('reproduces the default 15-second abort without retrying', async () => {
    delayedResponse(20000)
    const outcome = expect(
      createProviderRequest(plugin())('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'request-failed', recorded: true })
    await vi.advanceTimersByTimeAsync(15000)
    await outcome
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15000)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(state.failureCount).toBe(1)
    expect(state.leaseUntil).toBeNull()
  })

  it.each([
    { concurrent: false, timeoutMs: 30000 },
    { concurrent: true, timeoutMs: 30000 },
    { concurrent: false, timeoutMs: 120000 },
    { concurrent: true, timeoutMs: 120000 },
  ])(
    'allows a slow response with an aligned lease (concurrent=$concurrent, timeout=$timeoutMs)',
    async ({ concurrent, timeoutMs }) => {
      delayedResponse(20000)
      const start = Date.now()
      const response = createProviderRequest(plugin(timeoutMs, concurrent))(
        'https://fixture.invalid',
      )
      const outcome = expect(response).resolves.toHaveProperty('status', 200)
      await vi.advanceTimersByTimeAsync(16000)
      expect(mocks.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
      const expiry = concurrent
        ? state.requestLeases[0]?.expiresAt
        : state.leaseUntil?.getTime()
      expect(expiry).toBe(start + timeoutMs + 5000)
      await vi.advanceTimersByTimeAsync(4000)
      await outcome
      expect(AbortSignal.timeout).toHaveBeenCalledWith(timeoutMs)
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(state.leaseUntil).toBeNull()
      expect(state.requestLeases).toEqual([])
      expect(state.halted).toBe(false)
      expect(state.cooldownUntil).toBeNull()
    },
  )

  it.each([30000, 120000])(
    'aborts a provider-specific request at its configured %s ms deadline',
    async (timeoutMs) => {
      delayedResponse(timeoutMs + 1000)
      const outcome = expect(
        createProviderRequest(plugin(timeoutMs))('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'request-failed', recorded: true })
      await vi.advanceTimersByTimeAsync(timeoutMs - 1)
      expect(mocks.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await outcome
      expect(mocks.fetch.mock.calls[0]?.[1]?.signal?.reason).toHaveProperty(
        'name',
        'TimeoutError',
      )
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(state.failureCount).toBe(1)
      expect(state.leaseUntil).toBeNull()
    },
  )

  it('retains the explicit timeout override for existing callers', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ok: true }))
    await createProviderRequest(plugin(30000), undefined, { timeoutMs: 60000 })(
      'https://fixture.invalid',
    )
    expect(AbortSignal.timeout).toHaveBeenCalledWith(60000)
  })

  it('preserves caller cancellation with a longer provider timeout', async () => {
    delayedResponse(20000)
    const caller = new AbortController()
    const outcome = expect(
      createProviderRequest(plugin(30000))('https://fixture.invalid', {
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ code: 'request-failed' })
    await vi.advanceTimersByTimeAsync(1000)
    caller.abort(new Error('Caller stopped'))
    await outcome
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(state.leaseUntil).toBeNull()
  })

  it.each([0, -1, 1.5, 180001, NaN, Infinity])(
    'rejects invalid provider timeout %s before reservation',
    (timeout) => {
      expect(() => createProviderRequest(plugin(timeout))).toThrow()
      expect(mocks.write).not.toHaveBeenCalled()
      expect(mocks.fetch).not.toHaveBeenCalled()
    },
  )

  it.each(['halt', 'cooldown'])(
    'does not bypass an existing %s',
    async (blocked) => {
      state.halted = blocked === 'halt'
      state.cooldownUntil =
        blocked === 'cooldown' ? new Date(Date.now() + 60000) : null
      await expect(
        createProviderRequest(plugin(30000))('https://fixture.invalid'),
      ).rejects.toMatchObject({
        code: blocked === 'halt' ? 'access-denied' : 'cooldown',
      })
      expect(mocks.fetch).not.toHaveBeenCalled()
    },
  )
})
