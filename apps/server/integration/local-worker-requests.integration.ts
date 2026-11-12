import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import {
  withProviderTransport,
  type ProviderTransport,
} from '@/services/provider-transport'

vi.mock('@/lib/load-workspace-env', () => ({ loadWorkspaceEnv: () => {} }))

const database = `media_local_worker_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const fetchMock = vi.fn<typeof fetch>()
const execute = vi.fn<ProviderTransport['execute']>()
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 50,
      maxRequestsPerHour: 140,
      rateLimitCooldownMs: 3600000,
    },
  },
}
const url = 'https://fixture.invalid/metadata'

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.delete(schema.providerRequestState)
  fetchMock
    .mockReset()
    .mockRejectedValue(new Error('Unexpected network attempt'))
  execute
    .mockReset()
    .mockImplementation(async () => Response.json({ ok: true }))
})
afterEach(() => {
  vi.restoreAllMocks()
  expect(fetchMock).not.toHaveBeenCalled()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

function latch() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function state() {
  const [value] = await databaseClient
    .select()
    .from(schema.providerRequestState)
  if (!value) throw new Error('Missing provider request state')
  return value
}

async function remoteRequest(configuredPlugin = plugin) {
  const { createProviderRequest } = await import('@/services/provider-requests')
  return withProviderTransport(
    async () => ({ execute }),
    () => createProviderRequest(configuredPlugin)(url),
  )
}

describe('local worker shared provider gate', () => {
  it('routes through the scoped transport with deadlines inside the durable lease', async () => {
    execute.mockImplementation(async (requestUrl, timing) => {
      const reserved = await state()
      const [event] = await databaseClient
        .select()
        .from(schema.providerRequestEvent)
      if (!event || !reserved.leaseUntil) throw new Error('Missing reservation')
      expect(requestUrl).toBe(url)
      expect(reserved.leaseId).toBe(event.id)
      expect(timing.dispatchBefore).toBeGreaterThan(Date.now())
      expect(timing.expiresAt - timing.dispatchBefore).toBe(15000)
      expect(timing.expiresAt).toBeLessThan(reserved.leaseUntil.getTime())
      return Response.json({ remote: true })
    })
    expect(await (await remoteRequest()).json()).toEqual({ remote: true })
    expect(execute).toHaveBeenCalledOnce()
    expect(await state()).toMatchObject({
      leaseId: null,
      leaseUntil: null,
      failureCount: 0,
    })
  })

  it('holds the serial lease until the transport finishes, despite caller cancellation', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const started = latch()
    const finish = latch()
    const siblingChecked = latch()
    const controller = new AbortController()
    execute.mockImplementationOnce(async () => {
      started.release()
      await finish.promise
      return Response.json({ ok: true })
    })
    const first = withProviderTransport(
      async () => ({ execute }),
      () => createProviderRequest(plugin)(url, { signal: controller.signal }),
    )
    await started.promise
    const reserved = await state()
    controller.abort()
    const sibling = withProviderTransport(
      async () => ({ execute }),
      () =>
        createProviderRequest(plugin, async () => siblingChecked.release())(
          url,
        ),
    )
    try {
      await siblingChecked.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      expect(execute).toHaveBeenCalledOnce()
      expect((await state()).leaseId).toBe(reserved.leaseId)
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toHaveLength(1)
    } finally {
      finish.release()
      await Promise.all([first, sibling])
    }
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await state()).leaseId).toBeNull()
  })

  it('accounts rolling budgets and spacing from receipt rather than enqueue time', async () => {
    const started = latch()
    const finish = latch()
    let receivedAt = 0
    execute.mockImplementationOnce(async () => {
      started.release()
      await finish.promise
      receivedAt = Date.now()
      return Response.json({ ok: true })
    })
    const first = remoteRequest()
    await started.promise
    const reservedAt = (await state()).requests[0]
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    finish.release()
    await first
    const completed = await state()
    const [event] = await databaseClient
      .select()
      .from(schema.providerRequestEvent)
    expect(reservedAt).toBeLessThan(receivedAt)
    expect(event?.requestedAt.getTime()).toBeGreaterThanOrEqual(receivedAt)
    expect(completed.requests).toEqual([event?.requestedAt.getTime()])
    expect(completed.nextAllowedAt?.getTime()).toBeGreaterThanOrEqual(
      receivedAt + 50,
    )
    execute.mockImplementationOnce(async () => {
      expect(Date.now()).toBeGreaterThanOrEqual(receivedAt + 50)
      return Response.json({ ok: true })
    })
    await remoteRequest()
  })

  it('does not let an hourly request age out before its receipt timestamp', async () => {
    const now = Date.now.bind(Date)
    let offset = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    const configuredPlugin: MediaProviderPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        rateLimit: { ...plugin.manifest.rateLimit, maxRequestsPerHour: 1 },
      },
    }
    execute.mockImplementationOnce(async () => {
      offset = 1000
      return Response.json({ ok: true })
    })
    await remoteRequest(configuredPlugin)
    offset = 3600100
    await expect(remoteRequest(configuredPlugin)).rejects.toMatchObject({
      code: 'cooldown',
      recorded: true,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toHaveLength(1)
  })

  it('retains receipt-time spacing even when receipt bookkeeping fails', async () => {
    let receivedAt = 0
    execute.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      receivedAt = Date.now()
      vi.spyOn(databaseClient, 'transaction').mockRejectedValueOnce(
        new Error('Receipt bookkeeping unavailable'),
      )
      return Response.json({ ok: true })
    })
    await expect(remoteRequest()).rejects.toMatchObject({
      code: 'request-failed',
      recorded: true,
    })
    expect((await state()).nextAllowedAt?.getTime()).toBeGreaterThanOrEqual(
      receivedAt + 50,
    )
  })

  it.each([
    { status: 429, code: 'rate-limit', blocked: 'cooldown' },
    { status: 403, code: 'access-denied', blocked: 'access-denied' },
  ])(
    'persists remote HTTP $status before allowing another attempt',
    async ({ status, code, blocked }) => {
      execute.mockResolvedValue(
        new Response(null, { status, headers: { 'retry-after': '7200' } }),
      )
      await expect(remoteRequest()).rejects.toMatchObject({
        code,
        recorded: true,
      })
      const saved = await state()
      expect(saved.failureCount).toBe(1)
      expect(saved.halted).toBe(status === 403)
      if (status === 429)
        expect(saved.cooldownUntil?.getTime()).toBeGreaterThan(
          Date.now() + 7190000,
        )
      await expect(remoteRequest()).rejects.toMatchObject({
        code: blocked,
        recorded: true,
      })
      expect(execute).toHaveBeenCalledOnce()
    },
  )

  it.each([429, 403])(
    'retains HTTP %s safety when receipt bookkeeping fails',
    async (status) => {
      execute.mockImplementation(async () => {
        vi.spyOn(databaseClient, 'transaction').mockRejectedValueOnce(
          new Error('Receipt bookkeeping unavailable'),
        )
        return new Response(null, {
          status,
          headers: { 'retry-after': '7200' },
        })
      })
      await expect(remoteRequest()).rejects.toMatchObject({
        code: status === 429 ? 'rate-limit' : 'access-denied',
        recorded: true,
      })
      await expect(remoteRequest()).rejects.toMatchObject({
        code: status === 429 ? 'cooldown' : 'access-denied',
      })
      expect(execute).toHaveBeenCalledOnce()
    },
  )

  it.each<Partial<MediaProviderPlugin['manifest']['rateLimit']>>([
    { concurrentRequests: true, maxConcurrent: 2 },
    { fixedWindow: { durationMs: 60000, reads: 10, writes: 1 } },
    { requestBudget: { period: 'day', limit: 100 } },
  ])(
    'rejects unsupported remote limits before reserving: %j',
    async (limits) => {
      const configuredPlugin: MediaProviderPlugin = {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          rateLimit: { ...plugin.manifest.rateLimit, ...limits },
        },
      }
      await expect(remoteRequest(configuredPlugin)).rejects.toMatchObject({
        code: 'request-failed',
        recorded: true,
      })
      expect(execute).not.toHaveBeenCalled()
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toEqual([])
    },
  )

  it('rejects a persisted daily budget override before sending remotely', async () => {
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      requestBudgetOverride: { period: 'day', limit: 100 },
    })
    const configuredPlugin: MediaProviderPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        rateLimit: {
          ...plugin.manifest.rateLimit,
          configurableRequestBudget: true,
        },
      },
    }
    await expect(remoteRequest(configuredPlugin)).rejects.toMatchObject({
      code: 'request-failed',
      recorded: true,
    })
    expect(execute).not.toHaveBeenCalled()
    expect((await state()).failureCount).toBe(0)
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toEqual([])
  })

  it('records an offline resolver error without charging provider failures or reserving', async () => {
    const { createProviderRequest, recordProviderFailure } =
      await import('@/services/provider-requests')
    await databaseClient
      .insert(schema.providerRequestState)
      .values({ provider: 'fixture', failureCount: 1 })
    const offline = new ProviderRequestError(
      'Local worker offline',
      'request-failed',
      null,
      true,
    )
    await expect(
      withProviderTransport(
        async () => {
          throw offline
        },
        () => createProviderRequest(plugin)(url),
      ),
    ).rejects.toBe(offline)
    await recordProviderFailure(plugin, offline)
    expect((await state()).failureCount).toBe(1)
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not charge a recorded remote infrastructure error as a provider failure', async () => {
    execute.mockRejectedValue(
      new ProviderRequestError(
        'Local worker interrupted',
        'request-failed',
        null,
        true,
      ),
    )
    await expect(remoteRequest()).rejects.toMatchObject({
      code: 'request-failed',
      recorded: true,
    })
    expect(await state()).toMatchObject({
      failureCount: 0,
      halted: false,
      cooldownUntil: null,
      leaseId: null,
    })
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toHaveLength(1)
  })
})

describe('late local worker safety evidence', () => {
  it.each([429, 403])(
    'persists a late HTTP %s after the original lease was released',
    async (status) => {
      const { protectProviderFromLocalResponse, recordProviderSuccess } =
        await import('@/services/provider-requests')
      await remoteRequest()
      expect((await state()).leaseId).toBeNull()
      await protectProviderFromLocalResponse(
        plugin,
        status,
        new Headers({ 'retry-after': '7200' }),
        '',
      )
      await recordProviderSuccess('fixture')
      expect((await state()).failureCount).toBe(0)
      await expect(remoteRequest()).rejects.toMatchObject({
        code: status === 429 ? 'cooldown' : 'access-denied',
      })
      expect(execute).toHaveBeenCalledOnce()
    },
  )

  it('never shortens a cooldown or clears an access halt on later evidence', async () => {
    const { protectProviderFromLocalResponse } =
      await import('@/services/provider-requests')
    const until = new Date(Date.now() + 10800000)
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      halted: true,
      cooldownUntil: until,
      failureCount: 1,
    })
    await protectProviderFromLocalResponse(
      plugin,
      429,
      new Headers({ 'retry-after': '60' }),
      '',
    )
    await protectProviderFromLocalResponse(plugin, 200, new Headers(), '{}')
    expect(await state()).toMatchObject({
      halted: true,
      cooldownUntil: until,
      failureCount: 1,
    })
  })

  it('persists quota evidence in a late successful JSON response without counting a failure', async () => {
    const { protectProviderFromLocalResponse } =
      await import('@/services/provider-requests')
    await protectProviderFromLocalResponse(
      plugin,
      200,
      new Headers({ 'content-type': 'application/json' }),
      JSON.stringify({ Response: 'False', Error: 'Request limit reached!' }),
    )
    expect((await state()).cooldownUntil?.getTime()).toBeGreaterThan(Date.now())
    expect((await state()).failureCount).toBe(0)
    await expect(remoteRequest()).rejects.toMatchObject({ code: 'cooldown' })
    expect(execute).not.toHaveBeenCalled()
  })
})
