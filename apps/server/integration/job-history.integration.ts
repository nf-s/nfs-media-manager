import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { getJobDismissal, type Job } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `media_history_test_${randomUUID().replaceAll('-', '')}`
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
  throw new Error('Network forbidden in history tests')
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
vi.mock('@/plugins/registry', () => ({ getScrapePlugin: async () => plugin }))

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
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'film-1',
      mediaType: 'film',
      slug: 'fixture-film',
      title: 'Fixture film',
    },
    {
      id: 'film-2',
      mediaType: 'film',
      slug: 'other-film',
      title: 'Other film',
    },
  ])
  execute.mockClear()
  network.mockClear()
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
  mediaItemId = 'film-1',
  withItem = true,
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider: plugin.manifest.id,
    status,
    scope: { mediaItemIds: [mediaItemId], mediaType: 'film', limit: 1 },
    options: { batchId: 'fixture-batch' },
    errorMessage: 'Original error',
  })
  if (withItem)
    await databaseClient.insert(schema.scrapeJobItem).values({
      id: `${id}-item`,
      jobId: id,
      mediaItemId,
      provider: plugin.manifest.id,
      status,
      message: 'Original item error',
    })
  await databaseClient.insert(schema.scrapeJobLog).values({
    id: `${id}-log`,
    jobId: id,
    level: 'error',
    message: 'Original error',
    metadata: {
      error: {
        name: 'Error',
        message: 'Original error',
        stack: 'fixture stack',
        causes: [],
      },
    },
  })
}

describe('media job history and dismissal', () => {
  it('exposes exact-job snapshots without substituting other attempts or imports', async () => {
    const { getJobData } = await import('@/services/job-data')
    const { JobDataSchema } = await import('@repo/schemas/job')
    await seedJob('json-success', 'succeeded')
    await seedJob('json-failure', 'failed')
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'json-own',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'own',
        payload: { response: 'own' },
        source: 'scrape-job',
        scrapeJobId: 'json-success',
      },
      {
        id: 'json-import',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'import',
        payload: { response: 'imported' },
        source: 'legacy-import',
      },
    ])
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ payload: { response: 'own' } })
      .where(eq(schema.scrapeJobItem.id, 'json-success-item'))
    const success = JobDataSchema.parse(await getJobData('json-success'))
    expect(success.snapshots.map((snapshot) => snapshot.id)).toEqual([
      'json-own',
    ])
    expect(success.itemPayloads).toEqual([])
    expect(await getJobData('json-failure')).toEqual({
      jobId: 'json-failure',
      snapshots: [],
      diagnostics: [],
      itemPayloads: [],
    })
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('returns failure response diagnostics including empty JSON results', async () => {
    const { getJobData } = await import('@/services/job-data')
    const { listJobs } = await import('@/services/jobs')
    await seedJob('json-diagnostic', 'failed')
    await seedJob('json-other-diagnostic', 'failed')
    const diagnostics = [
      { stage: 'serply.response', evidence: { response: { results: [] } } },
    ]
    await databaseClient
      .update(schema.scrapeJobLog)
      .set({ metadata: { diagnostics } })
      .where(eq(schema.scrapeJobLog.id, 'json-diagnostic-log'))
    const data = await getJobData('json-diagnostic')
    expect(data.diagnostics).toEqual([
      {
        id: 'json-diagnostic-log',
        createdAt: expect.any(String),
        data: diagnostics,
      },
    ])
    expect((await getJobData('json-other-diagnostic')).diagnostics).toEqual([])
    const list = await listJobs({ q: 'json-diagnostic' })
    expect(list.items[0]?.logs[0]?.metadata).toEqual({})
    expect(network).not.toHaveBeenCalled()
  })

  it('returns legacy success item JSON when no snapshot was linked, including deleted media', async () => {
    const { getJobData } = await import('@/services/job-data')
    await seedJob('json-legacy', 'succeeded')
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ mediaItemId: null, payload: { original: [1, 2] } })
      .where(eq(schema.scrapeJobItem.id, 'json-legacy-item'))
    expect((await getJobData('json-legacy')).itemPayloads).toEqual([
      {
        id: 'json-legacy-item',
        mediaItemId: null,
        provider: plugin.manifest.id,
        payload: { original: [1, 2] },
      },
    ])
    await expect(getJobData('json-missing')).rejects.toHaveProperty(
      'response.statusCode',
      404,
    )
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps resolved attempts in history but removes them from attention without dismissing them', async () => {
    const { getJobActivity, listJobs, getJob } = await import('@/services/jobs')
    await seedJob('old-failure', 'failed')
    await seedJob('new-failure', 'failed')
    await seedJob('other-film', 'failed', 'film-2')
    await databaseClient
      .update(schema.scrapeJob)
      .set({
        createdAt: new Date('2020-01-01'),
        finishedAt: new Date('2020-01-02'),
      })
      .where(eq(schema.scrapeJob.id, 'old-failure'))
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'later-success',
      mediaItemId: 'film-1',
      provider: plugin.manifest.id,
      checksum: 'fixture',
      payload: {},
      status: 'succeeded',
      lastScrapedAt: new Date('2021-01-01'),
    })
    expect(
      (await listJobs({ status: 'attention' })).items
        .map((job) => job.id)
        .sort(),
    ).toEqual(['new-failure', 'other-film'])
    expect((await getJobActivity()).failed).toBe(2)
    expect((await listJobs({ status: 'failed' })).totalCount).toBe(3)
    expect((await getJob('old-failure'))?.options.dismissal).toBeUndefined()
  })

  it('does not resolve failures using another provider or import-only state', async () => {
    const { getJobActivity } = await import('@/services/jobs')
    await seedJob('unresolved', 'failed')
    await databaseClient.insert(schema.providerCurrentState).values([
      {
        id: 'other-provider',
        mediaItemId: 'film-1',
        provider: 'different',
        checksum: 'a',
        payload: {},
        status: 'succeeded',
        lastScrapedAt: new Date('2099-01-01'),
      },
      {
        id: 'import-only',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'b',
        payload: {},
        status: 'succeeded',
        lastSuccessfulAt: new Date('2099-01-01'),
      },
    ])
    expect((await getJobActivity()).failed).toBe(1)
  })
  it('retains the exact snapshot job link through the history response contract', async () => {
    const { getMediaHistory } = await import('@/services/history')
    const { MediaHistorySchema } = await import('@repo/schemas/media')
    await seedJob('snapshot-origin', 'succeeded')
    await seedJob('different-job', 'failed')
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'linked-snapshot',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'scraped-checksum',
        payload: { title: 'Fixture film' },
        source: 'scrape',
        scrapeJobId: 'snapshot-origin',
      },
      {
        id: 'imported-snapshot',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'imported-checksum',
        payload: { title: 'Fixture film' },
        source: 'legacy-import',
      },
    ])
    const history = MediaHistorySchema.parse(await getMediaHistory('film-1'))
    expect(
      history.events.find((event) => event.id === 'linked-snapshot'),
    ).toMatchObject({
      type: 'snapshot',
      jobId: 'snapshot-origin',
    })
    expect(
      history.events.find((event) => event.id === 'imported-snapshot'),
    ).toMatchObject({
      type: 'snapshot',
      jobId: null,
    })
    await databaseClient
      .delete(schema.scrapeJob)
      .where(eq(schema.scrapeJob.id, 'snapshot-origin'))
    const afterDeletion = MediaHistorySchema.parse(
      await getMediaHistory('film-1'),
    )
    expect(
      afterDeletion.events.find((event) => event.id === 'linked-snapshot'),
    ).toMatchObject({
      type: 'snapshot',
      jobId: null,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('includes failed, cancelled and scoped jobs without snapshots; filters before paginating', async () => {
    const { listJobs } = await import('@/services/jobs')
    await seedJob('failed-job', 'failed')
    await seedJob('cancelled-job', 'cancelled', 'film-1', false)
    await seedJob('success-job', 'succeeded')
    await seedJob('other-job', 'failed', 'film-2')
    // Legacy jobs may identify the film only through their item records.
    await databaseClient
      .update(schema.scrapeJob)
      .set({ scope: { mediaItemIds: [] } })
      .where(eq(schema.scrapeJob.id, 'failed-job'))
    const history = await listJobs({ mediaItemId: 'film-1', size: 2 })
    const next = await listJobs({ mediaItemId: 'film-1', size: 2, page: 2 })
    expect(history.totalCount).toBe(3)
    expect(history.pageCount).toBe(2)
    expect(history.items).toHaveLength(2)
    expect(next.items).toHaveLength(1)
    expect(
      [...history.items, ...next.items].map((job) => job.id).sort(),
    ).toEqual(['cancelled-job', 'failed-job', 'success-job'])
    expect(
      (await listJobs({ mediaItemId: 'film-1', status: 'failed' })).items.map(
        (job) => job.id,
      ),
    ).toEqual(['failed-job'])
    expect((await listJobs({ mediaItemId: 'missing-film' })).totalCount).toBe(0)
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled'])(
    'dismisses %s jobs without changing errors, history, or provider safety',
    async (status) => {
      const { dismissJob, getJobActivity, listJobs, getJob } =
        await import('@/services/jobs')
      const { JobStatusSchema } = await import('@repo/schemas/job')
      await seedJob('dismiss-me', JobStatusSchema.parse(status))
      await seedJob('keep-attention', 'failed')
      await databaseClient.insert(schema.providerRequestState).values({
        provider: plugin.manifest.id,
        halted: true,
        failureCount: 3,
        cooldownUntil: new Date(Date.now() + 3600000),
        nextAllowedAt: new Date(Date.now() + 2000),
        requests: [Date.now()],
        lastError: 'Too many requests',
      })
      const safetyBefore = await databaseClient
        .select()
        .from(schema.providerRequestState)
      const before = await getJob('dismiss-me')
      expect((await getJobActivity()).failed).toBe(2)
      const dismissed = await dismissJob('dismiss-me', 'reviewer')
      const dismissal = getJobDismissal(dismissed.options)
      expect(dismissal).toEqual({
        dismissedAt: expect.any(String),
        userId: 'reviewer',
      })
      expect(dismissed.status).toBe(status)
      expect(dismissed.errorMessage).toBe(before?.errorMessage)
      expect(dismissed.items).toEqual(before?.items)
      expect(dismissed.logs).toEqual(before?.logs)
      expect(dismissed.options.batchId).toBe('fixture-batch')
      expect((await getJobActivity()).failed).toBe(1)
      expect(
        (await listJobs({ status: 'attention' })).items.map((job) => job.id),
      ).toEqual(['keep-attention'])
      expect((await listJobs({ mediaItemId: 'film-1' })).totalCount).toBe(2)
      expect(
        getJobDismissal(
          (await dismissJob('dismiss-me', 'another-reviewer')).options,
        ),
      ).toEqual(dismissal)
      expect(
        await databaseClient.select().from(schema.providerRequestState),
      ).toEqual(safetyBefore)
      expect(execute).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
    },
  )

  it('rejects missing and non-failed jobs', async () => {
    const { dismissJob } = await import('@/services/jobs')
    await expect(dismissJob('missing', 'reviewer')).rejects.toHaveProperty(
      'response.statusCode',
      404,
    )
    for (const status of ['queued', 'running', 'succeeded']) {
      const { JobStatusSchema } = await import('@repo/schemas/job')
      await seedJob(status, JobStatusSchema.parse(status))
      await expect(dismissJob(status, 'reviewer')).rejects.toHaveProperty(
        'response.statusCode',
        409,
      )
    }
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('starts a retry undismissed and requires attention if that retry fails', async () => {
    const { dismissJob, retryJob, listJobs, getJobActivity } =
      await import('@/services/jobs')
    await seedJob('original', 'failed')
    await dismissJob('original', 'reviewer')
    const retry = await retryJob('original', null, false)
    expect(getJobDismissal(retry.options)).toBeNull()
    expect(retry.options.retryOf).toBe('original')
    expect(retry.options.benignReviewed).toBe(false)
    await databaseClient
      .update(schema.scrapeJob)
      .set({ status: 'failed' })
      .where(eq(schema.scrapeJob.id, retry.id))
    expect((await getJobActivity()).failed).toBe(1)
    expect(
      (await listJobs({ status: 'attention' })).items.map((job) => job.id),
    ).toEqual([retry.id])
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('does not inherit intentional cancellation when a new retry fails', async () => {
    const { bulkCancelJobs, retryJob, getJobActivity } =
      await import('@/services/jobs')
    await seedJob('cancelled-before-start', 'queued')
    await bulkCancelJobs(
      { jobIds: ['cancelled-before-start'], confirmRunning: false },
      'reviewer',
    )
    expect((await getJobActivity()).failed).toBe(0)
    const retry = await retryJob('cancelled-before-start', null, false)
    expect(retry.options.cancellation).toBeNull()
    await databaseClient
      .update(schema.scrapeJob)
      .set({ status: 'failed' })
      .where(eq(schema.scrapeJob.id, retry.id))
    expect((await getJobActivity()).failed).toBe(1)
  })

  it('continues excluding reviewed benign failures from attention without dismissing them', async () => {
    const { getJobActivity, listJobs } = await import('@/services/jobs')
    await seedJob('reviewed', 'failed')
    await databaseClient
      .update(schema.scrapeJob)
      .set({ options: { benignReviewed: true } })
      .where(eq(schema.scrapeJob.id, 'reviewed'))
    expect((await getJobActivity()).failed).toBe(0)
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)
    const history = await listJobs({ mediaItemId: 'film-1' })
    expect(history.totalCount).toBe(1)
    expect(history.items[0]?.options.dismissal).toBeUndefined()
  })
})
