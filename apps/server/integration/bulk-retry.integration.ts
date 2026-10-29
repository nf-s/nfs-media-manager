import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
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
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import {
  BulkRetryJobsSchema,
  BulkRetryJobsResultSchema,
  BulkDismissJobsResultSchema,
  getJobDismissal,
  type Job,
} from '@repo/schemas/job'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import * as schema from '@/schemas/db'

const database = `media_retry_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const execute = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const network = vi.fn(() => {
  throw new Error('Network forbidden in retry tests')
})
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-provider',
    displayName: 'Fixture provider',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
  },
  scrapeMediaItem: execute,
}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) => {
    if (id === 'broken-provider') throw new Error('Bearer secret-fixture-token')
    if (id === 'invalid-provider')
      throw new ServerError({
        statusCode: 422,
        message: 'api_key=secret-fixture-token',
      })
    if (id === 'missing-provider') return null
    return { ...plugin, manifest: { ...plugin.manifest, id } }
  },
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.insert(schema.mediaItem).values(
    Array.from(
      { length: 8 },
      (_, index): typeof schema.mediaItem.$inferInsert => ({
        id: `film-${index + 1}`,
        mediaType: 'film',
        slug: `fixture-film-${index + 1}`,
        title: `Fixture film ${index + 1}`,
      }),
    ),
  )
  execute.mockClear()
  network.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  expect(execute).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function seedJob(
  id: string,
  status: Job['status'] = 'failed',
  mediaItemIds = ['film-1'],
  provider = plugin.manifest.id,
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider,
    status,
    scope: { mediaItemIds, mediaType: 'film', limit: mediaItemIds.length },
    options: { batchId: 'fixture-batch' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  await databaseClient.insert(schema.scrapeJobItem).values(
    mediaItemIds.map((mediaItemId) => ({
      id: `${id}-${mediaItemId}`,
      jobId: id,
      mediaItemId,
      provider,
      status,
    })),
  )
}

describe('selected job retries', () => {
  it('rejects aggregate legacy unfinished work above five before any writes, even with only two jobs', async () => {
    const { bulkRetryJobs } = await import('@/services/jobs')
    await seedJob('first', 'failed', ['film-1', 'film-2', 'film-3'])
    await seedJob('second', 'cancelled', ['film-4', 'film-5', 'film-6'])
    const beforeJobs = await databaseClient.select().from(schema.scrapeJob)
    const beforeItems = await databaseClient.select().from(schema.scrapeJobItem)
    await expect(
      bulkRetryJobs(
        BulkRetryJobsSchema.parse({ jobIds: ['first', 'second'] }),
        null,
      ),
    ).rejects.toHaveProperty('response.statusCode', 422)
    expect(await databaseClient.select().from(schema.scrapeJob)).toEqual(
      beforeJobs,
    )
    expect(await databaseClient.select().from(schema.scrapeJobItem)).toEqual(
      beforeItems,
    )
    expect(await databaseClient.select().from(schema.scrapeJobLog)).toEqual([])
    expect(
      await databaseClient.select().from(schema.providerRequestState),
    ).toEqual([])
  })

  it('queues five one-item retries without confirmation and six only when confirmed', async () => {
    const { bulkRetryJobs } = await import('@/services/jobs')
    const five = Array.from({ length: 5 }, (_, index) => `five-${index}`)
    for (const [index, id] of five.entries())
      await seedJob(id, 'failed', [`film-${index + 1}`])
    expect(
      BulkRetryJobsResultSchema.parse(
        await bulkRetryJobs({ jobIds: five, confirmBroadRun: false }, null),
      ),
    ).toMatchObject({
      queued: 5,
      skipped: 0,
      results: five.map((jobId) => ({
        jobId,
        status: 'queued',
        retryJobId: expect.any(String),
      })),
    })
    const six = Array.from({ length: 6 }, (_, index) => `six-${index}`)
    for (const [index, id] of six.entries())
      await seedJob(id, 'failed', [`film-${index + 1}`], 'other-provider')
    await expect(
      bulkRetryJobs({ jobIds: six, confirmBroadRun: false }, null),
    ).rejects.toHaveProperty('response.statusCode', 422)
    expect(
      await bulkRetryJobs({ jobIds: six, confirmBroadRun: true }, null),
    ).toMatchObject({ queued: 6, skipped: 0 })
    const retries = await databaseClient.query.scrapeJob.findMany({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.provider, 'other-provider'),
          operators.eq(table.status, 'queued'),
        ),
      with: { items: true },
    })
    expect(retries).toHaveLength(6)
    for (const retry of retries) {
      expect(retry.confirmBroadRun).toBe(true)
      expect(retry.items).toHaveLength(1)
      expect(retry.scope.limit).toBe(1)
    }
  })

  it('skips missing, running, queued, successful and previously retried jobs in request order', async () => {
    const { bulkRetryJobs, retryJob } = await import('@/services/jobs')
    await seedJob('running', 'running', ['film-2'])
    await seedJob('queued', 'queued', ['film-3'])
    await seedJob('succeeded', 'succeeded', ['film-4'])
    await seedJob('previous', 'failed', ['film-5'])
    await retryJob('previous', null, false)
    await seedJob('retryable', 'cancelled', ['film-6'])
    const jobIds = [
      'missing',
      'running',
      'queued',
      'succeeded',
      'previous',
      'retryable',
    ]
    const result = await bulkRetryJobs({ jobIds, confirmBroadRun: false }, null)
    expect(result).toMatchObject({ queued: 1, skipped: 5 })
    expect(result.results.map((item) => item.jobId)).toEqual(jobIds)
    expect(result.results.map((item) => item.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'queued',
    ])
  })

  it('never retries succeeded items or items successfully scraped since the original job', async () => {
    const { bulkRetryJobs, getJob } = await import('@/services/jobs')
    for (let index = 1; index <= 4; index++)
      await seedJob(`mixed-${index}`, 'failed', [`film-${index}`])
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ status: 'succeeded' })
      .where(eq(schema.scrapeJobItem.id, 'mixed-1-film-1'))
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ status: 'cancelled' })
      .where(eq(schema.scrapeJobItem.id, 'mixed-4-film-4'))
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'fresh',
      mediaItemId: 'film-2',
      provider: plugin.manifest.id,
      checksum: 'fixture',
      payload: {},
      status: 'succeeded',
      lastScrapedAt: new Date(),
    })
    const result = await bulkRetryJobs(
      {
        jobIds: ['mixed-1', 'mixed-2', 'mixed-3', 'mixed-4'],
        confirmBroadRun: false,
      },
      null,
    )
    expect(result).toMatchObject({ queued: 2, skipped: 2 })
    for (const [index, entry] of result.results.slice(2).entries()) {
      if (!entry.retryJobId) throw new Error('Expected a retry job')
      const retry = await getJob(entry.retryJobId)
      expect(retry?.scope.mediaItemIds).toEqual([`film-${index + 3}`])
      expect(retry?.items).toHaveLength(1)
      expect(retry?.options).toMatchObject({
        retryOf: entry.jobId,
        batchId: 'fixture-batch',
        benignReviewed: false,
        dismissal: null,
      })
    }
    await seedJob('already-successful', 'failed', ['film-2'])
    expect(
      await bulkRetryJobs(
        { jobIds: ['already-successful'], confirmBroadRun: false },
        null,
      ),
    ).toMatchObject({ queued: 0, skipped: 1 })
  })

  it('does not require broad confirmation for jobs that were already retried', async () => {
    const { bulkRetryJobs, retryJob } = await import('@/services/jobs')
    const jobIds = Array.from({ length: 6 }, (_, index) => `original-${index}`)
    for (const [index, id] of jobIds.entries()) {
      await seedJob(id, 'failed', [`film-${index + 1}`])
      await retryJob(id, null, true)
    }
    expect(
      await bulkRetryJobs({ jobIds, confirmBroadRun: false }, null),
    ).toMatchObject({ queued: 0, skipped: 6 })
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(
      12,
    )
  })

  it('returns partial failures with safe messages and preserves provider cooldowns, halts and limits', async () => {
    const { bulkRetryJobs } = await import('@/services/jobs')
    await seedJob('cooldown', 'failed', ['film-1'], 'cooling-provider')
    await seedJob('halted', 'failed', ['film-2'], 'halted-provider')
    await seedJob('unavailable', 'failed', ['film-3'], 'missing-provider')
    await seedJob('broken', 'failed', ['film-4'], 'broken-provider')
    await seedJob('invalid', 'failed', ['film-5'], 'invalid-provider')
    await seedJob('good', 'failed', ['film-6'])
    await databaseClient.insert(schema.providerRequestState).values([
      {
        provider: 'cooling-provider',
        cooldownUntil: new Date(Date.now() + 3600000),
        failureCount: 2,
        requests: [Date.now()],
        nextAllowedAt: new Date(Date.now() + 2000),
        lastError: 'secret-fixture-token',
      },
      {
        provider: 'halted-provider',
        halted: true,
        failureCount: 3,
        requests: [Date.now()],
        lastError: 'secret-fixture-token',
      },
    ])
    const safetyBefore = await databaseClient
      .select()
      .from(schema.providerRequestState)
    const result = await bulkRetryJobs(
      {
        jobIds: [
          'cooldown',
          'halted',
          'unavailable',
          'broken',
          'invalid',
          'good',
        ],
        confirmBroadRun: true,
      },
      null,
    )
    expect(result).toMatchObject({ queued: 1, skipped: 0 })
    expect(result.results.map((item) => item.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'queued',
    ])
    expect(JSON.stringify(result)).not.toContain('secret-fixture-token')
    expect(result.results[0]?.message).toContain('cooling down or halted')
    expect(
      await databaseClient.select().from(schema.providerRequestState),
    ).toEqual(safetyBefore)
  })

  it('does not link an original when overlapping active work prevents its retry', async () => {
    const { bulkRetryJobs, getJob } = await import('@/services/jobs')
    await seedJob('blocked')
    await seedJob('active', 'running')
    expect(
      await bulkRetryJobs(
        { jobIds: ['blocked'], confirmBroadRun: false },
        null,
      ),
    ).toMatchObject({ queued: 0, skipped: 1 })
    expect((await getJob('blocked'))?.options).toEqual({
      batchId: 'fixture-batch',
    })
    expect(await databaseClient.select().from(schema.scrapeJobLog)).toEqual([])
  })

  it('validates duplicate and oversized selections at the service boundary before writes', async () => {
    const { bulkRetryJobs } = await import('@/services/jobs')
    await seedJob('original')
    for (const jobIds of [
      [],
      ['original', 'original'],
      Array.from({ length: 101 }, (_, index) => `job-${index}`),
    ]) {
      await expect(
        bulkRetryJobs({ jobIds, confirmBroadRun: true }, null),
      ).rejects.toThrow()
    }
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(1)
    expect(await databaseClient.select().from(schema.scrapeJobLog)).toEqual([])
  })

  it('counts only one queued retry across overlapping bulk requests', async () => {
    const { bulkRetryJobs } = await import('@/services/jobs')
    await seedJob('original')
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        bulkRetryJobs({ jobIds: ['original'], confirmBroadRun: false }, null),
      ),
    )
    expect(results.reduce((count, result) => count + result.queued, 0)).toBe(1)
    expect(results.reduce((count, result) => count + result.skipped, 0)).toBe(7)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(2)
  })

  it('returns the same retry for concurrent calls, including after that retry finishes', async () => {
    const { retryJob } = await import('@/services/jobs')
    const requests = await import('@/services/provider-requests')
    const getProviderSafety = requests.getProviderSafety
    let release = () => {}
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrivals = 0
    const safety = vi
      .spyOn(requests, 'getProviderSafety')
      .mockImplementation(async (provider) => {
        const result = await getProviderSafety(provider)
        arrivals++
        if (arrivals === 8) release()
        await ready
        return result
      })
    await seedJob('original')
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => retryJob('original', null, false)),
    )
    safety.mockRestore()
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    const ids = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.id] : [],
    )
    expect(new Set(ids).size).toBe(1)
    const retryId = ids[0]
    if (!retryId) throw new Error('Expected a retry job')
    await databaseClient
      .update(schema.scrapeJob)
      .set({ status: 'failed' })
      .where(eq(schema.scrapeJob.id, retryId))
    expect((await retryJob('original', null, false)).id).toBe(retryId)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(2)
  })
})

describe('selected job dismissal', () => {
  it('dismisses failed and cancelled jobs while preserving logs, items and provider safety', async () => {
    const { bulkDismissJobs, dismissJob, getJob } =
      await import('@/services/jobs')
    await seedJob('failed')
    await seedJob('cancelled', 'cancelled', ['film-2'])
    await seedJob('running', 'running', ['film-3'])
    await seedJob('succeeded', 'succeeded', ['film-4'])
    await seedJob('already-dismissed', 'failed', ['film-5'])
    await dismissJob('already-dismissed', 'first-reviewer')
    const previous = getJobDismissal(
      (await getJob('already-dismissed'))?.options ?? {},
    )
    await databaseClient.insert(schema.scrapeJobLog).values({
      id: 'retained-log',
      jobId: 'failed',
      level: 'error',
      message: 'Original error',
      metadata: { error: 'Original error' },
    })
    await databaseClient.insert(schema.providerRequestState).values({
      provider: plugin.manifest.id,
      halted: true,
      failureCount: 3,
      cooldownUntil: new Date(Date.now() + 3600000),
      requests: [Date.now()],
    })
    const itemsBefore = await databaseClient.select().from(schema.scrapeJobItem)
    const logsBefore = await databaseClient.select().from(schema.scrapeJobLog)
    const safetyBefore = await databaseClient
      .select()
      .from(schema.providerRequestState)
    const jobIds = [
      'failed',
      'cancelled',
      'running',
      'succeeded',
      'missing',
      'already-dismissed',
    ]
    const result = BulkDismissJobsResultSchema.parse(
      await bulkDismissJobs({ jobIds }, 'reviewer'),
    )
    expect(result).toMatchObject({ dismissed: 2, skipped: 4 })
    expect(result.results.map((item) => item.jobId)).toEqual(jobIds)
    expect(
      getJobDismissal((await getJob('failed'))?.options ?? {})?.userId,
    ).toBe('reviewer')
    expect(
      getJobDismissal((await getJob('already-dismissed'))?.options ?? {}),
    ).toEqual(previous)
    expect(await databaseClient.select().from(schema.scrapeJobItem)).toEqual(
      itemsBefore,
    )
    expect(await databaseClient.select().from(schema.scrapeJobLog)).toEqual(
      logsBefore,
    )
    expect(
      await databaseClient.select().from(schema.providerRequestState),
    ).toEqual(safetyBefore)
    expect((await getJob('failed'))?.status).toBe('failed')
  })

  it('counts one dismissal under concurrent requests', async () => {
    const { bulkDismissJobs } = await import('@/services/jobs')
    await seedJob('original')
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        bulkDismissJobs({ jobIds: ['original'] }, 'reviewer'),
      ),
    )
    expect(results.reduce((count, result) => count + result.dismissed, 0)).toBe(
      1,
    )
    expect(results.reduce((count, result) => count + result.skipped, 0)).toBe(7)
  })

  it('validates dismissal selections before writes', async () => {
    const { bulkDismissJobs } = await import('@/services/jobs')
    await seedJob('original')
    for (const jobIds of [
      [],
      ['original', 'original'],
      Array.from({ length: 101 }, (_, index) => `job-${index}`),
    ]) {
      await expect(bulkDismissJobs({ jobIds }, null)).rejects.toThrow()
    }
    const original = await databaseClient.query.scrapeJob.findFirst()
    expect(original?.options.dismissal).toBeUndefined()
  })
})
