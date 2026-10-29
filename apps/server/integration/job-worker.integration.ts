import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
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
import type { Job } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import type { JobWorker } from '@/services/job-worker'

const database = `job_worker_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const dispatch = vi.fn<(shouldDispatch?: () => boolean) => Promise<void>>()
const fatal = vi.fn<(error: unknown) => void>()
const network = vi.fn<typeof fetch>()
const workers: JobWorker[] = []

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/services/jobs', () => ({
  processQueuedJobs: (shouldDispatch?: () => boolean) =>
    dispatch(shouldDispatch),
}))

function signal() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function start(pollIntervalMs = 60000) {
  const { startJobWorker } = await import('@/services/job-worker')
  const worker = await startJobWorker({ onFatal: fatal, pollIntervalMs })
  workers.push(worker)
  return worker
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
  dispatch.mockReset().mockResolvedValue(undefined)
  fatal.mockReset()
  network.mockReset().mockRejectedValue(new Error('Outbound network forbidden'))
  await databaseClient.delete(schema.providerCurrentState)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'film',
    slug: 'fixture',
    title: 'Retained fixture',
    mediaType: 'film',
  })
})
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
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
  status: Job['status'],
  statuses: Job['status'][] = [status],
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider: 'fixture',
    status,
    scope: { mediaItemIds: ['film'], mediaType: 'film', limit: 1 },
    options: { batchId: 'fixture', dismissedAt: '2026-01-02T00:00:00.000Z' },
    startedAt: status === 'queued' ? null : new Date('2026-01-01'),
  })
  await databaseClient.insert(schema.scrapeJobItem).values(
    statuses.map((itemStatus, index) => ({
      id: `${id}-${index}`,
      jobId: id,
      mediaItemId: 'film',
      provider: 'fixture',
      status: itemStatus,
      attemptCount: itemStatus === 'queued' ? 0 : 1,
      message: 'Retained message',
      payload: { retained: true },
      startedAt: itemStatus === 'queued' ? null : new Date('2026-01-01'),
    })),
  )
}

async function job(id: string) {
  return databaseClient.query.scrapeJob.findFirst({
    where: eq(schema.scrapeJob.id, id),
    with: {
      items: { orderBy: [schema.scrapeJobItem.id] },
      logs: { orderBy: [schema.scrapeJobLog.id] },
    },
  })
}

describe('exclusive worker lifecycle', () => {
  it('recovers running jobs/items once, preserving queued/completed rows and retained data', async () => {
    await seedJob('orphan', 'running', [
      'succeeded',
      'running',
      'queued',
      'failed',
      'cancelled',
    ])
    await seedJob('queued', 'queued')
    await seedJob('completed', 'succeeded')
    await databaseClient.insert(schema.scrapeJobLog).values({
      id: 'retained-log',
      jobId: 'orphan',
      level: 'info',
      message: 'Original result',
      metadata: { retained: true },
    })
    await databaseClient.insert(schema.providerSnapshot).values({
      id: 'snapshot',
      mediaItemId: 'film',
      provider: 'fixture',
      checksum: 'retained',
      payload: { retained: true },
      source: 'scrape',
      scrapeJobId: 'orphan',
    })
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'current',
      mediaItemId: 'film',
      provider: 'fixture',
      latestSnapshotId: 'snapshot',
      checksum: 'retained',
      payload: { retained: true },
      status: 'succeeded',
    })
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      halted: true,
      failureCount: 3,
      leaseId: 'retained',
      leaseUntil: new Date(Date.now() + 60000),
      cooldownUntil: new Date(Date.now() + 120000),
      nextAllowedAt: new Date(Date.now() + 30000),
      requests: [Date.now()],
    })
    const before = await job('orphan')
    const queued = await job('queued')
    const completed = await job('completed')
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    const current = await databaseClient
      .select()
      .from(schema.providerCurrentState)
    const safety = await databaseClient
      .select()
      .from(schema.providerRequestState)
    const media = await databaseClient.select().from(schema.mediaItem)

    const worker = await start()
    const recovered = await job('orphan')
    expect(recovered).toMatchObject({
      status: 'failed',
      options: before?.options,
      startedAt: before?.startedAt,
    })
    expect(recovered?.errorMessage).toMatch(/interrupted/)
    expect(recovered?.finishedAt).toBeInstanceOf(Date)
    expect(recovered?.items[1]).toMatchObject({
      status: 'failed',
      message: recovered?.errorMessage,
      attemptCount: 1,
      payload: { retained: true },
      startedAt: before?.items[1]?.startedAt,
      finishedAt: recovered?.finishedAt,
    })
    expect(recovered?.items[2]).toMatchObject({
      status: 'failed',
      message: recovered?.errorMessage,
      attemptCount: 0,
      startedAt: null,
      payload: { retained: true },
      finishedAt: recovered?.finishedAt,
    })
    for (const index of [0, 3, 4]) {
      expect(recovered?.items[index]).toEqual(before?.items[index])
    }
    expect(recovered?.logs).toHaveLength(2)
    expect(recovered?.logs).toEqual(
      expect.arrayContaining([
        ...(before?.logs ?? []),
        expect.objectContaining({
          level: 'error',
          message: recovered?.errorMessage,
          metadata: { reason: 'worker_interrupted' },
        }),
      ]),
    )
    expect(await job('queued')).toEqual(queued)
    expect(await job('completed')).toEqual(completed)
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toEqual(current)
    expect(
      await databaseClient.select().from(schema.providerRequestState),
    ).toEqual(safety)
    expect(await databaseClient.select().from(schema.mediaItem)).toEqual(media)
    expect(dispatch).not.toHaveBeenCalled()

    await worker.stop()
    await start()
    expect(await job('orphan')).toEqual(recovered)
    expect(await job('queued')).toEqual(queued)
    expect(dispatch).not.toHaveBeenCalled()
    expect(fatal).not.toHaveBeenCalled()
  })

  it('finalizes a running parent with already-succeeded items without changing saved results', async () => {
    await seedJob('saved', 'running', ['succeeded', 'succeeded'])
    await databaseClient.insert(schema.providerSnapshot).values({
      id: 'saved-snapshot',
      mediaItemId: 'film',
      provider: 'fixture',
      checksum: 'saved',
      payload: { retained: true },
      source: 'scrape',
      scrapeJobId: 'saved',
    })
    const before = await job('saved')
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    const worker = await start()
    const recovered = await job('saved')
    expect(recovered).toMatchObject({
      status: 'succeeded',
      errorMessage: null,
      items: before?.items,
      options: before?.options,
      startedAt: before?.startedAt,
    })
    expect(recovered?.finishedAt).toBeInstanceOf(Date)
    expect(recovered?.logs).toEqual([
      expect.objectContaining({
        level: 'info',
        metadata: { reason: 'worker_recovered_completed' },
      }),
    ])
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    await worker.stop()
    await start()
    expect(await job('saved')).toEqual(recovered)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('excludes a second owner before it can recover or dispatch anything', async () => {
    const first = await start()
    await seedJob('active', 'running')
    const active = await job('active')
    await expect(start(10)).rejects.toThrow('Another job worker')
    expect(await job('active')).toEqual(active)
    expect(dispatch).not.toHaveBeenCalled()
    expect(fatal).not.toHaveBeenCalled()
    await first.stop()
    await start()
    expect((await job('active'))?.status).toBe('failed')
  })

  it('stops dispatch synchronously, drains in-flight work, then releases ownership', async () => {
    const held = signal()
    const completed = signal()
    dispatch.mockImplementation(async (shouldDispatch) => {
      expect(shouldDispatch?.()).toBe(true)
      await held.promise
      expect(shouldDispatch?.()).toBe(false)
      completed.release()
    })
    const worker = await start(10)
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
      const stop = worker.stop()
      expect(worker.stop()).toBe(stop)
      expect(dispatch.mock.calls[0]?.[0]?.()).toBe(false)
      await expect(start()).rejects.toThrow('Another job worker')
      expect(dispatch).toHaveBeenCalledTimes(1)
      held.release()
      await completed.promise
      await stop
      const successor = await start()
      await successor.stop()
      expect(fatal).not.toHaveBeenCalled()
    } finally {
      held.release()
      await worker.stop()
    }
  })

  it('does not overlap dispatches across polling ticks', async () => {
    const held = signal()
    dispatch.mockImplementation(() => held.promise)
    const worker = await start(10)
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      held.release()
      await worker.stop()
    }
  })

  it('treats dispatch rejection as fatal and never restarts the dispatcher', async () => {
    const error = new Error('Fixture dispatch failed')
    dispatch.mockRejectedValue(error)
    const worker = await start(10)
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledExactlyOnceWith(error))
    await worker.stop()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('invokes fatal shutdown immediately on ownership connection loss while work drains', async () => {
    const held = signal()
    dispatch.mockImplementation(() => held.promise)
    const worker = await start(10)
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
      const owner = z
        .object({ rows: z.array(z.object({ pid: z.number() })).length(1) })
        .parse(
          await pool.query(`
          select pid from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = 614105
          and database = (select oid from pg_database where datname = current_database())
          and granted
        `),
        ).rows[0]
      if (!owner) throw new Error('Missing fixture worker session')
      await pool.query('select pg_terminate_backend($1)', [owner.pid])
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1))
      expect(dispatch.mock.calls[0]?.[0]?.()).toBe(false)
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      held.release()
      await worker.stop()
    }
    await start()
    expect(fatal).toHaveBeenCalledTimes(1)
  })

  it('locks running job rows and preserves completion committed before recovery gets the lock', async () => {
    await seedJob('finishing', 'running')
    const locked = signal()
    const commit = signal()
    const completion = databaseClient.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.scrapeJob)
        .where(eq(schema.scrapeJob.id, 'finishing'))
        .for('update')
      locked.release()
      await commit.promise
      await tx
        .update(schema.scrapeJobItem)
        .set({ status: 'succeeded' })
        .where(eq(schema.scrapeJobItem.jobId, 'finishing'))
      await tx
        .update(schema.scrapeJob)
        .set({ status: 'succeeded' })
        .where(eq(schema.scrapeJob.id, 'finishing'))
    })
    await locked.promise
    const startup = start()
    try {
      await vi.waitFor(async () => {
        const waiting = z
          .object({ rows: z.array(z.object({ waiting: z.boolean() })) })
          .parse(
            await pool.query(`select exists (
            select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
          ) as waiting`),
          )
        expect(waiting.rows[0]?.waiting).toBe(true)
      })
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      commit.release()
      await completion
      await startup
    }
    expect(await job('finishing')).toMatchObject({
      status: 'succeeded',
      logs: [],
    })
    expect((await job('finishing'))?.items[0]?.status).toBe('succeeded')
  })

  it('bounds a stalled ownership probe and destroys its session before fatal shutdown', async () => {
    let owner: pg.PoolClient | undefined
    pool.once('acquire', (client) => {
      owner = client
    })
    const worker = await start(10)
    if (!owner) throw new Error('Missing fixture ownership connection')
    const session = z
      .object({ rows: z.array(z.object({ pid: z.number() })).length(1) })
      .parse(await owner.query('select pg_backend_pid() as pid')).rows[0]
    if (!session) throw new Error('Missing fixture backend PID')
    const released = vi.fn()
    pool.on('release', released)
    // Occupy only the temporary worker session so its heartbeat cannot reply.
    const stalled = owner.query('select pg_sleep(30)').catch(() => {})
    try {
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1), {
        timeout: 8000,
        interval: 50,
      })
      expect(fatal.mock.calls[0]?.[0]).toMatchObject({
        message: 'Job worker ownership probe timed out.',
      })
      expect(released).toHaveBeenCalledWith(true, owner)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await pool.query('select pg_terminate_backend($1)', [session.pid])
      await stalled
      await worker.stop()
      pool.removeListener('release', released)
    }
  })

  it('fences late writes on a recovered job through the parent row status', async () => {
    await seedJob('orphan', 'running')
    await start()
    const recovered = await job('orphan')
    await databaseClient.transaction(async (tx) => {
      const [parent] = await tx
        .select()
        .from(schema.scrapeJob)
        .where(eq(schema.scrapeJob.id, 'orphan'))
        .for('update')
      if (parent?.status !== 'running') return
      await tx
        .update(schema.scrapeJobItem)
        .set({ status: 'succeeded' })
        .where(eq(schema.scrapeJobItem.jobId, 'orphan'))
      await tx.insert(schema.providerSnapshot).values({
        id: 'late-result',
        provider: 'fixture',
        mediaItemId: 'film',
        scrapeJobId: 'orphan',
        checksum: 'late',
        payload: {},
        source: 'scrape',
      })
    })
    expect(await job('orphan')).toEqual(recovered)
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
  })

  it('rolls recovery back and releases ownership when its audit log cannot be written', async () => {
    await seedJob('orphan', 'running')
    const before = await job('orphan')
    await pool.query(`create function reject_recovery_log() returns trigger language plpgsql as $$
      begin raise exception 'fixture log failure'; end;
    $$`)
    await pool.query(`create trigger reject_recovery before insert on scrape_job_log
      for each row execute function reject_recovery_log()`)
    try {
      await expect(start()).rejects.toThrow()
      expect(await job('orphan')).toEqual(before)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await pool.query('drop trigger reject_recovery on scrape_job_log')
      await pool.query('drop function reject_recovery_log()')
    }
    await start()
    expect((await job('orphan'))?.status).toBe('failed')
  })
})
