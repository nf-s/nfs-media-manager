import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { connection } from '../scripts/cloud-helpers'
import { databaseClient } from '../scripts/cloud-database'
import { readDatabase } from '../scripts/production-status'
import { formatDatabase } from '../scripts/production-status-report'

vi.mock('@/lib/load-workspace-env', () => ({ loadWorkspaceEnv: () => {} }))

const database = `media_status_test_${randomUUID().replaceAll('-', '')}`
const credentials = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...credentials, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...credentials, database })
const fixture = drizzle(pool, { schema })
const url = new URL(
  `postgres://${credentials.host}:${credentials.port}/${database}`,
)
url.username = credentials.user
url.password = credentials.password
url.searchParams.set('sslmode', 'disable')
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600000)

let created = false
beforeAll(async () => {
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  const job = (
    id: string,
    provider: string,
    status: 'queued' | 'running' | 'failed' | 'succeeded',
    options: Record<string, string>,
    createdAt: Date,
  ): typeof schema.scrapeJob.$inferInsert => ({
    id,
    provider,
    status,
    scope: {},
    options,
    createdAt,
    startedAt: status === 'queued' ? null : createdAt,
    finishedAt:
      status === 'failed' || status === 'succeeded' ? hoursAgo(1) : null,
  })
  await fixture
    .insert(schema.scrapeJob)
    .values([
      job(
        'job-queued-old',
        'musicbrainz',
        'queued',
        { task: 'artist-enrichment' },
        hoursAgo(30),
      ),
      job(
        'job-queued-new',
        'musicbrainz',
        'queued',
        { task: 'artist-enrichment' },
        hoursAgo(2),
      ),
      job('job-running', 'discogs', 'running', {}, hoursAgo(1)),
      job(
        'job-failed',
        'fixture-private',
        'failed',
        { task: 'fixture-secret-task' },
        hoursAgo(3),
      ),
      job('job-succeeded', 'discogs', 'succeeded', {}, hoursAgo(3)),
    ])
  await fixture.insert(schema.providerRequestState).values({
    provider: 'fixture-private',
    halted: true,
  })
  await fixture.insert(schema.lastfmSync).values({
    username: 'fixture-listener',
    status: 'running',
    windowTo: 0,
    startedAt: hoursAgo(1),
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

it('reads queue counts, ages and blocked providers without private names', async () => {
  const status = await readDatabase(url.href)
  expect(status.jobs).toHaveLength(3)
  expect(
    status.jobs.find((row) => row.provider === 'musicbrainz'),
  ).toMatchObject({
    task: 'artist-enrichment',
    queued: 2,
    running: 0,
    failed: 0,
  })
  expect(status.jobs.find((row) => row.provider === 'discogs')).toMatchObject({
    task: null,
    queued: 0,
    running: 1,
  })
  expect(status.oldestQueued).toMatchObject([{ id: 'job-queued-old' }])
  expect(status.oldestQueued[0]?.ageSeconds).toBeGreaterThan(29 * 3600)
  expect(status.recentFailed.map((row) => row.id)).toEqual(['job-failed'])
  expect(status.providers).toMatchObject([{ halted: true }])
  expect(status.syncs).toMatchObject([
    { kind: 'lastfm', status: 'running', count: 1 },
  ])
  const output = formatDatabase(
    status,
    new Set(['musicbrainz', 'discogs']),
  ).join('\n')
  expect(output).toContain('Total: 2 queued, 1 running, 1 failed in 24h')
  expect(output).toContain('Oldest queued: job-queued-old')
  expect(output).toMatch(/private-[0-9a-f]{6} \/ task-[0-9a-f]{6}/)
  expect(output).not.toMatch(
    /fixture-private|fixture-secret-task|fixture-listener/,
  )
})

it('opens status sessions that refuse writes', async () => {
  const client = databaseClient(connection(url.href), 'production-status')
  await client.connect()
  try {
    await expect(
      client.query("update scrape_job set status = 'cancelled'"),
    ).rejects.toThrow(/read-only/)
  } finally {
    await client.end()
  }
  const unchanged = await pool.query<{ count: string }>(
    "select count(*)::text as count from scrape_job where status = 'cancelled'",
  )
  expect(unchanged.rows).toEqual([{ count: '0' }])
})
