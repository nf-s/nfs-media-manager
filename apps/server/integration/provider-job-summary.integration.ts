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
import { ProviderJobSummarySchema } from '@repo/schemas/provider'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `media_provider_jobs_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Network forbidden in provider summary tests')
})

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listProviderCatalog: async () => [{ id: 'fixture' }, { id: 'other' }],
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
  network.mockClear()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('provider job summary', () => {
  it('counts every status across libraries and tasks, excluding other providers', async () => {
    await databaseClient.insert(schema.scrapeJob).values([
      {
        id: 'queued-album',
        provider: 'fixture',
        status: 'queued',
        scope: { mediaType: 'album' },
        options: {},
      },
      {
        id: 'queued-film',
        provider: 'fixture',
        status: 'queued',
        scope: { mediaType: 'film' },
        options: {},
      },
      {
        id: 'running-task',
        provider: 'fixture',
        status: 'running',
        scope: {},
        options: { task: 'fixture-account-sync' },
      },
      {
        id: 'succeeded',
        provider: 'fixture',
        status: 'succeeded',
        scope: {},
        options: {},
      },
      {
        id: 'failed-dismissed',
        provider: 'fixture',
        status: 'failed',
        scope: {},
        options: { dismissal: { dismissedAt: '2026-01-01T00:00:00Z' } },
      },
      {
        id: 'cancelled',
        provider: 'fixture',
        status: 'cancelled',
        scope: {},
        options: {},
      },
      {
        id: 'other',
        provider: 'other',
        status: 'queued',
        scope: {},
        options: {},
      },
    ])
    const { getProviderJobSummary } =
      await import('@/services/provider-activity')
    const summary = ProviderJobSummarySchema.parse(
      await getProviderJobSummary('fixture'),
    )
    expect(summary).toEqual({
      provider: 'fixture',
      total: 6,
      queued: 2,
      running: 1,
      succeeded: 1,
      failed: 1,
      cancelled: 1,
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('returns zero counts for an unused provider and rejects unknown providers', async () => {
    const { getProviderJobSummary } =
      await import('@/services/provider-activity')
    expect(await getProviderJobSummary('fixture')).toEqual({
      provider: 'fixture',
      total: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    })
    await expect(getProviderJobSummary('unknown')).rejects.toThrow(
      'Provider not found',
    )
    expect(network).not.toHaveBeenCalled()
  })
})
