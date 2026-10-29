import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { ProviderItemNotFoundError as BuiltItemNotFoundError } from '../../../packages/media-plugin-sdk/dist/index.js'
import {
  CreateJobSchema,
  JobErrorDetailsSchema,
  JobSchema,
} from '@repo/schemas/job'
import { env } from '@/env'
import { encryptSecretValue } from '@/lib/crypto'
import * as schema from '@/schemas/db'
import { mdblistPlugin } from '@/plugins/builtin/mdblist'

const database = `media_request_test_${randomUUID().replaceAll('-', '')}`
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
const plugin: MediaProviderPlugin &
  Required<Pick<MediaProviderPlugin, 'scrapeMediaItem'>> = {
  manifest: {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 30,
      maxRequestsPerHour: 140,
      rateLimitCooldownMs: 3600000,
    },
  },
  async scrapeMediaItem({ request }) {
    const response = await request('https://fixture.invalid/metadata')
    return PluginResultSchema.parse({
      payload: await response.json(),
      normalized: {},
    })
  },
}
const quotaPlugin: MediaProviderPlugin = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    rateLimit: {
      ...mdblistPlugin.manifest.rateLimit,
      concurrentRequests: false,
      minTimeMs: 0,
    },
  },
}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async () => plugin,
  listProviderCatalog: async () => [
    {
      ...plugin.manifest,
      surface: 'provider',
      supportsScrape: true,
      supportsLegacyImport: false,
      pluginPath: null,
    },
    {
      ...quotaPlugin.manifest,
      id: 'quota-fixture',
      surface: 'provider',
      supportsScrape: true,
      supportsLegacyImport: false,
      pluginPath: null,
    },
  ],
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
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.delete(schema.providerCooldownReset)
  await databaseClient.delete(schema.providerRequestState)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => {
    throw new Error('Unexpected network attempt')
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function createFixtureJobs(mediaItemIds: string[]) {
  const { createJob } = await import('@/services/jobs')
  const jobs = []
  for (const mediaItemId of mediaItemIds)
    jobs.push(
      await createJob(
        CreateJobSchema.parse({
          provider: plugin.manifest.id,
          scope: { mediaItemIds: [mediaItemId] },
        }),
        null,
      ),
    )
  return jobs
}

describe('provider request timeout configuration', () => {
  it.each([
    { concurrentRequests: false, timeoutMs: undefined, expected: 15000 },
    { concurrentRequests: true, timeoutMs: undefined, expected: 15000 },
    { concurrentRequests: false, timeoutMs: 60000, expected: 60000 },
    { concurrentRequests: true, timeoutMs: 180000, expected: 180000 },
  ])(
    'covers the request with a durable lease ($concurrentRequests, $expected ms)',
    async ({ concurrentRequests, timeoutMs, expected }) => {
      const { createProviderRequest } =
        await import('@/services/provider-requests')
      const timeout = vi.spyOn(AbortSignal, 'timeout')
      const configuredPlugin: MediaProviderPlugin = {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          rateLimit: { ...plugin.manifest.rateLimit, concurrentRequests },
        },
      }
      fetchMock.mockImplementation(async () => {
        const [state] = await databaseClient
          .select()
          .from(schema.providerRequestState)
        const [event] = await databaseClient
          .select()
          .from(schema.providerRequestEvent)
        if (!state || !event)
          throw new Error('Missing in-flight request reservation')
        const expiresAt = event.requestedAt.getTime() + expected + 5000
        if (concurrentRequests) {
          expect(state.leaseUntil).toBeNull()
          expect(state.requestLeases).toEqual([{ id: event.id, expiresAt }])
        } else {
          expect(state.leaseId).toBe(event.id)
          expect(state.leaseUntil?.getTime()).toBe(expiresAt)
        }
        return Response.json({ ok: true })
      })
      try {
        await createProviderRequest(configuredPlugin, undefined, { timeoutMs })(
          'https://fixture.invalid',
        )
        expect(timeout).toHaveBeenCalledWith(expected)
        const [state] = await databaseClient
          .select()
          .from(schema.providerRequestState)
        expect(state).toMatchObject({
          leaseId: null,
          leaseUntil: null,
          requestLeases: [],
        })
      } finally {
        timeout.mockRestore()
      }
    },
  )

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 180001])(
    'rejects invalid timeout %s before reserving or checking active work',
    async (timeoutMs) => {
      const { createProviderRequest } =
        await import('@/services/provider-requests')
      const assertActive = vi.fn(async () => {})
      expect(() =>
        createProviderRequest(plugin, assertActive, { timeoutMs }),
      ).toThrow()
      expect(assertActive).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(
        await databaseClient.select().from(schema.providerRequestState),
      ).toEqual([])
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toEqual([])
    },
  )

  it('aborts at the configured timeout and releases the lease without retrying', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('Missing request cancellation signal')
      signal.throwIfAborted()
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    })
    await expect(
      createProviderRequest(plugin, undefined, { timeoutMs: 20 })(
        'https://fixture.invalid',
      ),
    ).rejects.toMatchObject({ code: 'request-failed', recorded: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.reason).toMatchObject({
      name: 'TimeoutError',
    })
    const [state] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(state).toMatchObject({
      leaseId: null,
      leaseUntil: null,
      requestLeases: [],
    })
    expect((await getProviderSafety('fixture')).consecutiveFailures).toBe(1)
  })

  it('preserves caller cancellation with a longer configured timeout', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const caller = new AbortController()
    const reason = new Error('Fixture caller cancelled')
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('Missing request cancellation signal')
      const pending = new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
      caller.abort(reason)
      return pending
    })
    await expect(
      createProviderRequest(plugin, undefined, { timeoutMs: 180000 })(
        'https://fixture.invalid',
        { signal: caller.signal },
      ),
    ).rejects.toMatchObject({ code: 'request-failed', recorded: true })
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.reason).toBe(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [state] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(state).toMatchObject({
      leaseId: null,
      leaseUntil: null,
      requestLeases: [],
    })
  })
})

describe('structured HTTP quota handling', () => {
  it.each([
    'dailyLimitExceeded',
    'rateLimitExceeded',
    'userRateLimitExceeded',
    'quotaExceeded',
  ])(
    'persists HTTP 403 %s as cooldown without an access halt',
    async (reason) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      const startedAt = Date.now()
      fetchMock.mockResolvedValue(
        Response.json(
          {
            error: {
              code: 403,
              errors: [
                {
                  domain: 'usageLimits',
                  reason,
                  message: 'Sensitive upstream details',
                },
              ],
            },
          },
          { status: 403, headers: { 'Retry-After': '7200' } },
        ),
      )
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'rate-limit', recorded: true })
      const state = await getProviderSafety('fixture')
      expect(state.halted).toBe(false)
      expect(Date.parse(state.cooldownUntil ?? '')).toBeGreaterThanOrEqual(
        startedAt + 7200000,
      )
      expect(state.consecutiveFailures).toBe(1)
      expect(state.lastError).toBe('Provider rate limit reached')
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'cooldown', recorded: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toHaveLength(1)
    },
  )

  const quotaBody = JSON.stringify({
    error: { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] },
  })
  it.each([
    {
      name: 'ordinary denial',
      body: JSON.stringify({
        error: { code: 403, errors: [{ reason: 'forbidden' }] },
      }),
      contentType: 'application/json',
    },
    {
      name: 'quota words without a structured reason',
      body: JSON.stringify({ message: 'Quota access denied' }),
      contentType: 'application/json',
    },
    { name: 'malformed JSON', body: '{bad', contentType: 'application/json' },
    {
      name: 'malformed reason shape',
      body: JSON.stringify({ error: { errors: [{ reason: 29 }] } }),
      contentType: 'application/json',
    },
    {
      name: 'unrecognized reason',
      body: JSON.stringify({
        error: { errors: [{ reason: 'dailyLimitExceededButForbidden' }] },
      }),
      contentType: 'application/json',
    },
    {
      name: 'non-JSON content type',
      body: quotaBody,
      contentType: 'text/plain',
    },
    {
      name: 'oversized streamed body',
      body: quotaBody + ' '.repeat(16384),
      contentType: 'application/json',
    },
    {
      name: 'oversized declared body',
      body: quotaBody,
      contentType: 'application/json',
      contentLength: '16385',
    },
  ])(
    'retains an access halt for $name',
    async ({ body, contentType, ...rest }) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      const headers = new Headers({ 'content-type': contentType })
      if (rest.contentLength) headers.set('content-length', rest.contentLength)
      fetchMock.mockResolvedValue(new Response(body, { status: 403, headers }))
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'access-denied', recorded: true })
      expect(await getProviderSafety('fixture')).toMatchObject({
        halted: true,
        cooldownUntil: null,
        consecutiveFailures: 1,
      })
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'access-denied' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('retains an access halt when a JSON 403 body cannot be read', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('Unreadable error body'))
      },
    })
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'access-denied', recorded: true })
    expect((await getProviderSafety('fixture')).halted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not reinterpret HTTP 401 even when the JSON body names a quota', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    fetchMock.mockResolvedValue(
      new Response(quotaBody, {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'access-denied' })
    expect((await getProviderSafety('fixture')).halted).toBe(true)
  })

  it('retains HTTP 429 headers when cancelling its unread body rejects', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    const startedAt = Date.now()
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error('Cancellation failed')
      },
    })
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 429,
        headers: {
          'retry-after': '7200',
          'content-length': '99999999',
          'content-type': 'application/json',
        },
      }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit', recorded: true })
    const state = await getProviderSafety('fixture')
    expect(state.halted).toBe(false)
    expect(Date.parse(state.cooldownUntil ?? '')).toBeGreaterThanOrEqual(
      startedAt + 7200000,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('recognizes structured quota reasons in HTTP 200 without changing legacy message handling', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    fetchMock.mockResolvedValue(
      new Response(quotaBody, {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit', recorded: true })
    const state = await getProviderSafety('fixture')
    expect(state.halted).toBe(false)
    expect(state.cooldownUntil).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors a later opted-in reset on HTTP 403 quota responses', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    const resetAt = Math.ceil(Date.now() / 1000) * 1000 + 10800000
    fetchMock.mockResolvedValue(
      new Response(quotaBody, {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'retry-after': '7200',
          'x-ratelimit-limit': '10000',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetAt / 1000),
        },
      }),
    )
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({
      code: 'rate-limit',
      retryAt: resetAt,
      recorded: true,
    })
    expect(await getProviderSafety('fixture')).toMatchObject({
      halted: false,
      cooldownUntil: new Date(resetAt).toISOString(),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('configurable request budgets', () => {
  const now = Date.parse('2026-10-27T18:00:00Z')
  const midnight = Date.parse('2026-10-27T00:00:00Z')
  const tomorrow = Date.parse('2026-10-28T00:00:00Z')
  const budgetPlugin: MediaProviderPlugin = {
    ...quotaPlugin,
    manifest: { ...quotaPlugin.manifest, id: 'quota-fixture' },
  }
  async function events(times: number[]) {
    if (times.length)
      await databaseClient.insert(schema.providerRequestEvent).values(
        times.map((time) => ({
          id: randomUUID(),
          provider: 'quota-fixture',
          requestedAt: new Date(time),
        })),
      )
  }

  it('defaults to 10000/day without a forced hourly limit and counts earlier attempts', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { createProviderRequest, getProviderBudgetStatus } =
        await import('@/services/provider-requests')
      await events(Array.from({ length: 50 }, (_, index) => now - index - 1))
      await events([midnight, midnight - 1, now - 7200000])
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      await createProviderRequest(budgetPlugin)('https://fixture.invalid')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        await getProviderBudgetStatus(
          'quota-fixture',
          budgetPlugin.manifest.rateLimit,
        ),
      ).toEqual({
        budget: { period: 'day', limit: 10000 },
        used: 53,
        resetsAt: new Date(tomorrow).toISOString(),
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('blocks at the daily cap, including attempts older than one hour, then resets exactly at UTC midnight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { updateProviderBudget } = await import('@/services/providers')
      const { createProviderRequest } =
        await import('@/services/provider-requests')
      await updateProviderBudget(
        'quota-fixture',
        { period: 'day', limit: 2 },
        null,
      )
      await events([midnight, now - 7200000])
      await expect(
        createProviderRequest(budgetPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'cooldown', retryAt: tomorrow })
      expect(fetchMock).not.toHaveBeenCalled()
      clock.mockReturnValue(tomorrow)
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      await createProviderRequest(budgetPlugin)('https://fixture.invalid')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('persists mode changes without resetting usage, preserves hard policies and serializes the last allowance', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { updateProviderBudget } = await import('@/services/providers')
      const { createProviderRequest, getProviderBudgetStatus } =
        await import('@/services/provider-requests')
      await expect(
        updateProviderBudget('fixture', { period: 'day', limit: 1000 }, null),
      ).rejects.toThrow(/fixed request limits/)
      await expect(
        updateProviderBudget('missing', { period: 'day', limit: 1000 }, null),
      ).rejects.toThrow(/not found/)
      await events([now - 7200000, now - 1000])
      expect(
        await updateProviderBudget(
          'quota-fixture',
          { period: 'hour', limit: 1 },
          null,
        ),
      ).toMatchObject({ used: 1, budget: { period: 'hour', limit: 1 } })
      await expect(
        createProviderRequest(budgetPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({
        code: 'cooldown',
        retryAt: now - 1000 + 3600000,
      })
      expect(
        await updateProviderBudget(
          'quota-fixture',
          { period: 'day', limit: 3 },
          null,
        ),
      ).toMatchObject({ used: 2 })
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      const results = await Promise.allSettled([
        createProviderRequest(budgetPlugin)('https://fixture.invalid'),
        createProviderRequest(budgetPlugin)('https://fixture.invalid'),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        await getProviderBudgetStatus(
          'quota-fixture',
          budgetPlugin.manifest.rateLimit,
        ),
      ).toMatchObject({ used: 3, budget: { period: 'day', limit: 3 } })
    } finally {
      clock.mockRestore()
    }
  })

  it('does not let budget updates erase quota headers, cooldowns, access halts or pacing', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { updateProviderBudget } = await import('@/services/providers')
      const { createProviderRequest, recordProviderSuccess } =
        await import('@/services/provider-requests')
      const spacedPlugin = {
        ...budgetPlugin,
        manifest: {
          ...budgetPlugin.manifest,
          rateLimit: { ...budgetPlugin.manifest.rateLimit, minTimeMs: 2000 },
        },
      }
      fetchMock.mockImplementation(async () =>
        Response.json(
          { ok: true },
          {
            headers: {
              'X-RateLimit-Limit': '1000',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(tomorrow / 1000),
            },
          },
        ),
      )
      await createProviderRequest(spacedPlugin)('https://fixture.invalid')
      await updateProviderBudget(
        'quota-fixture',
        { period: 'day', limit: 2000 },
        null,
      )
      await recordProviderSuccess('quota-fixture')
      await expect(
        createProviderRequest(spacedPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'cooldown', retryAt: tomorrow })
      const state = await databaseClient.query.providerRequestState.findFirst({
        where: (table, operators) =>
          operators.eq(table.provider, 'quota-fixture'),
      })
      expect(state?.nextAllowedAt?.getTime()).toBe(now + 2000)
      expect(state?.cooldownUntil?.getTime()).toBe(tomorrow)
      await databaseClient
        .update(schema.providerRequestState)
        .set({ halted: true })
      await updateProviderBudget(
        'quota-fixture',
        { period: 'hour', limit: 50 },
        null,
      )
      await expect(
        createProviderRequest(spacedPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'access-denied' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('ignores overrides for non-configurable providers and rejects corrupt opted-in overrides', async () => {
    const { effectiveRequestBudget } =
      await import('@/services/provider-requests')
    expect(
      effectiveRequestBudget(plugin.manifest.rateLimit, {
        period: 'day',
        limit: 99999,
      }),
    ).toBeUndefined()
    expect(() =>
      effectiveRequestBudget(budgetPlugin.manifest.rateLimit, {
        period: 'day',
        limit: -1,
      }),
    ).toThrow()
  })

  it('clears only an obsolete local hourly wait when switching to daily', async () => {
    const { updateProviderBudget } = await import('@/services/providers')
    const until = new Date(Date.now() + 3600000)
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'quota-fixture',
      cooldownUntil: until,
      lastError: 'Hourly request budget exhausted',
      requests: [Date.now()],
    })
    await updateProviderBudget(
      'quota-fixture',
      { period: 'day', limit: 1000 },
      null,
    )
    let state = await databaseClient.query.providerRequestState.findFirst({
      where: (table, operators) =>
        operators.eq(table.provider, 'quota-fixture'),
    })
    expect(state?.cooldownUntil).toBeNull()
    expect(state?.requests).toHaveLength(1)
    for (const lastError of [
      'Provider rate limit reached',
      'Provider response quota exhausted',
      'Provider execution failed',
    ]) {
      await databaseClient
        .update(schema.providerRequestState)
        .set({ cooldownUntil: until, lastError })
      await updateProviderBudget(
        'quota-fixture',
        { period: 'day', limit: 2000 },
        null,
      )
      state = await databaseClient.query.providerRequestState.findFirst({
        where: (table, operators) =>
          operators.eq(table.provider, 'quota-fixture'),
      })
      expect(state?.cooldownUntil).toEqual(until)
      expect(state?.lastError).toBe(lastError)
    }
  })
})

describe('opt-in HTTP lookup misses', () => {
  it.each([
    { concurrentRequests: false, failureCount: 0 },
    { concurrentRequests: false, failureCount: 1 },
    { concurrentRequests: true, failureCount: 0 },
    { concurrentRequests: true, failureCount: 1 },
  ])(
    'releases leases without changing failures or adding cooldowns (concurrent: $concurrentRequests, failures: $failureCount)',
    async ({ concurrentRequests, failureCount }) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      const lookupPlugin: MediaProviderPlugin = {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          rateLimit: {
            ...plugin.manifest.rateLimit,
            concurrentRequests,
            maxConcurrent: concurrentRequests ? 3 : 1,
          },
        },
      }
      const lastError = failureCount ? 'Previous genuine failure' : null
      await databaseClient.insert(schema.providerRequestState).values({
        provider: 'fixture',
        failureCount,
        lastError,
      })
      fetchMock.mockImplementation(
        async () => new Response('Not found', { status: 404 }),
      )
      for (let count = 1; count <= 3; count++) {
        await expect(
          createProviderRequest(lookupPlugin)(
            'https://fixture.invalid/metadata',
            undefined,
            { notFoundOn404: true },
          ),
        ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
        expect(await getProviderSafety('fixture')).toMatchObject({
          halted: false,
          cooldownUntil: null,
          consecutiveFailures: failureCount,
          lastError,
          requestsLastHour: count,
        })
        expect(
          await databaseClient.query.providerRequestState.findFirst(),
        ).toMatchObject({
          leaseId: null,
          leaseUntil: null,
          requestLeases: [],
        })
        expect(fetchMock).toHaveBeenCalledTimes(count)
      }
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true }))
      const response = await createProviderRequest(lookupPlugin)(
        'https://fixture.invalid/metadata',
        undefined,
        { notFoundOn404: true },
      )
      expect(await response.json()).toEqual({ ok: true })
      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toHaveLength(4)
    },
  )

  it.each([undefined, { notFoundOn404: false }])(
    'counts HTTP 404 as a generic failure without opt-in: %j',
    async (options) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      fetchMock.mockImplementation(
        async () => new Response('Not found', { status: 404 }),
      )
      for (let count = 1; count <= 2; count++) {
        await expect(
          createProviderRequest(plugin)(
            'https://fixture.invalid/metadata',
            undefined,
            options,
          ),
        ).rejects.toMatchObject({ code: 'request-failed', recorded: true })
        expect((await getProviderSafety('fixture')).consecutiveFailures).toBe(
          count,
        )
      }
      expect((await getProviderSafety('fixture')).cooldownUntil).not.toBeNull()
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid/metadata'),
      ).rejects.toMatchObject({ code: 'cooldown', recorded: true })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    { status: 401, code: 'access-denied', halted: true },
    { status: 403, code: 'access-denied', halted: true },
    { status: 429, code: 'rate-limit', halted: false },
    { status: 500, code: 'request-failed', halted: false },
  ])(
    'retains HTTP $status safety when lookup misses are opted in',
    async ({ status, code, halted }) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      const startedAt = Date.now()
      fetchMock.mockResolvedValue(
        new Response('Failure', {
          status,
          headers: { 'Retry-After': '7200' },
        }),
      )
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid', undefined, {
          notFoundOn404: true,
        }),
      ).rejects.toMatchObject({ code, recorded: true })
      const state = await getProviderSafety('fixture')
      expect(state).toMatchObject({ halted, consecutiveFailures: 1 })
      if (halted) expect(state.cooldownUntil).toBeNull()
      else
        expect(Date.parse(state.cooldownUntil ?? '')).toBeGreaterThanOrEqual(
          startedAt + 7200000,
        )
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid', undefined, {
          notFoundOn404: true,
        }),
      ).rejects.toMatchObject({
        code: halted ? 'access-denied' : 'cooldown',
        recorded: true,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        await databaseClient.query.providerRequestState.findFirst(),
      ).toMatchObject({
        leaseId: null,
        leaseUntil: null,
        requestLeases: [],
      })
    },
  )
})

describe('persistent provider request safety', () => {
  it('preserves shared start spacing with concurrent requests', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const concurrentPlugin: MediaProviderPlugin = {
      ...quotaPlugin,
      manifest: {
        ...quotaPlugin.manifest,
        rateLimit: {
          ...quotaPlugin.manifest.rateLimit,
          concurrentRequests: true,
          maxConcurrent: 3,
          minTimeMs: 100,
        },
      },
    }
    const starts: number[] = []
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 400))
      return Response.json({ ok: true })
    })
    await Promise.all(
      Array.from({ length: 4 }, () =>
        createProviderRequest(concurrentPlugin)('https://fixture.invalid'),
      ),
    )
    for (const [index, start] of starts.entries()) {
      const previous = starts[index - 1]
      if (previous !== undefined)
        expect(start - previous).toBeGreaterThanOrEqual(90)
    }
    expect(starts).toHaveLength(4)
  })
  it('refuses cooldown clearing while a concurrent request lease is active', async () => {
    const { clearProviderCooldown } =
      await import('@/services/provider-activity')
    const until = new Date(Date.now() + 60000)
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      cooldownUntil: until,
      requestLeases: [{ id: 'active', expiresAt: Date.now() + 20000 }],
    })
    await expect(
      clearProviderCooldown('fixture', until.toISOString(), null),
    ).rejects.toThrow(/Provider state changed/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('shares independent fixed-window read/write caps and resets on the five-minute boundary', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const now = Date.parse('2026-10-28T12:04:59Z')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const windowPlugin: MediaProviderPlugin = {
      ...quotaPlugin,
      manifest: {
        ...quotaPlugin.manifest,
        rateLimit: {
          ...quotaPlugin.manifest.rateLimit,
          concurrentRequests: true,
          maxConcurrent: 3,
          fixedWindow: { durationMs: 300000, reads: 2, writes: 1 },
        },
      },
    }
    try {
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      await databaseClient.insert(schema.providerRequestEvent).values({
        id: randomUUID(),
        provider: 'fixture',
        requestedAt: new Date('2026-10-28T11:59:59.999Z'),
        requestClass: 'read',
      })
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          createProviderRequest(windowPlugin)('https://fixture.invalid'),
        ),
      )
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(2)
      await createProviderRequest(windowPlugin)('https://fixture.invalid', {
        method: 'POST',
      })
      await expect(
        createProviderRequest(windowPlugin)('https://fixture.invalid', {
          method: 'POST',
        }),
      ).rejects.toMatchObject({
        code: 'cooldown',
        retryAt: Date.parse('2026-10-28T12:05:00Z'),
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      clock.mockReturnValue(Date.parse('2026-10-28T12:05:00Z'))
      await createProviderRequest(windowPlugin)('https://fixture.invalid')
      await createProviderRequest(windowPlugin)('https://fixture.invalid', {
        method: 'POST',
      })
      expect(fetchMock).toHaveBeenCalledTimes(5)
    } finally {
      clock.mockRestore()
    }
  })
  it('does not overspend the final daily allowances with concurrent clients', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const concurrentPlugin: MediaProviderPlugin = {
      ...quotaPlugin,
      manifest: {
        ...quotaPlugin.manifest,
        rateLimit: {
          ...quotaPlugin.manifest.rateLimit,
          concurrentRequests: true,
          maxConcurrent: 3,
        },
      },
    }
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      requestBudgetOverride: { period: 'day', limit: 2 },
      requestLeases: [{ id: 'expired', expiresAt: Date.now() - 1 }],
    })
    fetchMock.mockImplementation(async () => Response.json({ ok: true }))
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createProviderRequest(concurrentPlugin)('https://fixture.invalid'),
      ),
    )
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const state = await databaseClient.query.providerRequestState.findFirst()
    expect(state?.requestLeases).toEqual([])
  })
  it('stops waiting concurrent requests after a 429 without discarding in-flight responses', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const concurrentPlugin: MediaProviderPlugin = {
      ...quotaPlugin,
      manifest: {
        ...quotaPlugin.manifest,
        rateLimit: {
          ...quotaPlugin.manifest.rateLimit,
          concurrentRequests: true,
          maxConcurrent: 3,
        },
      },
    }
    let release = (): void => {
      throw new Error('Request gate not initialized')
    }
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requests = 0
    fetchMock.mockImplementation(async () => {
      const first = requests++ === 0
      await gate
      if (first)
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '120' },
        })
      await new Promise((resolve) => setTimeout(resolve, 100))
      return Response.json({ ok: true })
    })
    const pending = Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createProviderRequest(concurrentPlugin)('https://fixture.invalid'),
      ),
    )
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    } finally {
      release()
    }
    const results = await pending
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('allows exactly three overlapping requests when concurrency is enabled', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const concurrentPlugin: MediaProviderPlugin = {
      ...quotaPlugin,
      manifest: {
        ...quotaPlugin.manifest,
        rateLimit: {
          ...quotaPlugin.manifest.rateLimit,
          concurrentRequests: true,
          maxConcurrent: 3,
        },
      },
    }
    let active = 0
    let peak = 0
    fetchMock.mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 100))
      active--
      return Response.json({ ok: true })
    })
    await Promise.all(
      Array.from({ length: 6 }, () =>
        createProviderRequest(concurrentPlugin)('https://fixture.invalid'),
      ),
    )
    expect(peak).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
  it('does not turn repeated scheduled MDBList throttles into a fifteen-minute penalty', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      failureCount: 1,
    })
    const now = Date.now()
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'API rate limit exceeded!' },
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    )
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit' })
    const safety = await getProviderSafety('fixture')
    expect(safety.halted).toBe(false)
    expect(Date.parse(safety.cooldownUntil ?? '')).toBeLessThan(now + 125000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('uses the five-minute Retry-After rather than daily reset when MDBList still has daily allowance', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    const now = Date.now()
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'API rate limit exceeded!' },
        {
          status: 429,
          headers: {
            'Retry-After': '120',
            'X-RateLimit-Limit': '10000',
            'X-RateLimit-Remaining': '9000',
            'X-RateLimit-Reset': String(Math.floor(now / 1000) + 7200),
          },
        },
      ),
    )
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit' })
    const until = Date.parse(
      (await getProviderSafety('fixture')).cooldownUntil ?? '',
    )
    expect(until).toBeGreaterThanOrEqual(now + 120000)
    expect(until).toBeLessThan(now + 125000)
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'cooldown' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('keeps the last successful quota response but blocks subsequent requests until reset', async () => {
    const { createProviderRequest, recordProviderSuccess, getProviderSafety } =
      await import('@/services/provider-requests')
    const reset = Math.floor(Date.now() / 1000) + 7200
    fetchMock.mockResolvedValue(
      Response.json(
        { keywords: [] },
        {
          headers: {
            'X-RateLimit-Limit': '1000',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(reset),
          },
        },
      ),
    )
    const response = await createProviderRequest(quotaPlugin)(
      'https://fixture.invalid',
    )
    expect(await response.json()).toEqual({ keywords: [] })
    await recordProviderSuccess('fixture')
    expect(await getProviderSafety('fixture')).toMatchObject({
      cooldownUntil: new Date(reset * 1000).toISOString(),
      consecutiveFailures: 0,
      lastError: 'Provider response quota exhausted',
    })
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'cooldown', retryAt: reset * 1000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not apply quota response headers to a provider without opt-in', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    fetchMock.mockImplementation(async () =>
      Response.json(
        {},
        {
          headers: {
            'X-RateLimit-Limit': '1000',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 7200),
          },
        },
      ),
    )
    await createProviderRequest(plugin)('https://fixture.invalid')
    await createProviderRequest(plugin)('https://fixture.invalid')
    expect((await getProviderSafety('fixture')).cooldownUntil).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['60', 7200],
    ['10800', 7200],
    [null, 60],
  ])(
    'preserves minimum-cooldown policy for other providers (%s, %s)',
    async (retryAfter, resetSeconds) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      const now = Date.now()
      const reset = Math.floor(now / 1000) + resetSeconds
      const headers = new Headers({ 'X-RateLimit-Reset': String(reset) })
      if (retryAfter !== null) headers.set('Retry-After', retryAfter)
      fetchMock.mockResolvedValue(
        new Response('Limited', { status: 429, headers }),
      )
      const minimumCooldownPlugin: MediaProviderPlugin = {
        ...quotaPlugin,
        manifest: {
          ...quotaPlugin.manifest,
          rateLimit: {
            ...quotaPlugin.manifest.rateLimit,
            retryAfterIsAuthoritative: false,
            rateLimitCooldownMs: 3600000,
          },
        },
      }
      await expect(
        createProviderRequest(minimumCooldownPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'rate-limit' })
      const until = Date.parse(
        (await getProviderSafety('fixture')).cooldownUntil ?? '',
      )
      const expected = Math.max(
        reset * 1000,
        now + 3600000,
        now + Number(retryAfter) * 1000,
      )
      expect(until).toBeGreaterThanOrEqual(expected)
      expect(until).toBeLessThan(expected + 5000)
      await expect(
        createProviderRequest(quotaPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'cooldown' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
  it('blocks a concurrent client after the last available response', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return Response.json(
        {},
        {
          headers: {
            'X-RateLimit-Limit': '1000',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 7200),
          },
        },
      )
    })
    const results = await Promise.allSettled([
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('retains quota exhaustion even when a successful HTTP body cannot be read', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    const reset = Math.floor(Date.now() / 1000) + 7200
    fetchMock.mockResolvedValue(
      new Response('', {
        headers: {
          'content-length': String(20 * 1024 * 1024),
          'X-RateLimit-Limit': '1000',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(reset),
        },
      }),
    )
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toThrow()
    expect((await getProviderSafety('fixture')).cooldownUntil).toBe(
      new Date(reset * 1000).toISOString(),
    )
    await expect(
      createProviderRequest(quotaPlugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'cooldown' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])(
    'preserves a concurrent access halt or longer cooldown (halted=%s)',
    async (halted) => {
      const {
        createProviderRequest,
        recordProviderSuccess,
        getProviderSafety,
      } = await import('@/services/provider-requests')
      const longer = new Date(Date.now() + 10800000)
      fetchMock.mockImplementation(async () => {
        await databaseClient.update(schema.providerRequestState).set({
          halted,
          cooldownUntil: halted ? null : longer,
          lastError: 'Existing safety reason',
          failureCount: 2,
        })
        return Response.json(
          {},
          {
            headers: {
              'X-RateLimit-Limit': '1000',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 7200),
            },
          },
        )
      })
      await createProviderRequest(quotaPlugin)('https://fixture.invalid')
      await recordProviderSuccess('fixture')
      const safety = await getProviderSafety('fixture')
      expect(safety).toMatchObject({
        halted,
        lastError: 'Existing safety reason',
      })
      if (halted) expect(safety.consecutiveFailures).toBe(2)
      else expect(safety.cooldownUntil).toBe(longer.toISOString())
      await expect(
        createProviderRequest(quotaPlugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: halted ? 'access-denied' : 'cooldown' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
  it('allows a new request after an expired quota cooldown without resetting request history', async () => {
    const { createProviderRequest, recordProviderSuccess, getProviderSafety } =
      await import('@/services/provider-requests')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      cooldownUntil: new Date(Date.now() - 1000),
      lastError: 'Provider response quota exhausted',
      requests: [Date.now() - 2000],
    })
    fetchMock.mockResolvedValue(
      Response.json(
        {},
        {
          headers: {
            'X-RateLimit-Limit': '1000',
            'X-RateLimit-Remaining': '999',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 7200),
          },
        },
      ),
    )
    await createProviderRequest(quotaPlugin)('https://fixture.invalid')
    await recordProviderSuccess('fixture')
    expect(await getProviderSafety('fixture')).toMatchObject({
      cooldownUntil: null,
      lastError: null,
      requestsLastHour: 2,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('retains request history beyond the rolling budget and fills empty chart buckets', async () => {
    const { getProviderActivity } = await import('@/services/provider-activity')
    const now = Date.now()
    await databaseClient.insert(schema.providerRequestEvent).values([
      {
        id: 'history-recent',
        provider: 'fixture',
        requestedAt: new Date(now - 30000),
      },
      {
        id: 'history-earlier',
        provider: 'fixture',
        requestedAt: new Date(now - 2 * 3600000),
      },
      {
        id: 'history-old',
        provider: 'fixture',
        requestedAt: new Date(now - 48 * 3600000),
      },
      {
        id: 'history-other',
        provider: 'other',
        requestedAt: new Date(now - 30000),
      },
    ])
    expect(await getProviderActivity('fixture', '1h')).toMatchObject({
      total: 1,
      bucketMs: 60000,
    })
    const day = await getProviderActivity('fixture', '24h')
    expect(day.total).toBe(2)
    expect(day.buckets).toHaveLength(24)
    expect(
      day.buckets.filter((bucket) => bucket.count === 0).length,
    ).toBeGreaterThan(20)
    expect((await getProviderActivity('fixture', '7d')).total).toBe(3)
    await expect(getProviderActivity('missing', '1h')).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('clears only a confirmed cooldown and audits it without resetting limits or access blocks', async () => {
    const { clearProviderCooldown, getProviderActivity } =
      await import('@/services/provider-activity')
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const cooldownUntil = new Date(Date.now() + 3600000)
    const nextAllowedAt = new Date(Date.now() + 25000)
    const requests = Array.from({ length: 140 }, () => Date.now() - 1000)
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      cooldownUntil,
      nextAllowedAt,
      requests,
      failureCount: 2,
      halted: true,
    })
    await expect(
      clearProviderCooldown('fixture', new Date(0).toISOString(), null),
    ).rejects.toMatchObject({ statusCode: 409 })
    const cleared = await clearProviderCooldown(
      'fixture',
      cooldownUntil.toISOString(),
      null,
    )
    expect(cleared).toMatchObject({
      cooldownUntil: null,
      halted: true,
      requestsLastHour: 140,
      consecutiveFailures: 2,
    })
    const state = await databaseClient.query.providerRequestState.findFirst()
    expect(state?.nextAllowedAt).toEqual(nextAllowedAt)
    expect(state?.requests).toEqual(requests)
    expect(
      (await getProviderActivity('fixture', '1h')).cooldownResets,
    ).toHaveLength(1)
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'access-denied' })
    // Even after a separate access-halt change, the hourly cap remains enforced.
    await databaseClient
      .update(schema.providerRequestState)
      .set({ halted: false })
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'cooldown' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects clearing a cooldown while a provider request is in flight', async () => {
    const { clearProviderCooldown } =
      await import('@/services/provider-activity')
    const cooldownUntil = new Date(Date.now() + 3600000)
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      cooldownUntil,
      leaseUntil: new Date(Date.now() + 20000),
      leaseId: 'active-request',
    })
    await expect(
      clearProviderCooldown('fixture', cooldownUntil.toISOString(), null),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(
      await databaseClient.select().from(schema.providerCooldownReset),
    ).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['http', 'json'])(
    'retains real rate-limit cooldowns with generic penalties disabled (%s)',
    async (kind) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      plugin.manifest.rateLimit.failureCooldownMs = 0
      plugin.manifest.rateLimit.errorBackoffMs = 0
      fetchMock.mockResolvedValue(
        kind === 'http'
          ? new Response('Limited', { status: 429 })
          : Response.json({ Message: 'Too many requests' }),
      )
      try {
        await expect(
          createProviderRequest(plugin)('https://fixture.invalid'),
        ).rejects.toMatchObject({ code: 'rate-limit' })
        await expect(
          createProviderRequest(plugin)('https://fixture.invalid'),
        ).rejects.toMatchObject({ code: 'cooldown' })
        expect(
          Date.parse((await getProviderSafety('fixture')).cooldownUntil ?? ''),
        ).toBeGreaterThan(Date.now() + 3590000)
        expect(fetchMock).toHaveBeenCalledTimes(1)
      } finally {
        delete plugin.manifest.rateLimit.failureCooldownMs
        delete plugin.manifest.rateLimit.errorBackoffMs
      }
    },
  )
  it('keeps server-requested backoff separate from rate-limit cooldowns when generic cooldowns are disabled', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    plugin.manifest.rateLimit.failureCooldownMs = 0
    plugin.manifest.rateLimit.errorBackoffMs = 0
    fetchMock.mockResolvedValue(
      new Response('Unavailable', {
        status: 503,
        headers: { 'retry-after': '60' },
      }),
    )
    try {
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'request-failed' })
      expect((await getProviderSafety('fixture')).cooldownUntil).toBeNull()
      const state = await databaseClient.query.providerRequestState.findFirst()
      expect(state?.nextAllowedAt?.getTime()).toBeGreaterThan(
        Date.now() + 59000,
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      delete plugin.manifest.rateLimit.failureCooldownMs
      delete plugin.manifest.rateLimit.errorBackoffMs
    }
  })
  it('records lookup misses without counting failures, and reviews only the chosen errors without changing limits', async () => {
    const {
      createJob,
      processQueuedJobs,
      getJob,
      markJobErrorBenign,
      listJobs,
      getJobActivity,
    } = await import('@/services/jobs')
    const { getProviderSafety } = await import('@/services/provider-requests')
    const ids = ['lookup-miss-1', 'lookup-miss-2', 'lookup-miss-3']
    for (const id of ids)
      await databaseClient
        .insert(schema.mediaItem)
        .values({ id, mediaType: 'film', title: id, slug: id })
    const scrape = vi
      .spyOn(plugin, 'scrapeMediaItem')
      .mockImplementation(async ({ request }) => {
        await request('https://fixture.invalid/metadata')
        throw new ProviderItemNotFoundError('No fixture match')
      })
    fetchMock.mockImplementation(async () => Response.json({ Movies: [] }))
    const minTimeMs = plugin.manifest.rateLimit.minTimeMs
    plugin.manifest.rateLimit.minTimeMs = 0
    try {
      const queued = await createFixtureJobs(ids)
      const [job] = queued
      if (!job) throw new Error('Missing lookup job')
      await processQueuedJobs()
      for (const sibling of queued) {
        const result = JobSchema.parse(await getJob(sibling.id))
        expect(result.status).toBe('failed')
        expect(result.items).toHaveLength(1)
        expect(result.items[0]?.status).toBe('failed')
      }
      const result = JobSchema.parse(await getJob(job.id))
      expect(
        result.items.filter((item) => item.status === 'failed'),
      ).toHaveLength(1)
      expect(
        result.items.filter((item) => item.status === 'cancelled'),
      ).toHaveLength(0)
      expect(await getProviderSafety('fixture')).toMatchObject({
        cooldownUntil: null,
        consecutiveFailures: 0,
        halted: false,
        requestsLastHour: 3,
      })
      const errors = result.logs.filter((log) => log.level === 'error')
      expect(errors.every((log) => log.canMarkBenign)).toBe(true)
      // A later safety block must survive reviewing an earlier lookup miss.
      await databaseClient
        .update(schema.providerRequestState)
        .set({ halted: true, cooldownUntil: new Date(Date.now() + 3600000) })
      const safety = await getProviderSafety('fixture')
      const activity = await getJobActivity()
      for (const error of errors)
        await markJobErrorBenign(job.id, error.id, null)
      const reviewed = JobSchema.parse(await getJob(job.id))
      expect(reviewed.status).toBe('failed')
      expect(reviewed.options.benignReviewed).toBe(true)
      expect(reviewed.logs.filter((log) => log.benignReview)).toHaveLength(1)
      for (const sibling of queued.slice(1)) {
        expect(
          (await getJob(sibling.id))?.logs.some((log) => log.benignReview),
        ).toBe(false)
        expect(
          (await listJobs({ status: 'attention' })).items.some(
            (item) => item.id === sibling.id,
          ),
        ).toBe(true)
      }
      expect(
        (await listJobs({ status: 'attention' })).items.some(
          (item) => item.id === job.id,
        ),
      ).toBe(false)
      expect((await getJobActivity()).failed).toBe(activity.failed - 1)
      expect(await getProviderSafety('fixture')).toEqual(safety)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      const [first] = errors
      if (!first) throw new Error('Missing error fixture')
      await markJobErrorBenign(job.id, first.id, null)
      expect(
        (await getJob(job.id))?.logs.find((log) => log.id === first.id)
          ?.benignReview,
      ).toEqual(reviewed.logs.find((log) => log.id === first.id)?.benignReview)
      await databaseClient.delete(schema.providerRequestState)
      const later = await createJob(
        CreateJobSchema.parse({
          provider: 'fixture',
          scope: { mediaItemIds: ids.slice(0, 1) },
        }),
        null,
      )
      await processQueuedJobs()
      const laterError = (await getJob(later.id))?.logs.find(
        (log) => log.level === 'error',
      )
      expect(laterError).toMatchObject({
        canMarkBenign: true,
        benignReview: null,
      })
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      plugin.manifest.rateLimit.minTimeMs = minTimeMs
      scrape.mockRestore()
    }
  })
  it('drains one-item siblings when a separately loaded SDK reports lookup misses', async () => {
    const { processQueuedJobs, getJob } = await import('@/services/jobs')
    const { getProviderSafety } = await import('@/services/provider-requests')
    expect(BuiltItemNotFoundError).not.toBe(ProviderItemNotFoundError)
    const ids = ['built-miss-1', 'built-miss-2', 'built-match', 'built-sibling']
    for (const id of ids)
      await databaseClient
        .insert(schema.mediaItem)
        .values({ id, mediaType: 'film', title: id, slug: id })
    const scrape = vi
      .spyOn(plugin, 'scrapeMediaItem')
      .mockImplementation(async ({ request, mediaItemId }) => {
        await request('https://fixture.invalid/metadata')
        if (mediaItemId.startsWith('built-miss'))
          throw new BuiltItemNotFoundError('No fixture match')
        return PluginResultSchema.parse({ payload: {}, normalized: {} })
      })
    fetchMock.mockImplementation(async () => Response.json({ matches: [] }))
    const minTimeMs = plugin.manifest.rateLimit.minTimeMs
    plugin.manifest.rateLimit.minTimeMs = 0
    try {
      const queued = await createFixtureJobs(ids)
      // A previous genuine failure must not turn a lookup miss into a cutoff.
      await databaseClient.insert(schema.providerRequestState).values({
        provider: 'fixture',
        failureCount: 1,
      })
      await processQueuedJobs()
      const results = await Promise.all(
        queued.map(async (job) => JobSchema.parse(await getJob(job.id))),
      )
      expect(results.map((job) => job.status)).toEqual([
        'failed',
        'failed',
        'succeeded',
        'succeeded',
      ])
      for (const result of results.slice(0, 2))
        expect(result.logs.filter((log) => log.level === 'error')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              canMarkBenign: true,
              metadata: expect.objectContaining({
                classification: 'not-found',
              }),
            }),
          ]),
        )
      expect(await getProviderSafety('fixture')).toMatchObject({
        cooldownUntil: null,
        halted: false,
        consecutiveFailures: 0,
        requestsLastHour: 4,
      })
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      plugin.manifest.rateLimit.minTimeMs = minTimeMs
      scrape.mockRestore()
    }
  })
  it('rejects reviewing transport/rate-limit errors even if a plugin declares their message', async () => {
    const { createJob, processQueuedJobs, getJob, markJobErrorBenign } =
      await import('@/services/jobs')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'protected-error',
      mediaType: 'film',
      title: 'Protected',
      slug: 'protected-error',
    })
    fetchMock.mockResolvedValue(new Response('Limited', { status: 429 }))
    const job = await createJob(
      CreateJobSchema.parse({
        provider: 'fixture',
        scope: { mediaItemIds: ['protected-error'] },
      }),
      null,
    )
    await processQueuedJobs()
    const log = (await getJob(job.id))?.logs.find(
      (entry) => entry.level === 'error',
    )
    if (!log) throw new Error('Missing rate limit log')
    plugin.manifest.reviewableErrors = [
      { name: 'ProviderRequestError', message: 'Provider rate limit reached' },
    ]
    try {
      await expect(
        markJobErrorBenign(job.id, log.id, null),
      ).rejects.toMatchObject({ statusCode: 422 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      delete plugin.manifest.reviewableErrors
    }
  })
  it('can disable generic timed cooldowns without disabling the shared two-error stop', async () => {
    const { processQueuedJobs, getJob } = await import('@/services/jobs')
    const { getProviderSafety } = await import('@/services/provider-requests')
    const ids = ['failure-stop-1', 'failure-stop-2', 'failure-stop-3']
    for (const id of ids)
      await databaseClient
        .insert(schema.mediaItem)
        .values({ id, mediaType: 'film', title: id, slug: id })
    plugin.manifest.rateLimit.failureCooldownMs = 0
    plugin.manifest.rateLimit.errorBackoffMs = 0
    const minTimeMs = plugin.manifest.rateLimit.minTimeMs
    plugin.manifest.rateLimit.minTimeMs = 0
    fetchMock.mockImplementation(
      async () => new Response('Failure', { status: 500 }),
    )
    try {
      const queued = await createFixtureJobs(ids)
      await processQueuedJobs()
      const results = await Promise.all(
        queued.map(async (job) => JobSchema.parse(await getJob(job.id))),
      )
      expect(results.filter((job) => job.status === 'failed')).toHaveLength(2)
      expect(results.filter((job) => job.status === 'cancelled')).toHaveLength(
        1,
      )
      expect(await getProviderSafety('fixture')).toMatchObject({
        cooldownUntil: null,
        consecutiveFailures: 2,
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      plugin.manifest.rateLimit.minTimeMs = minTimeMs
      delete plugin.manifest.rateLimit.failureCooldownMs
      delete plugin.manifest.rateLimit.errorBackoffMs
    }
  })
  it('records adapter exceptions and redacts database credentials from plugin messages and stacks', async () => {
    const { createJob, processQueuedJobs, getJob } =
      await import('@/services/jobs')
    const secret = 'offline-private-credential'
    await databaseClient.insert(schema.providerSecret).values({
      id: 'logging-secret',
      provider: 'fixture',
      key: 'apiKey',
      encryptedValue: encryptSecretValue(secret),
    })
    await databaseClient.insert(schema.mediaItem).values({
      id: 'adapter-error-fixture',
      mediaType: 'film',
      title: 'Adapter error fixture',
      slug: 'adapter-error-fixture',
    })
    const scrape = vi
      .spyOn(plugin, 'scrapeMediaItem')
      .mockImplementation(async ({ secrets, log, recordDiagnostic }) => {
        await log('info', `Testing with ${secrets.apiKey}`)
        recordDiagnostic?.({
          stage: 'fixture.response',
          evidence: {
            query: 'Album fixture',
            response: {
              apiKey: secrets.apiKey,
              echoed: `Value ${secrets.apiKey}`,
              candidates: [
                { title: 'Wrong album', rejection: 'identity-mismatch' },
              ],
            },
          },
        })
        throw new Error(`No exact match: ${secrets.apiKey}`, {
          cause: new SyntaxError('Invalid fixture response'),
        })
      })
    try {
      const job = await createJob(
        CreateJobSchema.parse({
          provider: 'fixture',
          scope: { mediaItemIds: ['adapter-error-fixture'] },
        }),
        null,
      )
      await processQueuedJobs()
      const result = JobSchema.parse(await getJob(job.id))
      expect(result.items[0]?.message).toBe('Error: No exact match: [REDACTED]')
      expect(JSON.stringify(result)).toContain(
        'SyntaxError: Invalid fixture response',
      )
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(
        result.logs.find((entry) => entry.level === 'error')?.metadata,
      ).toMatchObject({
        diagnostics: [
          {
            stage: 'fixture.response',
            evidence: {
              query: 'Album fixture',
              response: {
                apiKey: '[REDACTED]',
                echoed: 'Value [REDACTED]',
                candidates: [
                  { title: 'Wrong album', rejection: 'identity-mismatch' },
                ],
              },
            },
          },
        ],
      })
      expect(
        await databaseClient
          .select()
          .from(schema.providerSnapshot)
          .where(
            eq(schema.providerSnapshot.mediaItemId, 'adapter-error-fixture'),
          ),
      ).toEqual([])
      expect(
        result.logs.find((entry) => entry.message.startsWith('Testing with'))
          ?.message,
      ).toBe('Testing with [REDACTED]')
      expect(scrape).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      scrape.mockRestore()
      await databaseClient.delete(schema.providerSecret)
    }
  })
  it('returns item titles/types and persists redacted errors with their original causes', async () => {
    const { createJob, processQueuedJobs, getJob, listJobs } =
      await import('@/services/jobs')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'error-fixture',
      mediaType: 'film',
      title: 'Logging fixture',
      slug: 'error-fixture',
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: 'error-fixture' })
    const job = await createJob(
      CreateJobSchema.parse({
        provider: 'fixture',
        scope: { mediaItemIds: ['error-fixture'] },
      }),
      null,
    )
    const cause = new TypeError(
      'Connection failed: https://fixture.invalid?api_key=hidden-credential',
    )
    fetchMock.mockRejectedValue(cause)
    await processQueuedJobs()
    const result = JobSchema.parse(await getJob(job.id))
    expect(result.status).toBe('failed')
    expect(result.items[0]).toMatchObject({
      mediaTitle: 'Logging fixture',
      mediaType: 'film',
      attemptCount: 1,
    })
    const errorLog = result.logs.find((log) => log.level === 'error')
    const metadata = errorLog?.metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('Expected structured job error')
    const error = JobErrorDetailsSchema.parse(metadata.error)
    expect(error.name).toBe('ProviderRequestError')
    expect(error.stack).toContain('provider-requests.ts')
    expect(
      error.causes.some(
        (entry) =>
          entry.name === 'TypeError' &&
          entry.stack?.includes('provider-requests.integration.ts'),
      ),
    ).toBe(true)
    expect(JSON.stringify(result)).not.toContain('hidden-credential')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      (await listJobs()).items.find((item) => item.id === job.id)?.items[0]
        ?.mediaTitle,
    ).toBe('Logging fixture')
  })
  it('requires exactly one explicit item even when broad runs are confirmed', async () => {
    plugin.manifest.maxItemsPerJob = 1
    plugin.manifest.requireExplicitSelection = true
    try {
      expect(() =>
        CreateJobSchema.parse({
          provider: 'fixture',
          scope: { limit: 1 },
          confirmBroadRun: true,
        }),
      ).toThrow()
      expect(() =>
        CreateJobSchema.parse({
          provider: 'fixture',
          scope: { mediaItemIds: ['one', 'two'] },
          confirmBroadRun: true,
        }),
      ).toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      delete plugin.manifest.maxItemsPerJob
      delete plugin.manifest.requireExplicitSelection
    }
  })
  it('preserves HTTP rate-limit semantics without reading error bodies', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    fetchMock.mockResolvedValue(
      new Response('Body deliberately exceeds declared limit', {
        status: 429,
        headers: { 'content-length': String(20 * 1024 * 1024) },
      }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('shares spacing and serialization across independently created clients', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    const starts: number[] = []
    let active = 0
    let concurrent = 0
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now())
      active++
      concurrent = Math.max(active, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active--
      return Response.json({ title: 'Fixture' })
    })
    await Promise.all([
      createProviderRequest(plugin)('https://fixture.invalid'),
      createProviderRequest(plugin)('https://fixture.invalid'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(concurrent).toBe(1)
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(30)
  })
  it('persists a 429 cooldown, honors a longer Retry-After and never retries', async () => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    fetchMock.mockResolvedValue(
      new Response('Quota reached', {
        status: 429,
        headers: { 'retry-after': '7200' },
      }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit' })
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'cooldown' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const state = await getProviderSafety('fixture')
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toHaveLength(1)
    expect(Date.parse(state.cooldownUntil ?? '')).toBeGreaterThan(
      Date.now() + 7190000,
    )
  })
  it.each([401, 403])('halts persistently after HTTP %s', async (status) => {
    const { createProviderRequest, getProviderSafety } =
      await import('@/services/provider-requests')
    fetchMock.mockResolvedValue(new Response('Denied', { status }))
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'access-denied' })
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'access-denied' })
    expect((await getProviderSafety('fixture')).halted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([400, 500, 503])(
    'backs off immediately after HTTP %s',
    async (status) => {
      const { createProviderRequest, getProviderSafety } =
        await import('@/services/provider-requests')
      fetchMock.mockResolvedValue(new Response('Failure', { status }))
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toThrow()
      await expect(
        createProviderRequest(plugin)('https://fixture.invalid'),
      ).rejects.toMatchObject({ code: 'cooldown' })
      expect((await getProviderSafety('fixture')).cooldownUntil).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
  it('detects API quota errors returned inside HTTP 200', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    fetchMock.mockResolvedValue(
      Response.json({ Response: 'False', Error: 'Request limit reached!' }),
    )
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'rate-limit' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not send a request after exhausting the hourly budget', async () => {
    const { createProviderRequest } =
      await import('@/services/provider-requests')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      requests: Array.from({ length: 140 }, () => Date.now() - 1000),
      requestBudgetOverride: { period: 'day', limit: 100000 },
    })
    await expect(
      createProviderRequest(plugin)('https://fixture.invalid'),
    ).rejects.toMatchObject({ code: 'cooldown' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('stops sibling jobs after two failures and rejects new jobs during cooldown', async () => {
    const { createJob, processQueuedJobs, getJob } =
      await import('@/services/jobs')
    for (let index = 0; index < 5; index++) {
      await databaseClient.insert(schema.mediaItem).values({
        id: `fixture-${index}`,
        mediaType: 'film',
        title: 'Fixture',
        slug: `fixture-${index}`,
      })
      await databaseClient
        .insert(schema.film)
        .values({ mediaItemId: `fixture-${index}` })
    }
    const ids = Array.from({ length: 5 }, (_, index) => `fixture-${index}`)
    fetchMock.mockImplementation(
      async () => new Response('Not found', { status: 404 }),
    )
    const minTimeMs = plugin.manifest.rateLimit.minTimeMs
    plugin.manifest.rateLimit.minTimeMs = 0
    try {
      const queued = await createFixtureJobs(ids)
      await processQueuedJobs()
      const results = await Promise.all(
        queued.map(async (job) => JobSchema.parse(await getJob(job.id))),
      )
      expect(results.filter((job) => job.status === 'failed')).toHaveLength(2)
      expect(results.filter((job) => job.status === 'cancelled')).toHaveLength(
        3,
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await expect(
        createJob(
          CreateJobSchema.parse({
            provider: 'fixture',
            scope: { mediaItemIds: ['fixture-0'] },
          }),
          null,
        ),
      ).rejects.toThrow(/cooling down/)
    } finally {
      plugin.manifest.rateLimit.minTimeMs = minTimeMs
    }
  })
  it('an explicit credential change never clears quota cooldowns', async () => {
    const { clearProviderAccessHalt, getProviderSafety } =
      await import('@/services/provider-requests')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      halted: true,
      cooldownUntil: new Date(Date.now() + 3600000),
    })
    await clearProviderAccessHalt('fixture')
    expect((await getProviderSafety('fixture')).halted).toBe(false)
    expect((await getProviderSafety('fixture')).cooldownUntil).not.toBeNull()
  })
})
