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
import type { Job } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `job_batch_cancel_test_${randomUUID().replaceAll('-', '')}`
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
    id: 'fixture-batch',
    displayName: 'Fixture batch',
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
  execute.mockReset()
  network.mockReset().mockRejectedValue(new Error('Outbound network forbidden'))
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'film-0',
    slug: 'fixture-0',
    title: 'Fixture 0',
    mediaType: 'film',
  })
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

async function seedJobs(
  batchId: string,
  jobs: { id: string; status: Job['status']; items?: Job['status'][] }[],
) {
  await databaseClient.insert(schema.scrapeJob).values(
    jobs.map((job) => ({
      id: job.id,
      provider: plugin.manifest.id,
      status: job.status,
      scope: { mediaItemIds: ['film-0'], mediaType: 'film', limit: 1 },
      options: { batchId },
      createdAt: new Date('2026-01-01'),
    })),
  )
  await databaseClient.insert(schema.scrapeJobItem).values(
    jobs.flatMap((job) =>
      (job.items ?? [job.status]).map((status, index) => ({
        id: `${job.id}-${index}`,
        jobId: job.id,
        mediaItemId: 'film-0',
        provider: plugin.manifest.id,
        status,
        attemptCount: status === 'queued' ? 0 : 1,
      })),
    ),
  )
}

async function statusOf(id: string) {
  const [job] = await databaseClient
    .select({ status: schema.scrapeJob.status })
    .from(schema.scrapeJob)
    .where(eq(schema.scrapeJob.id, id))
  return job?.status
}

describe('batch cancellation', () => {
  it('cancels queued jobs, keeps finished ones and leaves running work without confirmation', async () => {
    const jobs = await import('@/services/jobs')
    await seedJobs('batch-a', [
      { id: 'queued-1', status: 'queued' },
      { id: 'queued-2', status: 'queued' },
      { id: 'running', status: 'running' },
      { id: 'done', status: 'succeeded' },
      { id: 'failed', status: 'failed' },
    ])
    await seedJobs('batch-b', [{ id: 'other', status: 'queued' }])
    const result = await jobs.cancelJobBatch(
      'batch-a',
      { confirmRunning: false },
      'reviewer',
    )
    expect(result).toMatchObject({ cancelled: 2, skipped: 1 })
    expect(result.results).toEqual([
      { jobId: 'queued-1', status: 'cancelled' },
      { jobId: 'queued-2', status: 'cancelled' },
      expect.objectContaining({ jobId: 'running', status: 'skipped' }),
    ])
    expect(await statusOf('running')).toBe('running')
    expect(await statusOf('done')).toBe('succeeded')
    expect(await statusOf('failed')).toBe('failed')
    expect(await statusOf('other')).toBe('queued')
    const cancelled = await jobs.getJob('queued-1')
    expect(cancelled?.items[0]?.status).toBe('cancelled')
    expect(cancelled?.options).toMatchObject({
      cancellation: { requestedByUser: true, userId: 'reviewer' },
    })
    expect(cancelled?.logs.at(-1)).toMatchObject({
      level: 'warn',
      metadata: { userId: 'reviewer' },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('cancels confirmed running jobs, keeping their finished items', async () => {
    const jobs = await import('@/services/jobs')
    await seedJobs('batch-a', [
      { id: 'running', status: 'running', items: ['succeeded', 'running'] },
      { id: 'queued', status: 'queued' },
      { id: 'done', status: 'succeeded' },
    ])
    const result = await jobs.cancelJobBatch(
      'batch-a',
      { confirmRunning: true },
      null,
    )
    expect(result).toMatchObject({ cancelled: 2, skipped: 0 })
    const running = await jobs.getJob('running')
    expect(running?.status).toBe('cancelled')
    expect(running?.items.map((item) => item.status)).toEqual([
      'succeeded',
      'cancelled',
    ])
    expect(await statusOf('done')).toBe('succeeded')
    expect(
      await jobs.cancelJobBatch('batch-a', { confirmRunning: true }, null),
    ).toEqual({ cancelled: 0, skipped: 0, results: [] })
    expect(execute).not.toHaveBeenCalled()
  })

  it('cancels a batch larger than one chunk', async () => {
    const jobs = await import('@/services/jobs')
    await seedJobs(
      'large',
      Array.from(
        { length: 501 },
        (_, index): { id: string; status: Job['status'] } => ({
          id: `queued-${String(index).padStart(3, '0')}`,
          status: 'queued',
        }),
      ),
    )
    const result = await jobs.cancelJobBatch(
      'large',
      { confirmRunning: false },
      null,
    )
    expect(result).toMatchObject({ cancelled: 501, skipped: 0 })
    expect(await statusOf('queued-500')).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('does nothing for an unknown batch', async () => {
    const jobs = await import('@/services/jobs')
    await seedJobs('batch-a', [{ id: 'queued', status: 'queued' }])
    expect(
      await jobs.cancelJobBatch('missing', { confirmRunning: true }, null),
    ).toEqual({ cancelled: 0, skipped: 0, results: [] })
    expect(await statusOf('queued')).toBe('queued')
  })
})
