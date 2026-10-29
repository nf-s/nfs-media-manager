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
import {
  PluginResultSchema,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { BulkCancelJobsSchema, type Job } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `running_jobs_test_${randomUUID().replaceAll('-', '')}`
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
const network = vi.fn<typeof fetch>()
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-running',
    displayName: 'Fixture running',
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
vi.mock('@/plugins/registry', () => ({ getScrapePlugin: async () => plugin }))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({}),
}))

function signal() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function result(title = 'Saved fixture') {
  return PluginResultSchema.parse({
    payload: { title },
    normalized: { mediaPatch: { title } },
  })
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
  execute.mockReset().mockResolvedValue(result())
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
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function seedJob(
  id: string,
  status: Job['status'],
  statuses: Job['status'][] = [status],
  start = 0,
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider: plugin.manifest.id,
    status,
    scope: {
      mediaItemIds: statuses.map((_, i) => `film-${start + i}`),
      mediaType: 'film',
      limit: statuses.length,
    },
    options: { batchId: 'fixture' },
    createdAt: new Date('2026-01-01'),
  })
  await databaseClient.insert(schema.scrapeJobItem).values(
    statuses.map((status, i) => ({
      id: `${id}-${i}`,
      jobId: id,
      mediaItemId: `film-${start + i}`,
      provider: plugin.manifest.id,
      status,
      attemptCount: status === 'queued' ? 0 : 1,
    })),
  )
}

describe('running job recovery and worker fencing', () => {
  it('cancels queued selections without running confirmation and leaves completed jobs unchanged', async () => {
    const jobs = await import('@/services/jobs')
    await seedJob('waiting', 'queued')
    await seedJob('claimed-before-cancel', 'running')
    await seedJob('finished', 'succeeded')
    const result = await jobs.bulkCancelJobs(
      {
        jobIds: ['waiting', 'claimed-before-cancel', 'finished'],
        confirmRunning: false,
      },
      'reviewer',
    )
    expect(result).toMatchObject({ cancelled: 1, skipped: 2 })
    expect((await jobs.getJob('waiting'))?.items[0]?.status).toBe('cancelled')
    expect((await jobs.getJob('claimed-before-cancel'))?.status).toBe('running')
    expect((await jobs.getJob('finished'))?.status).toBe('succeeded')
    expect((await jobs.getJobActivity()).failed).toBe(0)
    await jobs.processQueuedJobs()
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })
  it('refuses to execute a legacy multi-item job without blocking a valid sibling', async () => {
    const jobs = await import('@/services/jobs')
    await seedJob('legacy', 'queued', ['queued', 'queued'])
    await seedJob('single', 'queued', ['queued'], 2)
    await jobs.processQueuedJobs()
    const legacy = await jobs.getJob('legacy')
    expect(legacy?.status).toBe('failed')
    expect(legacy?.errorMessage).toMatch(/must be split/)
    expect(legacy?.items).toHaveLength(2)
    for (const item of legacy?.items ?? [])
      expect(item).toMatchObject({ status: 'cancelled', attemptCount: 0 })
    expect((await jobs.getJob('single'))?.status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0].mediaItemId).toBe('film-2')
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.scrapeJobId).toBe('single')
    expect(network).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation without mutating unconfirmed running jobs', async () => {
    const jobs = await import('@/services/jobs')
    await seedJob('orphan', 'running')
    const before = await jobs.getJob('orphan')
    expect(BulkCancelJobsSchema.safeParse({ jobIds: ['orphan'] }).success).toBe(
      true,
    )
    expect(
      await jobs.bulkCancelJobs(
        { jobIds: ['orphan'], confirmRunning: false },
        null,
      ),
    ).toMatchObject({ cancelled: 0, skipped: 1 })
    expect(
      await jobs.bulkRetryJobs(
        { jobIds: ['orphan'], confirmBroadRun: true },
        null,
      ),
    ).toMatchObject({ queued: 0, skipped: 1 })
    expect(await jobs.getJob('orphan')).toEqual(before)
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('cancels legacy running jobs, preserving completed/failed items, logs, and provider safety', async () => {
    const jobs = await import('@/services/jobs')
    await seedJob('orphan', 'running', [
      'succeeded',
      'running',
      'queued',
      'failed',
    ])
    await seedJob('completed', 'succeeded')
    await seedJob('queued', 'queued')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: plugin.manifest.id,
      halted: true,
      failureCount: 3,
      leaseId: 'retained-lease',
      leaseUntil: new Date(Date.now() + 20000),
      nextAllowedAt: new Date(Date.now() + 60000),
      requests: [Date.now()],
    })
    const safety = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(
      await jobs.bulkCancelJobs(
        {
          jobIds: ['orphan', 'completed', 'queued', 'missing'],
          confirmRunning: true,
        },
        'reviewer',
      ),
    ).toMatchObject({ cancelled: 2, skipped: 2 })
    const cancelled = await jobs.getJob('orphan')
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.items.map((item) => item.status)).toEqual([
      'succeeded',
      'cancelled',
      'cancelled',
      'failed',
    ])
    expect(cancelled?.logs.at(-1)?.metadata).toEqual({ userId: 'reviewer' })
    expect(
      await databaseClient.select().from(schema.providerRequestState),
    ).toEqual(safety)
    expect(
      await jobs.bulkCancelJobs(
        { jobIds: ['orphan'], confirmRunning: true },
        null,
      ),
    ).toMatchObject({ cancelled: 0, skipped: 1 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('recovers orphaned running work with one new ID, never reactivating the original', async () => {
    await seedJob('orphan', 'running')
    const jobs = await import('@/services/jobs')
    const retried = await jobs.bulkRetryJobs(
      { jobIds: ['orphan'], confirmBroadRun: false, confirmRunning: true },
      null,
    )
    expect(retried).toMatchObject({ queued: 1, skipped: 0 })
    const retryId = retried.results[0]?.retryJobId
    if (!retryId) throw new Error('Missing replacement')
    expect((await jobs.getJob('orphan'))?.status).toBe('cancelled')
    const retry = await jobs.getJob(retryId)
    expect(retry?.items.map((item) => item.mediaItemId)).toEqual(['film-0'])
    expect(retry?.scope.limit).toBe(1)
    expect(retry?.options).toMatchObject({
      retryOf: 'orphan',
      batchId: 'fixture',
    })
    expect(
      await jobs.bulkRetryJobs(
        { jobIds: ['orphan'], confirmBroadRun: false, confirmRunning: true },
        null,
      ),
    ).toMatchObject({ queued: 0, skipped: 1 })
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('checks aggregate broad confirmation before cancelling any running work', async () => {
    const jobs = await import('@/services/jobs')
    const jobIds = Array.from({ length: 6 }, (_, index) => `orphan-${index}`)
    for (const [index, id] of jobIds.entries())
      await seedJob(id, 'running', ['running'], index)
    const before = await Promise.all(jobIds.map((id) => jobs.getJob(id)))
    await expect(
      jobs.bulkRetryJobs(
        { jobIds, confirmBroadRun: false, confirmRunning: true },
        null,
      ),
    ).rejects.toHaveProperty('response.statusCode', 422)
    expect(await Promise.all(jobIds.map((id) => jobs.getJob(id)))).toEqual(
      before,
    )
  })

  it('does not cancel originals if safety or active selection guards reject the retry', async () => {
    const jobs = await import('@/services/jobs')
    await seedJob('orphan', 'running')
    await databaseClient
      .insert(schema.providerRequestState)
      .values({ provider: plugin.manifest.id, halted: true })
    const before = await jobs.getJob('orphan')
    expect(
      await jobs.bulkRetryJobs(
        { jobIds: ['orphan'], confirmBroadRun: false, confirmRunning: true },
        null,
      ),
    ).toMatchObject({ queued: 0, results: [{ status: 'failed' }] })
    expect(await jobs.getJob('orphan')).toEqual(before)
    await databaseClient.delete(schema.providerRequestState)
    await seedJob('other-active', 'queued')
    expect(
      await jobs.bulkRetryJobs(
        { jobIds: ['orphan'], confirmBroadRun: false, confirmRunning: true },
        null,
      ),
    ).toMatchObject({ queued: 0, skipped: 1 })
    expect(await jobs.getJob('orphan')).toEqual(before)
  })

  it.each(['success', 'error'])(
    'discards late worker %s and logs after cancellation',
    async (outcome) => {
      const entered = signal()
      const release = signal()
      execute.mockImplementationOnce(async (context) => {
        entered.release()
        await release.promise
        await context.log('info', 'Late worker log')
        if (outcome === 'error') throw new Error('Late worker failure')
        return result('Must never persist')
      })
      const jobs = await import('@/services/jobs')
      await seedJob('in-flight', 'queued')
      const worker = jobs.processQueuedJobs()
      try {
        await entered.promise
        await jobs.bulkCancelJobs(
          { jobIds: ['in-flight'], confirmRunning: true },
          null,
        )
        const cancelled = await jobs.getJob('in-flight')
        release.release()
        await worker
        expect(await jobs.getJob('in-flight')).toEqual(cancelled)
        expect(
          await databaseClient.select().from(schema.providerSnapshot),
        ).toEqual([])
        expect(
          await databaseClient.select().from(schema.providerCurrentState),
        ).toEqual([])
        expect(
          await databaseClient.select().from(schema.providerRequestState),
        ).toEqual([])
        expect(execute).toHaveBeenCalledTimes(1)
        expect(network).not.toHaveBeenCalled()
      } finally {
        release.release()
        await worker
      }
    },
  )

  it('an independent replacement worker can finish before the cancelled worker returns', async () => {
    const entered = signal()
    const release = signal()
    execute
      .mockImplementationOnce(async () => {
        entered.release()
        await release.promise
        return result('Stale original')
      })
      .mockResolvedValue(result('Fresh replacement'))
    const originalWorker = await import('@/services/jobs')
    await seedJob('in-flight', 'queued')
    const worker = originalWorker.processQueuedJobs()
    try {
      await entered.promise
      vi.resetModules()
      const replacementWorker = await import('@/services/jobs')
      const retried = await replacementWorker.bulkRetryJobs(
        { jobIds: ['in-flight'], confirmBroadRun: false, confirmRunning: true },
        null,
      )
      const retryId = retried.results[0]?.retryJobId
      if (!retryId) throw new Error('Missing replacement')
      await replacementWorker.processQueuedJobs()
      expect((await replacementWorker.getJob(retryId))?.status).toBe(
        'succeeded',
      )
      release.release()
      await worker
      expect((await replacementWorker.getJob('in-flight'))?.status).toBe(
        'cancelled',
      )
      const snapshots = await databaseClient
        .select()
        .from(schema.providerSnapshot)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.scrapeJobId).toBe(retryId)
      expect(snapshots[0]?.payload).toEqual({ title: 'Fresh replacement' })
      const film = await databaseClient.query.mediaItem.findFirst({
        where: eq(schema.mediaItem.id, 'film-0'),
      })
      expect(film?.title).toBe('Fresh replacement')
    } finally {
      release.release()
      await worker
    }
  })

  it('claims a queued job only once across independent workers', async () => {
    const first = await import('@/services/jobs')
    vi.resetModules()
    const second = await import('@/services/jobs')
    await seedJob('one-claim', 'queued')
    await Promise.all([first.processQueuedJobs(), second.processQueuedJobs()])
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await first.getJob('one-claim'))?.items[0]?.attemptCount).toBe(1)
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(1)
  })

  it('serializes cancellation behind an already-started result commit and preserves completed items', async () => {
    const committing = signal()
    const release = signal()
    const providerState = await import('@/services/provider-state')
    const apply = providerState.applyProviderResultInTransaction
    vi.spyOn(
      providerState,
      'applyProviderResultInTransaction',
    ).mockImplementation(async (input, tx) => {
      committing.release()
      await release.promise
      return apply(input, tx)
    })
    const jobs = await import('@/services/jobs')
    await seedJob('committing', 'queued')
    const worker = jobs.processQueuedJobs()
    try {
      await committing.promise
      let cancelled = false
      const cancellation = jobs
        .bulkCancelJobs({ jobIds: ['committing'], confirmRunning: true }, null)
        .then((result) => {
          cancelled = true
          return result
        })
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      expect(cancelled).toBe(false)
      release.release()
      await Promise.all([worker, cancellation])
      expect((await jobs.getJob('committing'))?.items[0]?.status).toBe(
        'succeeded',
      )
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toHaveLength(1)
      const before = await jobs.getJob('committing')
      expect(before?.status).not.toBe('running')
      expect(
        await jobs.bulkRetryJobs(
          {
            jobIds: ['committing'],
            confirmBroadRun: false,
            confirmRunning: true,
          },
          null,
        ),
      ).toMatchObject({ queued: 0, skipped: 1 })
    } finally {
      release.release()
      await worker
    }
  })

  it('keeps the in-flight request lease and spacing when retrying, and discards its HTTP result', async () => {
    const entered = signal()
    const release = signal()
    network.mockImplementationOnce(async () => {
      entered.release()
      await release.promise
      return Response.json({ fixture: true })
    })
    execute.mockImplementationOnce(async (context) => {
      await context.request('https://fixture.invalid/mock')
      return result('Must not persist')
    })
    const first = await import('@/services/jobs')
    await seedJob('requesting', 'queued')
    const worker = first.processQueuedJobs()
    try {
      await entered.promise
      const safety = await databaseClient
        .select()
        .from(schema.providerRequestState)
      expect(safety[0]?.leaseId).toBeTruthy()
      const retried = await first.bulkRetryJobs(
        {
          jobIds: ['requesting'],
          confirmBroadRun: false,
          confirmRunning: true,
        },
        null,
      )
      expect(retried.queued).toBe(1)
      expect(
        await databaseClient.select().from(schema.providerRequestState),
      ).toEqual(safety)
      vi.resetModules()
      const second = await import('@/services/jobs')
      await second.processQueuedJobs()
      expect(execute).toHaveBeenCalledTimes(1)
      release.release()
      await worker
      expect(
        await databaseClient.select().from(schema.providerSnapshot),
      ).toEqual([])
      const after = await databaseClient
        .select()
        .from(schema.providerRequestState)
      expect(after[0]?.nextAllowedAt).toEqual(safety[0]?.nextAllowedAt)
      expect(after[0]?.leaseId).toBeNull()
      expect(network).toHaveBeenCalledTimes(1)
    } finally {
      release.release()
      await worker
    }
  })

  it('concurrent running retries create only one replacement', async () => {
    const jobs = await import('@/services/jobs')
    await seedJob('orphan', 'running')
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        jobs.bulkRetryJobs(
          { jobIds: ['orphan'], confirmBroadRun: false, confirmRunning: true },
          null,
        ),
      ),
    )
    expect(results.reduce((sum, item) => sum + item.queued, 0)).toBe(1)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(2)
  })

  it('stops a cancelled worker waiting for spacing without clearing leases or spending a request', async () => {
    const entered = signal()
    execute.mockImplementationOnce(async (context) => {
      await databaseClient.insert(schema.providerRequestState).values({
        provider: plugin.manifest.id,
        nextAllowedAt: new Date(Date.now() + 60000),
      })
      entered.release()
      await context.request('https://fixture.invalid/never')
      return result()
    })
    const jobs = await import('@/services/jobs')
    await seedJob('waiting', 'queued')
    const worker = jobs.processQueuedJobs()
    await entered.promise
    const safety = await databaseClient
      .select()
      .from(schema.providerRequestState)
    await jobs.bulkCancelJobs(
      { jobIds: ['waiting'], confirmRunning: true },
      null,
    )
    await worker
    expect(network).not.toHaveBeenCalled()
    expect(
      await databaseClient.select().from(schema.providerRequestState),
    ).toEqual(safety)
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toEqual([])
    expect((await jobs.getJob('waiting'))?.status).toBe('cancelled')
  })
})
