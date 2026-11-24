import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PgTable } from 'drizzle-orm/pg-core'
import {
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  createProviderResponseRecorder,
  replayProviderResponses,
  type ProviderResponseCapture,
} from '@/lib/provider-response-history'
import { providerRequestEvent, providerRequestState } from '@/schemas/db'
import {
  PROVIDER_ERROR_BODY_BYTES,
  providerResponseEvidence,
} from '@/lib/job-diagnostics'
import {
  withProviderTransport,
  type ProviderTransport,
} from '../provider-transport'

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
  mocks.write.mockReset()
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

describe('scrape-provider request evidence', () => {
  function setup() {
    const archive: ProviderResponseCapture[] = []
    const recorder = createProviderResponseRecorder(async (capture) => {
      archive.push(capture)
    }, [])
    return {
      archive,
      request: createProviderRequest(plugin(), undefined, {
        beginResponseCapture: recorder('media'),
      }),
    }
  }

  it('persists full direct response before the adapter can parse it', async () => {
    const { request, archive } = setup()
    const raw = JSON.stringify({ unknown: 'x'.repeat(80_000) })
    mocks.fetch.mockResolvedValue(
      new Response(raw, {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    // The Node HTTP adapter replaces the global constructor. Fetch still
    // returns native responses, including for token exchanges.
    vi.stubGlobal('Response', class extends Response {})
    const response = await request('https://fixture.invalid/metadata?fixture=1')
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text: raw,
      redacted: false,
    })
    await expect(response.text()).resolves.toBe(raw)
  })

  it('records successful absence without creating a provider failure', async () => {
    const { request, archive } = setup()
    mocks.fetch.mockResolvedValue(
      Response.json(
        { unknownErrorField: 'Fixture not found' },
        {
          status: 404,
        },
      ),
    )
    await expect(
      request('https://fixture.invalid/metadata', undefined, {
        notFoundOn404: true,
      }),
    ).rejects.toMatchObject({ name: 'ProviderItemNotFoundError' })
    expect(archive[0]?.response).toMatchObject({
      status: 404,
      notFound: true,
      body: {
        state: 'captured',
        text: '{"unknownErrorField":"Fixture not found"}',
      },
    })
    expect(state.failureCount).toBe(0)
  })

  it('retains the recoverable HTTP error body independently of diagnostics', async () => {
    const { request, archive } = setup()
    const text = JSON.stringify({ unknown: 'x'.repeat(90_000) })
    mocks.fetch.mockResolvedValueOnce(
      new Response(text, {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const error: unknown = await request(
      'https://fixture.invalid/metadata',
      undefined,
      { notFoundOn404: true },
    ).catch((error: unknown) => error)
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text,
      redacted: false,
    })
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: {
          responseBody: { state: 'unavailable', reason: 'byte-limit' },
        },
      },
    ])
  })

  it('keeps a scoped response policy from leaking into duplicate error diagnostics', async () => {
    const archive: ProviderResponseCapture[] = []
    const recorder = createProviderResponseRecorder(
      async (entry) => {
        archive.push(entry)
      },
      [],
      undefined,
      undefined,
      () => ({
        sanitizeBody: () => ({ state: 'unavailable', reason: 'policy' }),
      }),
    )
    const request = createProviderRequest(plugin(), undefined, {
      beginResponseCapture: recorder('task'),
    })
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ adPlacements: ['synthetic-value'] }, { status: 500 }),
    )
    const error: unknown = await request(
      'https://fixture.invalid/metadata',
    ).catch((cause: unknown) => cause)
    expect(archive[0]?.response.body).toEqual({
      state: 'unavailable',
      reason: 'policy',
    })
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: { responseBody: { state: 'unavailable', reason: 'policy' } },
      },
    ])
  })

  it('does not keep a bare legacy local error response as original evidence', async () => {
    const { request, archive } = setup()
    const error: unknown = await withProviderTransport(
      async () => ({
        execute: async () =>
          Response.json({ unknown: 'legacy projected value' }, { status: 404 }),
      }),
      () =>
        request('https://fixture.invalid/metadata', undefined, {
          notFoundOn404: true,
        }),
    ).catch((error: unknown) => error)
    expect(archive[0]?.response.body).toEqual({
      state: 'unavailable',
      reason: 'local-response',
    })
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: {
          responseBody: { state: 'unavailable', reason: 'local-response' },
        },
      },
    ])
  })

  it('fails visibly after a storage error without starting a retry or a provider failure', async () => {
    const recorder = createProviderResponseRecorder(async () => {
      throw new Error('Fixture storage unavailable')
    }, [])
    const onRetry = vi.fn(async () => undefined)
    const request = createProviderRequest(plugin(), undefined, {
      beginResponseCapture: recorder('media'),
      onRetry,
    })
    mocks.fetch.mockResolvedValueOnce(Response.json({ fixture: true }))
    await expect(
      request('https://fixture.invalid/metadata'),
    ).rejects.toMatchObject({
      name: 'ProviderResponseStorageError',
      message: 'Provider response evidence could not be saved.',
    })
    await expect(
      request('https://fixture.invalid/other'),
    ).rejects.toMatchObject({
      name: 'ProviderResponseStorageError',
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(state.failureCount).toBe(0)
    expect(state.halted).toBe(false)
    expect(state.leaseId).toBeNull()
  })

  it('archives and replays an adapter-ready response from a paired generic worker', async () => {
    const { request, archive } = setup()
    const url = 'https://fixture.invalid/metadata'
    await withProviderTransport(
      async () => ({
        execute: async () => ({
          response: Response.json({ original: 22 }),
          providerResponseCapture: {
            body: { state: 'captured', text: '{"original":22}' },
            contentType: 'application/json',
            representation: 'adapter',
          },
        }),
      }),
      () => request(url),
    )
    const replayed = await replayProviderResponses(archive, (replay) =>
      replay(url),
    )
    await expect(replayed.json()).resolves.toEqual({ original: 22 })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('stores paired native evidence and still returns the projected adapter response', async () => {
    const { request, archive } = setup()
    const response = await withProviderTransport(
      async () => ({
        execute: async () => ({
          response: Response.json({ projected: true }),
          providerResponseCapture: {
            status: 200,
            contentType: 'application/json',
            body: {
              state: 'captured',
              text: '{"native":{"unknown":42},"username":"fixture-uploader"}',
            },
          },
        }),
      }),
      () => request('https://fixture.invalid/metadata'),
    )
    await expect(response.json()).resolves.toEqual({ projected: true })
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      redacted: true,
      text: '{"native":{"unknown":42}}',
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

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
  it.each([429, 503])(
    'retains the HTTP %s error response body',
    async (status) => {
      const body = '{"message":"Synthetic provider failure"}'
      mocks.fetch.mockResolvedValue(
        new Response(body, {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      )
      const error: unknown = await createProviderRequest(plugin())(
        'https://fixture.invalid',
      ).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(ProviderRequestError)
      expect(JSON.stringify(error)).not.toContain('Synthetic provider failure')
      expect(providerResponseEvidence(error, [])).toEqual([
        {
          stage: 'provider.response',
          evidence: {
            source: 'provider-response',
            httpStatus: status,
            responseReceivedAt: new Date().toISOString(),
            quotaError: false,
            contentType: 'application/json',
            responseBody: {
              state: 'captured',
              format: 'json',
              text: body,
              redacted: false,
            },
          },
        },
      ])
    },
  )

  it('redacts echoed credentials and nested sensitive fields before persisting the body', async () => {
    const body =
      '{"message":"Driver selected fixture-bearer and fixture-query","data":{"api\\u004bey":"fixture-extra","email":"member@fixture.invalid","status":"overloaded"}}'
    mocks.fetch.mockResolvedValue(
      new Response(body, {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const error: unknown = await createProviderRequest(plugin())(
      'https://fixture.invalid?api_key=fixture-query',
      { headers: { Authorization: 'Bearer fixture-bearer' } },
    ).catch((failure: unknown) => failure)
    const evidence = providerResponseEvidence(error, [])
    expect(evidence).toMatchObject([
      {
        evidence: {
          responseBody: { state: 'captured', format: 'json', redacted: true },
        },
      },
    ])
    const serialized = JSON.stringify(evidence)
    expect(serialized).toContain('overloaded')
    for (const value of [
      'fixture-bearer',
      'fixture-query',
      'fixture-extra',
      'member@fixture.invalid',
    ])
      expect(serialized).not.toContain(value)
  })

  it('reports the byte limit instead of retaining a partial error body', async () => {
    mocks.fetch.mockResolvedValue(
      new Response('é'.repeat(PROVIDER_ERROR_BODY_BYTES), { status: 503 }),
    )
    const error: unknown = await createProviderRequest(plugin())(
      'https://fixture.invalid',
    ).catch((failure: unknown) => failure)
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: {
          responseBody: { state: 'unavailable', reason: 'byte-limit' },
        },
      },
    ])
  })

  it('persists HTTP 429 safety before waiting for a stalled diagnostic body', async () => {
    const retryAt = Date.now() + 120000
    const cancel = vi.fn()
    mocks.fetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 429,
        headers: { 'Retry-After': '120', 'Content-Type': 'text/plain' },
      }),
    )
    const outcome = createProviderRequest(plugin())(
      'https://fixture.invalid',
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(999)
    expect(state.cooldownUntil?.getTime()).toBe(retryAt)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect(error).toMatchObject({ code: 'rate-limit', retryAt })
    expect(cancel).toHaveBeenCalledOnce()
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: {
          responseBody: { state: 'unavailable', reason: 'read-failed' },
        },
      },
    ])
  })

  it('halts on HTTP 403 when the JSON body stalls beyond the diagnostic deadline', async () => {
    const cancel = vi.fn()
    mocks.fetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const outcome = createProviderRequest(plugin(120000))(
      'https://fixture.invalid',
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    const error = await outcome
    expect(error).toMatchObject({
      code: 'access-denied',
      diagnostics: { httpStatus: 403, quotaError: false },
    })
    expect(state.halted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: {
          responseBody: { state: 'unavailable', reason: 'read-failed' },
        },
      },
    ])
  })

  it('preserves buffered local evidence received after the direct request timeout', async () => {
    const text = 'Synthetic service rejected [redacted]'
    const outcome = withProviderTransport(
      async () => ({
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 16000))
          return new Response(text, { status: 503 })
        },
      }),
      () => createProviderRequest(plugin())('https://fixture.invalid'),
    ).catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(16000)
    const error: unknown = await outcome
    expect(providerResponseEvidence(error, [])).toMatchObject([
      {
        evidence: {
          responseBody: {
            state: 'captured',
            format: 'text',
            text,
            redacted: true,
          },
        },
      },
    ])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

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
      headers: {
        'Retry-After': 'Thu, 01 Jan 2026 00:02:00 GMT',
        'Content-Length': String(PROVIDER_ERROR_BODY_BYTES + 1),
      },
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

  it('omits arbitrary headers and invalid numeric quota values from the error summary', async () => {
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

describe('serial metadata request retries', () => {
  it('retries HTTP 503 through the request gate and returns the successful response', async () => {
    const startedAt = Date.now()
    const onRetry = vi.fn(async () => {})
    mocks.fetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const outcome = expect(
      createProviderRequest(plugin(), undefined, { onRetry })(
        'https://fixture.invalid',
      ).then((response) => response.json()),
    ).resolves.toEqual({ ok: true })

    await vi.advanceTimersByTimeAsync(4999)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(state.failureCount).toBe(0)
    expect(state.cooldownUntil).toBeNull()
    expect(state.leaseUntil).toBeNull()
    expect(state.nextAllowedAt?.getTime()).toBe(startedAt + 5000)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({
        diagnostics: expect.objectContaining({ httpStatus: 503 }),
      }),
      attempt: 2,
      retryAt: startedAt + 5000,
    })

    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(state.requests).toEqual([startedAt, startedAt + 5000])
  })

  it.each([0, 4])(
    'counts three transient responses as one exhausted failure after %s prior failures',
    async (failures) => {
      const startedAt = Date.now()
      state.failureCount = failures
      const onRetry = vi.fn(async () => {})
      mocks.fetch
        .mockResolvedValueOnce(new Response(null, { status: 502 }))
        .mockResolvedValueOnce(new Response(null, { status: 504 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
      const outcome = expect(
        createProviderRequest(plugin(), undefined, { onRetry })(
          'https://fixture.invalid',
        ),
      ).rejects.toMatchObject({
        code: 'request-failed',
        recorded: true,
        diagnostics: { httpStatus: 503 },
      })

      await vi.advanceTimersByTimeAsync(14999)
      expect(mocks.fetch).toHaveBeenCalledTimes(2)
      expect(onRetry).toHaveBeenCalledTimes(2)
      expect(state.failureCount).toBe(failures)
      expect(state.cooldownUntil).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      await outcome

      expect(mocks.fetch).toHaveBeenCalledTimes(3)
      expect(state.requests).toEqual([
        startedAt,
        startedAt + 5000,
        startedAt + 15000,
      ])
      expect(state.failureCount).toBe(failures + 1)
      expect(state.nextAllowedAt?.getTime()).toBe(startedAt + 25000)
      expect(state.cooldownUntil).toEqual(
        failures === 4 ? new Date(startedAt + 15000 + 900000) : null,
      )
    },
  )

  it('honors Retry-After when it extends the default wait', async () => {
    const startedAt = Date.now()
    const onRetry = vi.fn(async () => {})
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { 'Retry-After': '8' } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const outcome = createProviderRequest(plugin(), undefined, { onRetry })(
      'https://fixture.invalid',
    )
    await vi.advanceTimersByTimeAsync(7999)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(state.nextAllowedAt?.getTime()).toBe(startedAt + 8000)
    await vi.advanceTimersByTimeAsync(1)
    expect((await outcome).ok).toBe(true)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('persists a Retry-After beyond the retry window as a provider cooldown', async () => {
    const startedAt = Date.now()
    const onRetry = vi.fn(async () => {})
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { 'Retry-After': '120' } }),
    )
    const request = createProviderRequest(plugin(), undefined, { onRetry })
    await expect(request('https://fixture.invalid')).rejects.toMatchObject({
      code: 'request-failed',
      retryAt: startedAt + 120000,
    })
    await expect(request('https://fixture.invalid')).rejects.toMatchObject({
      code: 'cooldown',
      retryAt: startedAt + 120000,
    })
    expect(state.failureCount).toBe(1)
    expect(state.cooldownUntil?.getTime()).toBe(startedAt + 120000)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('does not reserve a retry after its execution window expires', async () => {
    const onRetry = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 60001))
    })
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const outcome = expect(
      createProviderRequest(plugin(), undefined, { onRetry })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({
      message:
        'Provider request failed (HTTP 503). Request retry window expired.',
      recorded: true,
      diagnostics: { httpStatus: 503 },
    })
    await vi.advanceTimersByTimeAsync(60001)
    await outcome
    expect(state.requests).toHaveLength(1)
    expect(state.failureCount).toBe(1)
    expect(state.cooldownUntil).toBeNull()
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('retains the HTTP failure when job history cannot record the retry', async () => {
    const onRetry = vi.fn(async () => {
      throw new Error('Synthetic log error')
    })
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(
      createProviderRequest(plugin(), undefined, { onRetry })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({
      message:
        'Provider request failed (HTTP 503). Could not record the request retry.',
      recorded: true,
      diagnostics: { httpStatus: 503 },
    })
    expect(state.failureCount).toBe(1)
    expect(state.requests).toHaveLength(1)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('starts the retry window at response receipt before dispatch accounting', async () => {
    const response = new Response('Synthetic failure', { status: 503 })
    mocks.write.mockImplementation((table) => {
      if (table === providerRequestEvent) vi.setSystemTime(Date.now() + 60000)
    })
    const onRetry = vi.fn(async () => {})
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(
      createProviderRequest(plugin(), undefined, { onRetry })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({ diagnostics: { httpStatus: 503 } })
    expect(onRetry).not.toHaveBeenCalled()
    expect(state.failureCount).toBe(1)
    expect(state.requests).toHaveLength(1)
  })

  it('allows a local worker to dispatch after a slow handoff with its lease still held', async () => {
    const startedAt = Date.now()
    const execute = vi.fn<ProviderTransport['execute']>(
      async (_url, timing) => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        if (Date.now() >= timing.dispatchBefore)
          throw new Error('Synthetic handoff exceeded the dispatch deadline')
        expect(timing.expiresAt).toBe(timing.dispatchBefore + 15000)
        expect(state.leaseUntil?.getTime()).toBeGreaterThan(timing.expiresAt)
        await new Promise((resolve) => setTimeout(resolve, 14000))
        return Response.json({ ok: true })
      },
    )
    const request = createProviderRequest(plugin())
    const outcome = withProviderTransport(
      async () => ({ execute }),
      () => request('https://fixture.invalid'),
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(19000)
    expect(await outcome).toHaveProperty('status', 200)
    expect(execute).toHaveBeenCalledOnce()
    expect(state.requests).toEqual([startedAt + 19000])
    expect(state.nextAllowedAt?.getTime()).toBe(startedAt + 19250)
    expect(state.leaseUntil).toBeNull()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('bounds the local worker retry dispatch window at the same deadline', async () => {
    const startedAt = Date.now()
    const onRetry = vi.fn(async () => {})
    const execute = vi.fn<ProviderTransport['execute']>()
    execute
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { 'Retry-After': '59' } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const request = createProviderRequest(plugin(), undefined, { onRetry })
    const outcome = withProviderTransport(
      async () => ({ execute }),
      () => request('https://fixture.invalid'),
    )
    await vi.advanceTimersByTimeAsync(59000)
    expect((await outcome).ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenNthCalledWith(2, 'https://fixture.invalid', {
      dispatchBefore: startedAt + 60000,
      expiresAt: startedAt + 75000,
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('counts the first request against the budget before reserving a retry', async () => {
    const limited = plugin()
    limited.manifest.rateLimit.maxRequestsPerHour = 1
    const onRetry = vi.fn(async () => {})
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(
      createProviderRequest(limited, undefined, { onRetry })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({
      code: 'cooldown',
      diagnostics: { source: 'local-budget' },
    })
    expect(state.requests).toHaveLength(1)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it.each(['job', 'signal'])(
    'cancels retry waits through the %s',
    async (cancellation) => {
      const controller = new AbortController()
      let cancelled = false
      const assertActive = async () => {
        if (cancelled) throw new Error('Cancelled fixture request')
      }
      const onRetry = vi.fn(async () => {})
      mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
      const outcome = expect(
        createProviderRequest(plugin(), assertActive, { onRetry })(
          'https://fixture.invalid',
          { signal: controller.signal },
        ),
      ).rejects.toThrow('Cancelled fixture request')
      await vi.advanceTimersByTimeAsync(1)
      if (cancellation === 'job') cancelled = true
      else controller.abort(new Error('Cancelled fixture request'))
      await vi.advanceTimersByTimeAsync(1000)
      await outcome
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(state.requests).toHaveLength(1)
      expect(state.failureCount).toBe(0)
      expect(state.leaseUntil).toBeNull()
    },
  )

  it.each([
    { status: 401, code: 'access-denied', halted: true },
    { status: 403, code: 'access-denied', halted: true },
    { status: 429, code: 'rate-limit', halted: false },
    { status: 500, code: 'request-failed', halted: false },
  ])('does not retry HTTP $status', async ({ status, code, halted }) => {
    const onRetry = vi.fn(async () => {})
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status }))
    await expect(
      createProviderRequest(plugin(), undefined, { onRetry })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({ code })
    expect(state.halted).toBe(halted)
    expect(state.failureCount).toBe(1)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each([200, 403])(
    'does not retry a quota error in HTTP %s',
    async (status) => {
      const onRetry = vi.fn(async () => {})
      mocks.fetch.mockResolvedValueOnce(
        Response.json(
          { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } },
          { status },
        ),
      )
      await expect(
        createProviderRequest(plugin(), undefined, { onRetry })(
          'https://fixture.invalid',
        ),
      ).rejects.toMatchObject({ code: 'rate-limit' })
      expect(state.halted).toBe(false)
      expect(state.cooldownUntil).not.toBeNull()
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(onRetry).not.toHaveBeenCalled()
    },
  )

  it('honors confirmed quota exhaustion on an otherwise retryable response', async () => {
    const limited = plugin()
    limited.manifest.rateLimit.respectRateLimitHeaders = true
    const reset = Date.now() + 120000
    const onRetry = vi.fn(async () => {})
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 503,
        headers: {
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(reset / 1000),
        },
      }),
    )
    await expect(
      createProviderRequest(limited, undefined, { onRetry })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({
      code: 'rate-limit',
      retryAt: reset,
      diagnostics: { httpStatus: 503, quotaError: true },
    })
    expect(state.cooldownUntil?.getTime()).toBe(reset)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each([
    { method: 'POST', concurrent: false },
    { method: 'GET', concurrent: true },
  ])(
    'does not retry HTTP 503 for $method with concurrent=$concurrent',
    async ({ method, concurrent }) => {
      const onRetry = vi.fn(async () => {})
      mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
      await expect(
        createProviderRequest(plugin(undefined, concurrent), undefined, {
          onRetry,
        })('https://fixture.invalid', { method }),
      ).rejects.toMatchObject({ code: 'request-failed' })
      expect(state.cooldownUntil).not.toBeNull()
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(onRetry).not.toHaveBeenCalled()
    },
  )
})
