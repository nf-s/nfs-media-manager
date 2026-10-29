import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
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
import { CreateJobSchema } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `concurrent_jobs_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: 'postgres' })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const execute = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const network = vi.fn<typeof fetch>()
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-concurrent',
    displayName: 'Fixture concurrent',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: {
      concurrentRequests: true,
      maxConcurrent: 3,
      minTimeMs: 25,
      failureCooldownMs: 0,
      errorBackoffMs: 0,
    },
  },
  scrapeMediaItem: execute,
}
const serialPlugin: MediaProviderPlugin = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    id: 'fixture-serial',
    rateLimit: {
      ...plugin.manifest.rateLimit,
      concurrentRequests: false,
      minTimeMs: 0,
    },
  },
}

vi.mock('@/lib/load-workspace-env', () => ({ loadWorkspaceEnv: () => {} }))
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === serialPlugin.manifest.id ? serialPlugin : plugin,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({}),
}))

function holdRequests() {
  const pending: Array<{
    url: string
    release: (response: Response) => void
  }> = []
  const starts: number[] = []
  let active = 0
  let peak = 0
  network.mockImplementation(async (input) => {
    starts.push(Date.now())
    active += 1
    peak = Math.max(peak, active)
    try {
      return await new Promise<Response>((resolve) => {
        pending.push({
          url: input instanceof Request ? input.url : String(input),
          release: resolve,
        })
      })
    } finally {
      active -= 1
    }
  })
  return {
    pending,
    starts,
    peak: () => peak,
    releaseAll: () => {
      network.mockImplementation(async () => Response.json({ fixture: true }))
      for (const request of pending)
        request.release(Response.json({ fixture: true }))
    },
  }
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  vi.resetModules()
  plugin.manifest.rateLimit.concurrentRequests = true
  plugin.manifest.rateLimit.maxConcurrent = 3
  plugin.manifest.rateLimit.minTimeMs = 25
  delete plugin.manifest.rateLimit.maxRequestsPerHour
  execute.mockReset().mockImplementation(async ({ request, mediaItemId }) => {
    await request(`https://fixture.invalid/${mediaItemId}`)
    return PluginResultSchema.parse({
      payload: { mediaItemId },
      normalized: {},
    })
  })
  network.mockReset().mockRejectedValue(new Error('Outbound network forbidden'))
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values(
    Array.from(
      { length: 8 },
      (_, index): typeof schema.mediaItem.$inferInsert => ({
        id: `film-${index}`,
        slug: `fixture-${index}`,
        title: `Fixture ${index}`,
        mediaType: 'film',
      }),
    ),
  )
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function createFixtureJob(start = 0, provider = plugin.manifest.id) {
  const jobs = await import('@/services/jobs')
  return jobs.createJob(
    CreateJobSchema.parse({
      provider,
      scope: {
        mediaItemIds: [`film-${start}`],
        limit: 1,
      },
    }),
    null,
  )
}

async function createFixtureJobs(
  count = 6,
  start = 0,
  provider = plugin.manifest.id,
) {
  const queued = []
  for (let index = 0; index < count; index++)
    queued.push(await createFixtureJob(start + index, provider))
  return queued
}

describe('bounded concurrent one-item jobs', () => {
  it('drains in-flight work on shutdown without claiming the remaining queue', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    await createFixtureJobs()
    let dispatch = true
    const worker = jobs.processQueuedJobs(() => dispatch)
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3), {
        timeout: 3000,
      })
      dispatch = false
      requests.releaseAll()
      await worker
      expect(execute).toHaveBeenCalledTimes(3)
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 0,
        queued: 3,
        completed: 3,
      })
      await jobs.processQueuedJobs(() => false)
      expect(execute).toHaveBeenCalledTimes(3)
    } finally {
      dispatch = false
      requests.releaseAll()
      await worker
    }
  })
  it('overlaps one-item jobs and immediately drains queued siblings without duplicate claims', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    const queued = await createFixtureJobs()
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3), {
        timeout: 3000,
      })
      await jobs.processQueuedJobs()
      expect(execute).toHaveBeenCalledTimes(3)
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 3,
        queued: 3,
      })
      requests.pending[0]?.release(Response.json({ fixture: true }))
      await vi.waitFor(() => expect(requests.pending).toHaveLength(4), {
        timeout: 1000,
      })
      expect(requests.peak()).toBe(3)
      requests.releaseAll()
      await worker
      for (const job of queued) {
        const completed = await jobs.getJob(job.id)
        expect(completed?.status).toBe('succeeded')
        expect(completed?.items).toHaveLength(1)
        expect(completed?.items[0]?.attemptCount).toBe(1)
      }
      expect(network).toHaveBeenCalledTimes(6)
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('overlaps exactly three requests, refills one slot, and retains accurate counters', async () => {
    plugin.manifest.rateLimit.minTimeMs = 350
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    const queued = await createFixtureJobs()
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3), {
        timeout: 3000,
      })
      expect(requests.peak()).toBe(3)
      expect(execute).toHaveBeenCalledTimes(3)
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 3,
        queued: 3,
        completed: 0,
        failed: 0,
      })
      requests.pending[0]?.release(Response.json({ fixture: true }))
      await vi.waitFor(() => expect(requests.pending).toHaveLength(4), {
        timeout: 3000,
      })
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 3,
        queued: 2,
        completed: 1,
      })
      expect(requests.peak()).toBe(3)
      requests.releaseAll()
      await worker
      for (const job of queued) {
        const completed = await jobs.getJob(job.id)
        expect(completed?.status).toBe('succeeded')
        expect(completed?.items).toHaveLength(1)
        expect(completed?.items[0]).toMatchObject({
          status: 'succeeded',
          attemptCount: 1,
        })
      }
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 0,
        completed: 6,
        failed: 0,
      })
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toHaveLength(6)
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toHaveLength(6)
      expect(network).toHaveBeenCalledTimes(6)
      for (const [index, start] of requests.starts.entries()) {
        const previous = requests.starts[index - 1]
        if (previous !== undefined)
          expect(start - previous).toBeGreaterThanOrEqual(345)
      }
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('discovers new one-item jobs while all provider slots are occupied', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    await createFixtureJobs(3)
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3))
      expect(execute).toHaveBeenCalledTimes(3)
      await createFixtureJobs(5, 3)
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 3,
        queued: 5,
      })
      requests.releaseAll()
      await worker
      expect(requests.peak()).toBe(3)
      expect(network).toHaveBeenCalledTimes(8)
      expect(await jobs.getJobActivity()).toMatchObject({ completed: 8 })
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('keeps separate jobs serial without the concurrency opt-in', async () => {
    plugin.manifest.rateLimit.concurrentRequests = false
    plugin.manifest.rateLimit.maxConcurrent = 5
    plugin.manifest.rateLimit.minTimeMs = 0
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    await createFixtureJobs(3)
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await jobs.getJobActivity()).toMatchObject({
        running: 1,
        queued: 2,
      })
      requests.releaseAll()
      await worker
      expect(requests.peak()).toBe(1)
      expect(network).toHaveBeenCalledTimes(3)
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it.each([429, 403, 500])(
    'stops sibling job refills after HTTP %s',
    async (status) => {
      const jobs = await import('@/services/jobs')
      const requests = holdRequests()
      await createFixtureJobs()
      const worker = jobs.processQueuedJobs()
      try {
        await vi.waitFor(() => expect(requests.pending).toHaveLength(3))
        const failures = status === 500 ? 2 : 1
        for (const request of requests.pending.slice(0, failures))
          request.release(
            new Response('Blocked', {
              status,
              headers: { 'retry-after': '60' },
            }),
          )
        await vi.waitFor(async () => {
          const records = await databaseClient.select().from(schema.scrapeJob)
          expect(records.filter((job) => job.status === 'failed')).toHaveLength(
            failures,
          )
        })
        requests.releaseAll()
        await worker
        expect(network).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(3)
        expect(await jobs.getJobActivity()).toMatchObject({
          completed: 3 - failures,
          queued: status === 429 ? 3 : 0,
        })
        const { getProviderSafety } =
          await import('@/services/provider-requests')
        const safety = await getProviderSafety(plugin.manifest.id)
        if (status === 429) expect(safety.cooldownUntil).not.toBeNull()
        if (status === 403) expect(safety.halted).toBe(true)
      } finally {
        requests.releaseAll()
        await worker
      }
    },
  )

  it('stops sibling spacing waiters without counting blocked requests as new failures', async () => {
    plugin.manifest.rateLimit.minTimeMs = 10000
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    await createFixtureJobs()
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => {
        expect(requests.pending).toHaveLength(1)
        expect(execute).toHaveBeenCalledTimes(3)
      })
      requests.pending[0]?.release(new Response('Limited', { status: 429 }))
      await worker
      expect(network).toHaveBeenCalledTimes(1)
      const { getProviderSafety } = await import('@/services/provider-requests')
      expect(
        (await getProviderSafety(plugin.manifest.id)).consecutiveFailures,
      ).toBe(1)
      expect(await jobs.getJobActivity()).toMatchObject({
        failed: 3,
        completed: 0,
        queued: 3,
      })
      const records = await databaseClient.select().from(schema.scrapeJob)
      expect(records.filter((job) => job.status === 'cancelled')).toHaveLength(
        2,
      )
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('resets shared failures after success instead of accumulating errors across the drain', async () => {
    plugin.manifest.rateLimit.concurrentRequests = false
    plugin.manifest.rateLimit.minTimeMs = 0
    const jobs = await import('@/services/jobs')
    network.mockImplementation(async () => Response.json({ fixture: true }))
    execute.mockImplementation(async ({ request, mediaItemId }) => {
      await request(`https://fixture.invalid/${mediaItemId}`)
      if (mediaItemId === 'film-0' || mediaItemId === 'film-2')
        throw new Error('Isolated fixture error')
      return PluginResultSchema.parse({ payload: {}, normalized: {} })
    })
    await createFixtureJobs(4)
    await jobs.processQueuedJobs()
    expect(execute).toHaveBeenCalledTimes(4)
    expect(await jobs.getJobActivity()).toMatchObject({
      failed: 2,
      completed: 2,
      queued: 0,
    })
  })

  it('does not let queued serial jobs starve concurrent provider jobs', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    await createFixtureJobs(6, 0, serialPlugin.manifest.id)
    await createFixtureJobs(2, 6)
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3))
      expect(execute).toHaveBeenCalledTimes(3)
      expect(await jobs.getJobActivity()).toMatchObject({ running: 3 })
      requests.releaseAll()
      await worker
      expect(await jobs.getJobActivity()).toMatchObject({ completed: 8 })
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it.each([false, undefined])(
    'runs different providers independently while each stays serial with opt-in %s',
    async (flag) => {
      plugin.manifest.rateLimit.concurrentRequests = flag
      plugin.manifest.rateLimit.maxConcurrent = 5
      plugin.manifest.rateLimit.minTimeMs = 0
      const jobs = await import('@/services/jobs')
      const requests = holdRequests()
      await createFixtureJobs(3)
      await createFixtureJobs(3, 3, serialPlugin.manifest.id)
      const worker = jobs.processQueuedJobs()
      try {
        await vi.waitFor(() => expect(requests.pending).toHaveLength(2))
        expect(requests.pending.map((request) => request.url)).toEqual(
          expect.arrayContaining([
            'https://fixture.invalid/film-0',
            'https://fixture.invalid/film-3',
          ]),
        )
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(execute).toHaveBeenCalledTimes(2)
        expect(await jobs.getJobActivity()).toMatchObject({
          running: 2,
          queued: 4,
        })
        requests.pending
          .find((request) => request.url.endsWith('/film-0'))
          ?.release(Response.json({ fixture: true }))
        await vi.waitFor(() => expect(requests.pending).toHaveLength(3))
        expect(requests.pending[2]?.url).toBe('https://fixture.invalid/film-1')
        requests.pending[2]?.release(Response.json({ fixture: true }))
        await vi.waitFor(() => expect(requests.pending).toHaveLength(4))
        expect(requests.pending[3]?.url).toBe('https://fixture.invalid/film-2')
        requests.pending
          .find((request) => request.url.endsWith('/film-3'))
          ?.release(Response.json({ fixture: true }))
        await vi.waitFor(() => expect(requests.pending).toHaveLength(5))
        expect(requests.pending[4]?.url).toBe('https://fixture.invalid/film-4')
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(execute).toHaveBeenCalledTimes(5)
        expect(requests.peak()).toBe(2)
        requests.releaseAll()
        await worker
        expect(network).toHaveBeenCalledTimes(6)
        expect(await jobs.getJobActivity()).toMatchObject({
          completed: 6,
          queued: 0,
        })
      } finally {
        requests.releaseAll()
        await worker
      }
    },
  )

  it('shares the hourly request budget across one-item jobs', async () => {
    plugin.manifest.rateLimit.maxRequestsPerHour = 2
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    await createFixtureJobs()
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(2))
      const { getProviderSafety } = await import('@/services/provider-requests')
      await vi.waitFor(async () => {
        expect(
          (await getProviderSafety(plugin.manifest.id)).cooldownUntil,
        ).not.toBeNull()
      })
      requests.releaseAll()
      await worker
      await jobs.processQueuedJobs()
      expect(network).toHaveBeenCalledTimes(2)
      expect(
        await databaseClient.select().from(schema.providerRequestEvent),
      ).toHaveLength(2)
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toHaveLength(2)
      expect(await jobs.getJobActivity()).toMatchObject({
        completed: 2,
        queued: 3,
      })
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('refills a cancelled one-item job only after its in-flight result is discarded', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    const first = await createFixtureJob()
    await createFixtureJobs(5, 1)
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3))
      await jobs.bulkCancelJobs(
        { jobIds: [first.id], confirmRunning: true },
        null,
      )
      const cancelled = await jobs.getJob(first.id)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(execute).toHaveBeenCalledTimes(3)
      requests.pending
        .find((request) => request.url.endsWith('/film-0'))
        ?.release(Response.json({ fixture: true }))
      await vi.waitFor(() => expect(requests.pending).toHaveLength(4))
      expect(await jobs.getJob(first.id)).toEqual(cancelled)
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toHaveLength(0)
      requests.releaseAll()
      await worker
      expect(await jobs.getJob(first.id)).toEqual(cancelled)
      expect(requests.peak()).toBe(3)
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toHaveLength(5)
      expect(network).toHaveBeenCalledTimes(6)
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('does not count a cancelled job late adapter error toward sibling fail-fast', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    execute.mockImplementation(async ({ request, mediaItemId }) => {
      await request(`https://fixture.invalid/${mediaItemId}`)
      if (mediaItemId === 'film-0' || mediaItemId === 'film-1')
        throw new Error('Fixture adapter error')
      return PluginResultSchema.parse({ payload: {}, normalized: {} })
    })
    const first = await createFixtureJob()
    await createFixtureJobs(5, 1)
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3))
      await jobs.bulkCancelJobs(
        { jobIds: [first.id], confirmRunning: true },
        null,
      )
      requests.pending
        .find((request) => request.url.endsWith('/film-0'))
        ?.release(Response.json({ fixture: true }))
      await vi.waitFor(() => expect(requests.pending).toHaveLength(4))
      requests.pending
        .find((request) => request.url.endsWith('/film-1'))
        ?.release(Response.json({ fixture: true }))
      await vi.waitFor(() => expect(requests.pending).toHaveLength(5))
      requests.releaseAll()
      await worker
      expect(await jobs.getJobActivity()).toMatchObject({
        completed: 4,
        failed: 1,
      })
      expect((await jobs.getJob(first.id))?.status).toBe('cancelled')
      expect(network).toHaveBeenCalledTimes(6)
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it.each([false, undefined])(
    'keeps maxConcurrent five serial when opt-in is %s',
    async (flag) => {
      plugin.manifest.rateLimit.maxConcurrent = 5
      plugin.manifest.rateLimit.concurrentRequests = flag
      plugin.manifest.rateLimit.minTimeMs = 0
      const jobs = await import('@/services/jobs')
      const requests = holdRequests()
      const queued = await createFixtureJobs(3)
      const worker = jobs.processQueuedJobs()
      try {
        await vi.waitFor(() => expect(requests.pending).toHaveLength(1))
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(execute).toHaveBeenCalledTimes(1)
        expect(requests.peak()).toBe(1)
        requests.releaseAll()
        await worker
        for (const job of queued)
          expect((await jobs.getJob(job.id))?.status).toBe('succeeded')
        expect(network).toHaveBeenCalledTimes(3)
      } finally {
        requests.releaseAll()
        await worker
      }
    },
  )

  it('discards all in-flight results and logs after user cancellation', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    execute.mockImplementation(async ({ request, log, mediaItemId }) => {
      await request(`https://fixture.invalid/${mediaItemId}`)
      await log('info', 'Late result must not be logged')
      return PluginResultSchema.parse({ payload: {}, normalized: {} })
    })
    const queued = await createFixtureJobs()
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3), {
        timeout: 3000,
      })
      await jobs.cancelQueuedJobs({ provider: plugin.manifest.id })
      const cancellation = await jobs.bulkCancelJobs(
        {
          jobIds: queued.slice(0, 3).map((job) => job.id),
          confirmRunning: true,
        },
        null,
      )
      expect(cancellation).toMatchObject({ cancelled: 3, skipped: 0 })
      const cancelled = await Promise.all(
        queued.map((job) => jobs.getJob(job.id)),
      )
      requests.releaseAll()
      await worker
      expect(
        await Promise.all(queued.map((job) => jobs.getJob(job.id))),
      ).toEqual(cancelled)
      for (const job of cancelled) {
        expect(job?.status).toBe('cancelled')
        expect(job?.items).toHaveLength(1)
        expect(job?.items[0]?.status).toBe('cancelled')
      }
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toHaveLength(0)
      expect(network).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(3)
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it.each([429, 403])(
    'stops after HTTP %s without losing other in-flight results',
    async (status) => {
      const jobs = await import('@/services/jobs')
      const requests = holdRequests()
      const queued = await createFixtureJobs()
      const worker = jobs.processQueuedJobs()
      try {
        await vi.waitFor(() => expect(requests.pending).toHaveLength(3), {
          timeout: 3000,
        })
        requests.pending[0]?.release(
          new Response('Blocked', { status, headers: { 'retry-after': '60' } }),
        )
        await vi.waitFor(async () => {
          const records = await databaseClient.select().from(schema.scrapeJob)
          expect(records.filter((job) => job.status === 'failed')).toHaveLength(
            1,
          )
          expect(
            records.filter((job) => job.status === 'running'),
          ).toHaveLength(2)
        })
        requests.releaseAll()
        await worker
        const stopped = await Promise.all(
          queued.map((job) => jobs.getJob(job.id)),
        )
        expect(stopped.filter((job) => job?.status === 'failed')).toHaveLength(
          1,
        )
        expect(
          stopped.filter((job) => job?.status === 'succeeded'),
        ).toHaveLength(2)
        expect(
          stopped.filter(
            (job) => job?.status === (status === 429 ? 'queued' : 'cancelled'),
          ),
        ).toHaveLength(3)
        expect(
          stopped.filter((job) => job?.items[0]?.attemptCount === 0),
        ).toHaveLength(3)
        expect(
          await databaseClient.select().from(schema.providerSnapshot),
        ).toHaveLength(2)
        expect(network).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(3)
        const { getProviderSafety } =
          await import('@/services/provider-requests')
        expect(
          (await getProviderSafety(plugin.manifest.id)).consecutiveFailures,
        ).toBe(1)
      } finally {
        requests.releaseAll()
        await worker
      }
    },
  )

  it.each(['cancellation', 'rate-limit'])(
    'stops spacing waiters after %s without spending more requests',
    async (outcome) => {
      plugin.manifest.rateLimit.minTimeMs = 10000
      const jobs = await import('@/services/jobs')
      const requests = holdRequests()
      const queued = await createFixtureJobs()
      const worker = jobs.processQueuedJobs()
      try {
        await vi.waitFor(() => {
          expect(requests.pending).toHaveLength(1)
          expect(execute).toHaveBeenCalledTimes(3)
        })
        if (outcome === 'cancellation') {
          await jobs.cancelQueuedJobs({ provider: plugin.manifest.id })
          const cancellation = await jobs.bulkCancelJobs(
            {
              jobIds: queued.slice(0, 3).map((job) => job.id),
              confirmRunning: true,
            },
            null,
          )
          expect(cancellation).toMatchObject({ cancelled: 3, skipped: 0 })
          requests.releaseAll()
        } else {
          requests.pending[0]?.release(new Response('Limited', { status: 429 }))
        }
        await worker
        const stopped = await Promise.all(
          queued.map((job) => jobs.getJob(job.id)),
        )
        expect(
          stopped.filter((job) => job?.status === 'cancelled'),
        ).toHaveLength(outcome === 'cancellation' ? 6 : 2)
        expect(stopped.filter((job) => job?.status === 'failed')).toHaveLength(
          outcome === 'cancellation' ? 0 : 1,
        )
        expect(stopped.filter((job) => job?.status === 'queued')).toHaveLength(
          outcome === 'cancellation' ? 0 : 3,
        )
        expect(
          await databaseClient.select().from(schema.providerSnapshot),
        ).toHaveLength(0)
        expect(
          await databaseClient.select().from(schema.providerRequestEvent),
        ).toHaveLength(1)
        expect(network).toHaveBeenCalledTimes(1)
        const { getProviderSafety } =
          await import('@/services/provider-requests')
        expect(
          (await getProviderSafety(plugin.manifest.id)).consecutiveFailures,
        ).toBe(outcome === 'cancellation' ? 0 : 1)
      } finally {
        requests.releaseAll()
        await worker
      }
    },
  )

  it('keeps the two-error stop latched after an in-flight success and cancels queued sibling jobs', async () => {
    const jobs = await import('@/services/jobs')
    const requests = holdRequests()
    const queued = await createFixtureJobs(7)
    const worker = jobs.processQueuedJobs()
    try {
      await vi.waitFor(() => expect(requests.pending).toHaveLength(3), {
        timeout: 3000,
      })
      requests.pending[0]?.release(new Response('Failure', { status: 500 }))
      requests.pending[1]?.release(new Response('Failure', { status: 500 }))
      await vi.waitFor(async () => {
        const records = await databaseClient.select().from(schema.scrapeJob)
        expect(records.filter((job) => job.status === 'failed')).toHaveLength(2)
      })
      requests.releaseAll()
      await worker
      const stopped = await Promise.all(
        queued.map((job) => jobs.getJob(job.id)),
      )
      expect(stopped.filter((job) => job?.status === 'succeeded')).toHaveLength(
        1,
      )
      expect(stopped.filter((job) => job?.status === 'cancelled')).toHaveLength(
        4,
      )
      expect(
        stopped.filter((job) => job?.items[0]?.attemptCount === 0),
      ).toHaveLength(4)
      expect(network).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(3)
    } finally {
      requests.releaseAll()
      await worker
    }
  })

  it('continues after lookup misses without counting them toward fail-fast', async () => {
    const jobs = await import('@/services/jobs')
    network.mockImplementation(async () => Response.json({ matches: [] }))
    execute.mockImplementation(async ({ request, mediaItemId }) => {
      await request(`https://fixture.invalid/${mediaItemId}`)
      throw new ProviderItemNotFoundError('No fixture match')
    })
    const queued = await createFixtureJobs()
    await jobs.processQueuedJobs()
    for (const job of queued) {
      const result = await jobs.getJob(job.id)
      expect(result?.status).toBe('failed')
      expect(result?.items).toHaveLength(1)
      expect(result?.items[0]?.attemptCount).toBe(1)
    }
    expect(network).toHaveBeenCalledTimes(6)
    const { getProviderSafety } = await import('@/services/provider-requests')
    expect(await getProviderSafety(plugin.manifest.id)).toMatchObject({
      consecutiveFailures: 0,
      cooldownUntil: null,
      halted: false,
    })
  })
})
