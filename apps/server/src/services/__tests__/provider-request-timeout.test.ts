import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PgTable } from 'drizzle-orm/pg-core'
import {
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
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

describe('provider request diagnostics', () => {
  it('retains a fresh 429 response separately from a later local cooldown refusal', async () => {
    const receivedAt = new Date().toISOString()
    mocks.fetch.mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: {
          'retry-after': '120',
          'x-discogs-ratelimit': '60',
          'x-discogs-ratelimit-used': '60',
          'x-discogs-ratelimit-remaining': '0',
        },
      }),
    )
    const request = createProviderRequest(plugin())
    await expect(request('https://fixture.invalid')).rejects.toMatchObject({
      code: 'rate-limit',
      message: 'Provider rate limit reached (HTTP 429)',
      recorded: true,
      retryAt: Date.now() + 120000,
      diagnostics: {
        source: 'provider-response',
        httpStatus: 429,
        responseReceivedAt: receivedAt,
        retryAfter: { seconds: 120 },
        quotaHeaders: {
          'x-discogs-ratelimit': 60,
          'x-discogs-ratelimit-used': 60,
          'x-discogs-ratelimit-remaining': 0,
        },
      },
    })
    await expect(request('https://fixture.invalid')).rejects.toMatchObject({
      code: 'cooldown',
      message: `Provider cooldown is active. Retry after ${new Date(Date.now() + 120000).toISOString()}.`,
      recorded: true,
      diagnostics: { source: 'local-cooldown' },
    })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it.each([200, 403])(
    'identifies a recognized JSON quota error returned with HTTP %s',
    async (status) => {
      mocks.fetch.mockResolvedValue(
        Response.json(
          {
            error: { code: 403, errors: [{ reason: 'quotaExceeded' }] },
          },
          { status },
        ),
      )
      await expect(
        createProviderRequest(plugin())('https://fixture.invalid'),
      ).rejects.toMatchObject({
        message: `Provider quota error (HTTP ${status})`,
        code: 'rate-limit',
        diagnostics: {
          source: 'provider-response',
          httpStatus: status,
          responseReceivedAt: new Date().toISOString(),
          quotaError: true,
        },
      })
      expect(mocks.fetch).toHaveBeenCalledOnce()
    },
  )

  it('keeps response receipt time before body handling and normalizes an HTTP-date Retry-After', async () => {
    const receivedAt = new Date().toISOString()
    const response = new Response('Unused synthetic body', {
      status: 429,
      headers: { 'Retry-After': 'Thu, 01 Jan 2026 00:02:00 GMT' },
    })
    if (!response.body) throw new Error('Missing fixture response body')
    vi.spyOn(response.body, 'cancel').mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5000)
    })
    mocks.fetch.mockResolvedValue(response)
    await expect(
      createProviderRequest(plugin())('https://fixture.invalid'),
    ).rejects.toMatchObject({
      diagnostics: {
        source: 'provider-response',
        responseReceivedAt: receivedAt,
        retryAfter: { at: '2026-01-01T00:02:00.000Z' },
      },
    })
  })

  it('omits arbitrary headers, response bodies and invalid numeric quota values', async () => {
    mocks.fetch.mockResolvedValue(
      new Response('Synthetic response body', {
        status: 429,
        headers: {
          'Retry-After': 'invalid retry value',
          Authorization: 'fixture-not-a-credential',
          'Set-Cookie': 'fixture-not-a-cookie',
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '-1',
          'x-ratelimit-reset': '1e9',
          'x-discogs-ratelimit': 'not-a-number',
          'x-discogs-ratelimit-used': '9007199254740992',
          'x-discogs-ratelimit-remaining': ' 0 ',
        },
      }),
    )
    const error: unknown = await createProviderRequest(plugin())(
      'https://fixture.invalid/private?token=fixture',
    ).catch((failure: unknown) => failure)
    if (!(error instanceof ProviderRequestError))
      throw new Error('Expected provider request failure')
    expect(error.diagnostics).toEqual({
      source: 'provider-response',
      httpStatus: 429,
      responseReceivedAt: new Date().toISOString(),
      quotaError: false,
      quotaHeaders: {
        'x-ratelimit-limit': 100,
        'x-discogs-ratelimit-remaining': 0,
      },
    })
    expect(error.cause).toMatchObject({ diagnostics: error.diagnostics })
  })

  it('identifies a local hourly budget without making a provider request', async () => {
    const limited = plugin()
    limited.manifest.rateLimit.maxRequestsPerHour = 1
    state.requests = [Date.now() - 1000]
    await expect(
      createProviderRequest(limited)('https://fixture.invalid'),
    ).rejects.toMatchObject({
      code: 'cooldown',
      diagnostics: { source: 'local-budget' },
      retryAt: Date.now() - 1000 + 3600000,
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(state.failureCount).toBe(0)
  })

  it('identifies a local access halt without claiming a fresh HTTP response', async () => {
    state.halted = true
    state.lastError = 'Provider request failed (HTTP 403)'
    const error: unknown = await createProviderRequest(plugin())(
      'https://fixture.invalid',
    ).catch((failure: unknown) => failure)
    if (!(error instanceof ProviderRequestError))
      throw new Error('Expected provider request failure')
    expect(error.diagnostics).toEqual({ source: 'local-access-halt' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
