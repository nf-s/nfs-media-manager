import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_RESPONSE_BYTES } from '@repo/media-plugin-sdk/local-worker'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    RUNTIME_KIND: 'cloudflare',
    OWNER_EMAIL: 'owner@example.com',
    OWNER_USER_ID: '',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
    SCRAPING_ENABLED: true,
  },
  getSession: vi.fn(),
  plugin: vi.fn(),
  status: vi.fn(),
  heartbeat: vi.fn(),
  authorizeResult: vi.fn(),
  getPolicy: vi.fn(),
  take: vi.fn(),
  confirmStart: vi.fn(),
  result: vi.fn(),
  configure: vi.fn(),
  revoke: vi.fn(),
  unconfigure: vi.fn(),
  getReviewResult: vi.fn(),
  review: vi.fn(),
  getStatus: vi.fn(),
  wake: vi.fn(),
  getWorker: vi.fn(),
  getCoordinator: vi.fn(),
  protect: vi.fn(),
  withDatabase: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  enqueue: vi.fn(),
  readResult: vi.fn(),
  consumeResult: vi.fn(),
  expire: vi.fn(),
}))

vi.mock('@/env', () => ({ env: mocks.env }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession }, handler: vi.fn() },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: mocks.plugin,
  listLoadedScrapePlugins: vi.fn(),
}))
vi.mock('@/cloudflare/db', () => ({ withCloudDatabase: mocks.withDatabase }))
vi.mock('@/cloudflare/provider-coordinator', () => ({
  ProviderCoordinator: class {},
}))
vi.mock('@/cloudflare/local-worker-coordinator', () => ({
  LocalRequestWorker: class {},
}))
vi.mock('@/services/provider-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/provider-requests')>()),
  protectProviderFromLocalResponse: mocks.protect,
}))

import app from '@/app'
import '@/cloudflare/worker'
import {
  handleLocalWorkerRequest,
  localProviderTransport,
} from '@/cloudflare/local-worker'

const token = 'a'.repeat(43)
const tokenHash = createHash('sha256').update(token).digest('hex')
const id = '00000000-0000-4000-8000-000000000001'
const policy = {
  origin: 'https://fixture.invalid',
  paths: ['/metadata'],
  credentialHeaders: ['X-Fixture-Key'],
  queryParameters: [],
}
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    localWorker: policy,
    rateLimit: { maxConcurrent: 1, minTimeMs: 50, maxRequestsPerHour: 140 },
  },
}
const status = {
  configured: true,
  online: true,
  blocked: false,
  active: false,
  lastSeenAt: 1700000000000,
}
const task = {
  id,
  url: 'https://fixture.invalid/metadata',
  dispatchBefore: 1700000004000,
  expiresAt: 1700000019000,
}
const permit = {
  serverTime: 1700000000000,
  dispatchBefore: task.dispatchBefore,
  expiresAt: task.expiresAt,
}
const result = {
  kind: 'response',
  id,
  status: 429,
  headers: { 'retry-after': '7200' },
  body: '',
}
const controlPath = '/api/v1/cloud/providers/fixture/local-worker'
const bindingContext = new AsyncLocalStorage<CloudflareBindings>()

function session(email = 'owner@example.com', role = 'admin') {
  return {
    user: { id: 'owner', email, role, name: 'Owner' },
    session: { id: 'session-1', userId: 'owner' },
  }
}

async function request(path: string, init?: RequestInit) {
  const bindings = bindingContext.getStore()
  if (!bindings) throw new Error('Missing test worker bindings')
  const input = new Request(`http://localhost${path}`, init)
  return (await handleLocalWorkerRequest(input, bindings)) ?? app.fetch(input)
}

function operation(
  action: string,
  body: unknown = {},
  authorization = `Bearer ${token}`,
) {
  return request(`/api/v1/local-worker/fixture/${action}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function control(body: unknown, origin = 'http://localhost:3000') {
  return app.request(controlPath, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.env.SCRAPING_ENABLED = true
  mocks.getSession.mockResolvedValue(null)
  mocks.plugin.mockResolvedValue(plugin)
  mocks.status.mockResolvedValue(status)
  mocks.heartbeat.mockResolvedValue(true)
  mocks.authorizeResult.mockResolvedValue(true)
  mocks.getPolicy.mockResolvedValue(policy)
  mocks.take.mockResolvedValue(task)
  mocks.confirmStart.mockResolvedValue(permit)
  mocks.result.mockResolvedValue(true)
  mocks.configure.mockResolvedValue(true)
  mocks.unconfigure.mockResolvedValue(true)
  mocks.getReviewResult.mockResolvedValue(null)
  mocks.review.mockResolvedValue(true)
  mocks.enqueue.mockResolvedValue(true)
  mocks.readResult.mockResolvedValue(null)
  mocks.consumeResult.mockResolvedValue(true)
  mocks.expire.mockResolvedValue(true)
  mocks.getStatus.mockResolvedValue({ paused: true, slots: [] })
  mocks.withDatabase.mockImplementation(
    async (execute: () => Promise<unknown>) => execute(),
  )
  mocks.fetch.mockRejectedValue(new Error('Unexpected network attempt'))
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getWorker.mockReturnValue({
    status: mocks.status,
    heartbeat: mocks.heartbeat,
    authorizeResult: mocks.authorizeResult,
    getPolicy: mocks.getPolicy,
    take: mocks.take,
    confirmStart: mocks.confirmStart,
    result: mocks.result,
    configure: mocks.configure,
    revoke: mocks.revoke,
    unconfigure: mocks.unconfigure,
    getReviewResult: mocks.getReviewResult,
    review: mocks.review,
    enqueue: mocks.enqueue,
    readResult: mocks.readResult,
    consumeResult: mocks.consumeResult,
    expire: mocks.expire,
  })
  mocks.getCoordinator.mockReturnValue({
    getStatus: mocks.getStatus,
    wake: mocks.wake,
  })
  vi.spyOn(AsyncLocalStorage.prototype, 'getStore').mockReturnValue({
    LOCAL_WORKERS: { getByName: mocks.getWorker },
    PROVIDER_COORDINATORS: { getByName: mocks.getCoordinator },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

describe('dedicated local worker capability routes', () => {
  it('polls using only the hashed dedicated token without a browser session', async () => {
    const response = await operation('poll')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      policy,
      task,
      serverTime: expect.any(Number),
    })
    expect(mocks.heartbeat).toHaveBeenCalledExactlyOnceWith(tokenHash)
    expect(mocks.take).toHaveBeenCalledExactlyOnceWith(tokenHash)
    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
  })

  it('wakes only its provider when a previously offline worker polls', async () => {
    mocks.status.mockResolvedValue({ ...status, online: false })
    expect((await operation('poll')).status).toBe(200)
    expect(mocks.getCoordinator).toHaveBeenCalledExactlyOnceWith('fixture')
    expect(mocks.wake).toHaveBeenCalledExactlyOnceWith('fixture')
  })

  it.each(['', 'Bearer short', `Basic ${token}`, `Bearer ${'a'.repeat(44)}`])(
    'rejects malformed authorization %s before coordinator access',
    async (authorization) => {
      expect((await operation('result', result, authorization)).status).toBe(
        401,
      )
      expect(mocks.getWorker).not.toHaveBeenCalled()
      expect(mocks.result).not.toHaveBeenCalled()
      expect(mocks.protect).not.toHaveBeenCalled()
    },
  )

  it.each(['poll', 'start', 'result'])(
    'rejects unauthorized %s before reading or applying its body',
    async (action) => {
      mocks.heartbeat.mockResolvedValue(false)
      mocks.authorizeResult.mockResolvedValue(false)
      const response = await request(`/api/v1/local-worker/fixture/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{invalid',
      })
      expect(response.status).toBe(401)
      expect(mocks.result).not.toHaveBeenCalled()
      expect(mocks.confirmStart).not.toHaveBeenCalled()
      expect(mocks.take).not.toHaveBeenCalled()
      expect(mocks.protect).not.toHaveBeenCalled()
      expect(mocks.wake).not.toHaveBeenCalled()
    },
  )

  it('starts only the specified task and returns a conflict for a consumed permit', async () => {
    const response = await operation('start', { id })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(permit)
    expect(mocks.confirmStart).toHaveBeenCalledExactlyOnceWith(tokenHash, id)
    mocks.confirmStart.mockResolvedValue(null)
    expect((await operation('start', { id })).status).toBe(409)
  })

  it.each([429, 403])(
    'persists accepted HTTP %s safety even when scraping is disabled',
    async (statusCode) => {
      mocks.env.SCRAPING_ENABLED = false
      mocks.heartbeat.mockResolvedValue(false)
      const submitted = { ...result, status: statusCode }
      const response = await operation('result', submitted)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ accepted: true })
      expect(mocks.authorizeResult).toHaveBeenCalledExactlyOnceWith(tokenHash)
      expect(mocks.heartbeat).not.toHaveBeenCalled()
      expect(mocks.result).toHaveBeenCalledExactlyOnceWith(tokenHash, submitted)
      expect(mocks.protect).toHaveBeenCalledExactlyOnceWith(
        plugin,
        statusCode,
        expect.any(Headers),
        '',
      )
      expect(mocks.wake).not.toHaveBeenCalled()
    },
  )

  it('never applies safety from a result the coordinator rejected', async () => {
    mocks.result.mockResolvedValue(false)
    expect((await operation('result', result)).status).toBe(409)
    expect(mocks.protect).not.toHaveBeenCalled()
    expect(mocks.withDatabase).not.toHaveBeenCalled()
  })

  it('accepts infrastructure reports without applying provider failure evidence', async () => {
    expect(
      (await operation('result', { kind: 'error', id, error: 'interrupted' }))
        .status,
    ).toBe(200)
    expect(mocks.protect).not.toHaveBeenCalled()
    expect(mocks.withDatabase).not.toHaveBeenCalled()
  })

  it('allows a saved result upload to retry when safety persistence is unavailable', async () => {
    mocks.protect.mockRejectedValueOnce(new Error('Database unavailable'))
    expect((await operation('result', result)).status).toBe(503)
    expect((await operation('result', result)).status).toBe(200)
    expect(mocks.protect).toHaveBeenCalledTimes(2)
    expect(mocks.take).not.toHaveBeenCalled()
    expect(mocks.confirmStart).not.toHaveBeenCalled()
  })

  it.each(['poll', 'start'])(
    'blocks %s while scraping is disabled',
    async (action) => {
      mocks.env.SCRAPING_ENABLED = false
      expect((await operation(action, { id })).status).toBe(409)
      expect(mocks.take).not.toHaveBeenCalled()
      expect(mocks.confirmStart).not.toHaveBeenCalled()
      expect(mocks.wake).not.toHaveBeenCalled()
    },
  )

  it.each([
    '/api/v1/doc',
    '/api/v1/providers',
    '/api/v1/films',
    '/api/v1/albums',
    '/api/v1/scrape/jobs',
    controlPath,
    '/api/v1/cloud/providers/fixture/dispatch',
  ])(
    'does not authorize general private API %s with a worker token',
    async (path) => {
      const response = await request(path, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(401)
      expect(mocks.getSession).toHaveBeenCalledOnce()
      expect(mocks.getWorker).not.toHaveBeenCalled()
      expect(mocks.getCoordinator).not.toHaveBeenCalled()
    },
  )

  it.each(['poll', 'start', 'result'])(
    'does not authorize %s with an owner session alone',
    async (action) => {
      mocks.getSession.mockResolvedValue(session())
      expect((await operation(action, { id }, '')).status).toBe(401)
      expect(mocks.getWorker).not.toHaveBeenCalled()
    },
  )
})

describe('local worker request bounds', () => {
  it.each([{}, { id: 'invalid' }, { id, extra: true }, { id: 123 }])(
    'rejects invalid start input %j',
    async (body) => {
      expect((await operation('start', body)).status).toBe(422)
      expect(mocks.confirmStart).not.toHaveBeenCalled()
    },
  )

  it.each(['start', 'poll', 'result'])(
    'rejects an oversized declared %s body before invoking the operation',
    async (action) => {
      const response = await request(`/api/v1/local-worker/fixture/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-length': String(LOCAL_RESPONSE_BYTES * 6 + 32769),
        },
        body: JSON.stringify(action === 'result' ? result : { id }),
      })
      expect(response.status).toBe(422)
      expect(mocks.confirmStart).not.toHaveBeenCalled()
      expect(mocks.take).not.toHaveBeenCalled()
      expect(mocks.result).not.toHaveBeenCalled()
      expect(mocks.protect).not.toHaveBeenCalled()
    },
  )

  it.each(['start', 'poll'])(
    'rejects an oversized streamed %s body without a Content-Length',
    async (action) => {
      const response = await request(`/api/v1/local-worker/fixture/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, padding: 'x'.repeat(2048) }),
      })
      expect(response.status).toBe(422)
      expect(mocks.confirmStart).not.toHaveBeenCalled()
      expect(mocks.take).not.toHaveBeenCalled()
    },
  )

  it.each([
    { ...result, id: 'invalid' },
    { ...result, status: 199 },
    { ...result, status: 600 },
    { ...result, headers: { authorization: 'secret' } },
    { ...result, headers: { 'retry-after': 'x'.repeat(4097) } },
    { ...result, body: 'x'.repeat(LOCAL_RESPONSE_BYTES + 1) },
    { ...result, body: '\u00e9'.repeat(LOCAL_RESPONSE_BYTES / 2 + 1) },
    { ...result, extra: true },
    { kind: 'error', id, error: 'unknown' },
  ])('rejects invalid result payload %#', async (body) => {
    expect((await operation('result', body)).status).toBe(422)
    expect(mocks.result).not.toHaveBeenCalled()
    expect(mocks.protect).not.toHaveBeenCalled()
  })
})

describe('local worker owner controls', () => {
  beforeEach(() => mocks.getSession.mockResolvedValue(session()))

  it.each([
    { identity: null, code: 401 },
    { identity: session('other@example.com'), code: 403 },
    { identity: session('owner@example.com', 'user'), code: 403 },
  ])(
    'denies non-owner status and configuration ($code)',
    async ({ identity, code }) => {
      mocks.getSession.mockResolvedValue(identity)
      expect((await app.request(controlPath)).status).toBe(code)
      expect((await control({ mode: 'pair' })).status).toBe(code)
      expect(mocks.getWorker).not.toHaveBeenCalled()
    },
  )

  it('rejects an untrusted origin before changing worker configuration', async () => {
    expect(
      (await control({ mode: 'revoke' }, 'https://evil.example')).status,
    ).toBe(403)
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it('returns status without exposing the token or changing dispatch', async () => {
    const response = await app.request(controlPath)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: status })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.configure).not.toHaveBeenCalled()
  })

  it.each([
    { paused: false, slots: [] },
    { paused: true, slots: [{}] },
  ])(
    'requires a paused and idle dispatcher before pairing: %j',
    async (dispatch) => {
      mocks.getStatus.mockResolvedValue(dispatch)
      expect((await control({ mode: 'pair' })).status).toBe(409)
      expect(mocks.configure).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { mode: 'unknown' }, { mode: 'pair', extra: true }])(
    'rejects invalid owner configuration %j',
    async (body) => {
      expect((await control(body)).status).toBe(422)
      expect(mocks.configure).not.toHaveBeenCalled()
    },
  )

  it('rejects unknown providers without accessing their worker', async () => {
    mocks.plugin.mockResolvedValue(null)
    expect((await app.request(controlPath)).status).toBe(404)
    expect((await control({ mode: 'pair' })).status).toBe(404)
    expect(mocks.getWorker).not.toHaveBeenCalled()
  })

  it('persists retained safety evidence before an owner review can unblock the worker', async () => {
    mocks.getReviewResult.mockResolvedValue(result)
    mocks.review.mockImplementation(async () => {
      expect(mocks.protect).toHaveBeenCalledExactlyOnceWith(
        plugin,
        429,
        expect.any(Headers),
        '',
      )
      return true
    })
    expect((await control({ mode: 'review' })).status).toBe(200)
    expect(mocks.review).toHaveBeenCalledOnce()
  })

  it('does not unblock a worker if retained safety evidence could not be persisted', async () => {
    mocks.getReviewResult.mockResolvedValue(result)
    mocks.protect.mockRejectedValue(new Error('Safety persistence unavailable'))
    expect((await control({ mode: 'review' })).status).toBe(500)
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it.each([
    { paused: false, slots: [] },
    { paused: true, slots: [{}] },
  ])(
    'requires paused and idle dispatch for owner review: %j',
    async (dispatch) => {
      mocks.getStatus.mockResolvedValue(dispatch)
      expect((await control({ mode: 'review' })).status).toBe(409)
      expect(mocks.getReviewResult).not.toHaveBeenCalled()
      expect(mocks.review).not.toHaveBeenCalled()
    },
  )

  it('does not clear a pending execution window through owner review', async () => {
    mocks.review.mockResolvedValue(false)
    expect((await control({ mode: 'review' })).status).toBe(409)
  })

  it('does not grant owner review authority to the dedicated worker token', async () => {
    mocks.getSession.mockResolvedValue(null)
    expect(
      (
        await request(controlPath, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ mode: 'review' }),
        })
      ).status,
    ).toBe(401)
    expect(mocks.review).not.toHaveBeenCalled()
  })
})

describe('local worker transport RPC boundary', () => {
  async function transport() {
    const bindings = bindingContext.getStore()
    if (!bindings) throw new Error('Missing test worker bindings')
    return localProviderTransport(bindings, plugin)
  }

  it.each([
    { ...status, online: false },
    { ...status, blocked: true },
  ])(
    'rejects unavailable workers as recorded infrastructure errors: %j',
    async (workerStatus) => {
      mocks.status.mockResolvedValue(workerStatus)
      await expect(transport()).rejects.toMatchObject({
        code: 'request-failed',
        recorded: true,
      })
      expect(mocks.enqueue).not.toHaveBeenCalled()
    },
  )

  it('returns cloud execution only when the worker is not configured', async () => {
    mocks.status.mockResolvedValue({
      ...status,
      configured: false,
      online: false,
    })
    expect(await transport()).toBeNull()
  })

  it('rejects an off-policy URL without sending it to the worker', async () => {
    const selected = await transport()
    if (!selected) throw new Error('Missing configured transport')
    await expect(
      selected.execute('https://other.invalid/metadata', {
        dispatchBefore: Date.now() + 4000,
        expiresAt: Date.now() + 19000,
      }),
    ).rejects.toMatchObject({ code: 'request-failed', recorded: true })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it.each(['enqueue', 'readResult', 'consumeResult'])(
    'holds the full execution horizon after an ambiguous %s RPC failure',
    async (operation) => {
      vi.useFakeTimers()
      const failure = new Error('RPC response lost after commit')
      if (operation === 'enqueue') mocks.enqueue.mockRejectedValue(failure)
      if (operation === 'readResult')
        mocks.readResult.mockRejectedValue(failure)
      if (operation === 'consumeResult') {
        mocks.readResult.mockResolvedValue({
          ...result,
          status: 200,
          body: '{}',
        })
        mocks.consumeResult.mockRejectedValue(failure)
      }
      const selected = await transport()
      if (!selected) throw new Error('Missing configured transport')
      const timing = {
        dispatchBefore: Date.now() + 4000,
        expiresAt: Date.now() + 19000,
      }
      let settled = false
      const completed = selected
        .execute(task.url, timing)
        .catch((error: unknown) => {
          settled = true
          return error
        })
      await vi.advanceTimersByTimeAsync(18999)
      expect(settled).toBe(false)
      expect(mocks.expire).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await completed).toBe(failure)
      expect(mocks.expire).toHaveBeenCalledOnce()
      expect(mocks.enqueue).toHaveBeenCalledOnce()
    },
  )

  it('expires an unanswered task without automatically resubmitting it', async () => {
    vi.useFakeTimers()
    const selected = await transport()
    if (!selected) throw new Error('Missing configured transport')
    const timing = {
      dispatchBefore: Date.now() + 4000,
      expiresAt: Date.now() + 19000,
    }
    const completed = selected
      .execute(task.url, timing)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(19000)
    expect(await completed).toMatchObject({
      code: 'request-failed',
      recorded: true,
    })
    expect(mocks.enqueue).toHaveBeenCalledOnce()
    expect(mocks.expire).toHaveBeenCalled()
  })
})
