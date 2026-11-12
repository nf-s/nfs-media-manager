import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test',
    RUNTIME_KIND: 'cloudflare',
    OWNER_EMAIL: 'owner@example.com',
    OWNER_USER_ID: '',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
    SCRAPING_ENABLED: true,
  },
  getSession: vi.fn(),
  plugin: vi.fn(),
  getStatus: vi.fn(),
  setPaused: vi.fn(),
  getByName: vi.fn(),
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
vi.mock('@/cloudflare/db', () => ({ withCloudDatabase: vi.fn() }))
vi.mock('@/cloudflare/provider-coordinator', () => ({
  ProviderCoordinator: class {},
}))
vi.mock('@/cloudflare/local-worker-coordinator', () => ({
  LocalRequestWorker: class {},
}))

import app from '@/app'
import '@/cloudflare/worker'

const path = '/api/v1/cloud/providers/fixture/dispatch'
const status = {
  provider: 'fixture',
  paused: true,
  allowedJobIds: ['job-30'],
  stopped: false,
  failures: 0,
  infrastructureFailures: 0,
  slots: [],
}

function session(email = 'owner@example.com', role = 'admin') {
  return {
    user: { id: 'owner', email, role, name: 'Owner' },
    session: { id: 'session-1', userId: 'owner' },
  }
}

function control(body: unknown, origin = 'http://localhost:3000') {
  return app.request(path, {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.env.SCRAPING_ENABLED = true
  mocks.getSession.mockResolvedValue(session())
  mocks.plugin.mockResolvedValue({ manifest: { id: 'fixture' } })
  mocks.getStatus.mockResolvedValue(status)
  mocks.setPaused.mockResolvedValue(true)
  mocks.getByName.mockReturnValue({
    getStatus: mocks.getStatus,
    setPaused: mocks.setPaused,
  })
  vi.spyOn(AsyncLocalStorage.prototype, 'getStore').mockReturnValue({
    PROVIDER_COORDINATORS: { getByName: mocks.getByName },
  })
})

afterEach(() => vi.restoreAllMocks())

describe('Cloudflare dispatch owner API', () => {
  it('reads status with scraping disabled without changing dispatch settings', async () => {
    mocks.env.SCRAPING_ENABLED = false
    const response = await app.request(path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ statusCode: 200, data: status })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
    expect(mocks.getByName).toHaveBeenCalledExactlyOnceWith('fixture')
    expect(mocks.getStatus).toHaveBeenCalledExactlyOnceWith('fixture')
    expect(mocks.setPaused).not.toHaveBeenCalled()
  })

  it.each([
    { identity: null, code: 401 },
    { identity: session('other@example.com'), code: 403 },
    { identity: session('owner@example.com', 'user'), code: 403 },
  ])(
    'denies non-owner status and control access ($code)',
    async ({ identity, code }) => {
      mocks.getSession.mockResolvedValue(identity)
      expect((await app.request(path)).status).toBe(code)
      expect(
        (await control({ paused: false, jobIds: ['job-30'] })).status,
      ).toBe(code)
      expect(mocks.getByName).not.toHaveBeenCalled()
    },
  )

  it('denies untrusted mutation origins', async () => {
    expect(
      (await control({ paused: false }, 'https://evil.example')).status,
    ).toBe(403)
    expect(mocks.setPaused).not.toHaveBeenCalled()
  })

  it.each([
    { body: { paused: false }, selection: undefined },
    { body: { paused: false, jobIds: null }, selection: null },
    { body: { paused: false, jobIds: [] }, selection: [] },
    { body: { paused: false, jobIds: ['job-30'] }, selection: ['job-30'] },
  ])(
    'preserves the optional selection contract: $body',
    async ({ body, selection }) => {
      expect((await control(body)).status).toBe(200)
      expect(mocks.setPaused).toHaveBeenCalledExactlyOnceWith(
        'fixture',
        false,
        selection,
      )
    },
  )

  it.each([
    {},
    { paused: 'false' },
    { paused: false, jobIds: 'job-30' },
    { paused: false, jobIds: [''] },
    { paused: false, jobIds: [5] },
    { paused: false, jobIds: ['job-30', 'job-30'] },
    {
      paused: false,
      jobIds: Array.from({ length: 11 }, (_, index) => `job-${index}`),
    },
    { paused: false, unknown: true },
  ])('rejects invalid control input: %j', async (body) => {
    expect((await control(body)).status).toBe(422)
    expect(mocks.setPaused).not.toHaveBeenCalled()
  })

  it('returns a conflict when slots prevent changing selection', async () => {
    mocks.setPaused.mockResolvedValue(false)
    const response = await control({ paused: true, jobIds: null })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      message: 'Cannot change job selection while dispatch slots exist',
    })
  })

  it('allows staging a paused canary but rejects resume when scraping is disabled', async () => {
    mocks.env.SCRAPING_ENABLED = false
    expect((await control({ paused: false, jobIds: ['job-30'] })).status).toBe(
      409,
    )
    expect(mocks.setPaused).not.toHaveBeenCalled()
    expect((await control({ paused: true, jobIds: ['job-30'] })).status).toBe(
      200,
    )
    expect(mocks.setPaused).toHaveBeenCalledExactlyOnceWith('fixture', true, [
      'job-30',
    ])
  })

  it('rejects unknown providers without contacting a coordinator', async () => {
    mocks.plugin.mockResolvedValue(null)
    expect((await app.request(path)).status).toBe(404)
    expect((await control({ paused: true })).status).toBe(404)
    expect(mocks.getByName).not.toHaveBeenCalled()
  })

  it('reports missing bindings without creating state', async () => {
    vi.restoreAllMocks()
    expect((await app.request(path)).status).toBe(503)
    expect((await control({ paused: true })).status).toBe(503)
    expect(mocks.getByName).not.toHaveBeenCalled()
  })
})
