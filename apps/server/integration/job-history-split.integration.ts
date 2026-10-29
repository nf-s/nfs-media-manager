import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { asc, eq, sql } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { JobStatusSchema } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { splitJobHistory } from '@/services/job-history-split'
import {
  parseJobHistorySplitArguments,
  splitJobHistoryCli,
} from '../scripts/split-job-history'

const name = `job_split_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const database = drizzle(pool, { schema })
let created = false
let directory: string
const network = vi.fn(() => {
  throw new Error('Network forbidden in history split tests')
})
const statuses = ['succeeded', 'failed', 'cancelled', 'queued', 'running'].map(
  (status) => JobStatusSchema.parse(status),
)
const originalOptions = {
  batchId: 'retained-batch',
  dismissal: { dismissedAt: '2026-01-01T00:00:00.000Z', userId: null },
  custom: { keep: [1, true, null, 'raw'] },
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  directory = await mkdtemp(join(tmpdir(), 'job-history-split-'))
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await database.transaction(async (tx) => {
    for (const migration of readMigrationFiles({
      migrationsFolder: './drizzle',
    }))
      for (const statement of migration.sql)
        await tx.execute(sql.raw(statement))
    // Exercise legacy database-only references not present in today's ORM schema.
    await tx.execute(
      sql`alter table provider_cooldown_reset add column if not exists scrape_job_id text references scrape_job(id)`,
    )
  })
})

beforeEach(async () => {
  await database.execute(sql`delete from provider_cooldown_reset`)
  await database.delete(schema.providerCurrentState)
  await database.delete(schema.providerSnapshot)
  await database.delete(schema.scrapeJob)
  await database.delete(schema.mediaItem)
  network.mockClear()
  await database.insert(schema.mediaItem).values(
    statuses.map<typeof schema.mediaItem.$inferInsert>((_, index) => ({
      id: `media-${index}`,
      slug: `media-${index}`,
      title: `Media ${index}`,
      mediaType: index === 1 ? 'album' : 'film',
    })),
  )
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  if (directory) await rm(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function seedJob(
  id: string,
  status: typeof schema.scrapeJob.$inferSelect.status = 'failed',
  indices = [0, 1, 2, 3, 4],
  options: typeof schema.scrapeJob.$inferSelect.options = originalOptions,
) {
  await database.insert(schema.scrapeJob).values({
    id,
    provider: 'fixture-provider',
    status,
    scope: {
      mediaItemIds: indices.map((index) => `media-${index}`),
      mediaType: 'film',
      limit: 99,
      legacy: 'scope',
    },
    options,
    errorMessage: 'Legacy batch error',
    confirmBroadRun: true,
  })
  // Reverse insertion order; stable item order must use persisted timestamps/IDs.
  for (const index of [...indices].reverse()) {
    const itemStatus = statuses[index]
    if (!itemStatus) throw new Error('Missing fixture status')
    await database.insert(schema.scrapeJobItem).values({
      id: `${id}-item-${index}`,
      jobId: id,
      mediaItemId: `media-${index}`,
      provider: 'fixture-provider',
      status: itemStatus,
      attemptCount: index + 1,
      message: `Item ${index} result`,
      payload: { index, result: [null, true, { retained: 'payload' }] },
    })
  }
  await database.execute(sql`update scrape_job set
    created_at = '2026-01-01 01:02:03.123456', updated_at = '2026-01-02 01:02:03.654321',
    started_at = '2026-01-01 02:03:04.123456', finished_at = '2026-01-01 03:04:05.654321'
    where id = ${id}`)
  await database.execute(sql`update scrape_job_item set
    created_at = '2026-01-01 01:02:03.123456', updated_at = '2026-01-02 01:02:03.654321',
    started_at = '2026-01-01 02:03:04.123456', finished_at = '2026-01-01 03:04:05.654321'
    where job_id = ${id}`)
}

async function capture() {
  const result = []
  for (const table of [
    'scrape_job',
    'scrape_job_item',
    'scrape_job_log',
    'provider_snapshot',
    'provider_current_state',
    'provider_cooldown_reset',
  ]) {
    const rows = await database.execute(
      sql`select to_jsonb(t) as row from ${sql.identifier(table)} t order by id`,
    )
    result.push({ table, rows: rows.rows })
  }
  return result
}

async function payloadHashes() {
  const items = await database.execute(
    sql`select id, md5(payload::text) as hash from scrape_job_item order by id`,
  )
  const snapshots =
    await database.execute(sql`select id, md5(payload::text) as payload_hash,
    md5(coalesce(normalized_data::text, 'null')) as normalized_hash, checksum, source,
    media_item_id, provider, created_at::text from provider_snapshot order by id`)
  return { items: items.rows, snapshots: snapshots.rows }
}

describe('offline historical multi-item job split', () => {
  it('preserves every item, raw payload hash, snapshot and original log ID while remapping media history', async () => {
    await seedJob('legacy')
    await seedJob('single', 'failed', [1])
    const [singleBefore] = await database
      .select()
      .from(schema.scrapeJob)
      .where(eq(schema.scrapeJob.id, 'single'))
    const singleItemsBefore = await database
      .select()
      .from(schema.scrapeJobItem)
      .where(eq(schema.scrapeJobItem.jobId, 'single'))
    await database.insert(schema.providerSnapshot).values(
      statuses.flatMap((_, index) =>
        [0, 1].map((version) => ({
          id: `snapshot-${index}-${version}`,
          mediaItemId: `media-${index}`,
          provider: 'fixture-provider',
          checksum: `checksum-${index}-${version}`,
          source: 'scrape',
          scrapeJobId: 'legacy',
          payload: { index, version, raw: ['keep', null, { nested: true }] },
          normalizedData: { title: 'Unchanged' },
        })),
      ),
    )
    await database.insert(schema.providerCurrentState).values({
      id: 'current',
      mediaItemId: 'media-1',
      provider: 'fixture-provider',
      latestSnapshotId: 'snapshot-1-1',
      checksum: 'current-checksum',
      payload: { untouched: true },
      status: 'succeeded',
    })
    await database.execute(sql`insert into provider_cooldown_reset (id, provider, previous_cooldown_until, scrape_job_id)
      values ('cooldown', 'fixture-provider', '2026-01-01', 'legacy')`)
    await database.insert(schema.scrapeJobLog).values([
      {
        id: 'scoped',
        jobId: 'legacy',
        level: 'error',
        message: 'Item error',
        metadata: {
          mediaItemId: 'media-1',
          error: { stack: 'retained stack' },
        },
      },
      {
        id: 'first-scoped',
        jobId: 'legacy',
        level: 'info',
        message: 'First item',
        metadata: { mediaItemId: 'media-0' },
      },
      {
        id: 'shared',
        jobId: 'legacy',
        level: 'warn',
        message: 'Shared context',
        metadata: { custom: ['legacy'], jobHistorySplit: 'older audit' },
      },
      {
        id: 'shared-null',
        jobId: 'legacy',
        level: 'info',
        message: 'Started',
        metadata: null,
      },
    ])
    await database.execute(
      sql`update scrape_job_log set created_at = '2026-01-01 01:02:03.123456'`,
    )
    const hashesBefore = await payloadHashes()
    const itemsBefore = await database
      .select()
      .from(schema.scrapeJobItem)
      .orderBy(asc(schema.scrapeJobItem.id))
    const logsBefore = await database
      .select()
      .from(schema.scrapeJobLog)
      .orderBy(asc(schema.scrapeJobLog.id))
    const statesBefore = await database
      .select()
      .from(schema.providerCurrentState)
    const before = await capture()
    const dry = await splitJobHistory(database)
    expect(dry).toMatchObject({
      applied: false,
      blockers: [],
      counts: {
        originalJobs: 1,
        items: 5,
        newJobs: 4,
        cancelledStaleItems: 2,
        movedSnapshots: 8,
        movedLogs: 1,
        copiedSharedLogs: 8,
      },
    })
    expect(await capture()).toEqual(before)
    const result = await splitJobHistory(database, { apply: true })
    expect(result.applied).toBe(true)
    expect(result.mapping[0]).toMatchObject({
      itemId: 'legacy-item-0',
      jobId: 'legacy',
    })
    expect(result.references).toContainEqual({
      schema: 'public',
      table: 'provider_cooldown_reset',
      column: 'scrape_job_id',
      affectedRows: 1,
    })
    const jobs = await database.select().from(schema.scrapeJob)
    const snapshots = await database.select().from(schema.providerSnapshot)
    const logs = await database.select().from(schema.scrapeJobLog)
    expect(jobs).toHaveLength(6)
    expect(snapshots).toHaveLength(10)
    expect(await payloadHashes()).toEqual(hashesBefore)
    expect(await database.select().from(schema.providerCurrentState)).toEqual(
      statesBefore,
    )
    expect(
      (
        await database.execute(
          sql`select scrape_job_id from provider_cooldown_reset where id = 'cooldown'`,
        )
      ).rows,
    ).toEqual([{ scrape_job_id: 'legacy' }])
    expect(jobs.find((job) => job.id === 'single')).toEqual(singleBefore)
    expect(
      await database
        .select()
        .from(schema.scrapeJobItem)
        .where(eq(schema.scrapeJobItem.jobId, 'single')),
    ).toEqual(singleItemsBefore)
    for (const entry of result.mapping) {
      const job = jobs.find((row) => row.id === entry.jobId)
      expect(job).toMatchObject({
        status: entry.status,
        confirmBroadRun: true,
        scope: {
          mediaItemIds: [entry.mediaItemId],
          mediaType: entry.mediaType,
          limit: 1,
        },
        options: {
          ...originalOptions,
          jobHistorySplit: {
            originalJobId: 'legacy',
            originalStatus: 'failed',
            originalErrorMessage: 'Legacy batch error',
            originalOptions,
          },
        },
      })
      const assigned = await database
        .select()
        .from(schema.scrapeJobItem)
        .where(eq(schema.scrapeJobItem.jobId, entry.jobId))
      const original = itemsBefore.find((item) => item.id === entry.itemId)
      expect(assigned).toEqual([
        { ...original, jobId: entry.jobId, status: entry.status },
      ])
      expect(
        snapshots
          .filter((snapshot) => snapshot.mediaItemId === entry.mediaItemId)
          .map((snapshot) => snapshot.scrapeJobId),
      ).toEqual([entry.jobId, entry.jobId])
      const timestamps = await database.execute(
        sql`select created_at::text, updated_at::text, started_at::text, finished_at::text from scrape_job where id = ${entry.jobId}`,
      )
      expect(timestamps.rows).toEqual([
        {
          created_at: '2026-01-01 01:02:03.123456',
          updated_at: '2026-01-02 01:02:03.654321',
          started_at: '2026-01-01 02:03:04.123456',
          finished_at: '2026-01-01 03:04:05.654321',
        },
      ])
    }
    for (const original of logsBefore) {
      const moved = logs.find((log) => log.id === original.id)
      expect(moved).toEqual({
        ...original,
        jobId:
          original.id === 'scoped'
            ? result.mapping.find((entry) => entry.mediaItemId === 'media-1')
                ?.jobId
            : original.jobId,
      })
    }
    expect(logs).toHaveLength(12)
    for (const copy of logs.filter(
      (log) => !logsBefore.some((original) => original.id === log.id),
    )) {
      expect(copy.metadata?.jobHistorySplit).toMatchObject({
        context: 'legacy-batch',
        originalJobId: 'legacy',
      })
      expect(copy.createdAt).toEqual(logsBefore[0]?.createdAt)
    }
    const after = await capture()
    const again = await splitJobHistory(database, { apply: true })
    expect(Object.values(again.counts)).toEqual(
      Object.values(again.counts).map(() => 0),
    )
    expect(again.mapping).toEqual([])
    expect(await capture()).toEqual(after)
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['succeeded', 'failed', 'cancelled'])(
    'derives item status under terminal %s parents and supplies a batch ID',
    async (status) => {
      await seedJob('terminal', JobStatusSchema.parse(status), undefined, {})
      await splitJobHistory(database, { apply: true })
      const jobs = await database.select().from(schema.scrapeJob)
      expect(jobs.map((job) => job.status).sort()).toEqual(
        ['succeeded', 'failed', 'cancelled', 'cancelled', 'cancelled'].sort(),
      )
      expect(jobs.every((job) => job.options.batchId === 'terminal')).toBe(true)
    },
  )

  it('rewires retry chains by media identity and audits unknown or mismatched relationships', async () => {
    await seedJob('a', 'failed', [0, 1], { retryJobId: 'b' })
    await seedJob('b', 'cancelled', [1, 2], { retryOf: 'a', retryJobId: 'c' })
    await seedJob('c', 'succeeded', [1, 2], {
      retryOf: 'b',
      retryJobId: { unknown: 'relationship' },
    })
    const result = await splitJobHistory(database, { apply: true })
    const jobs = await database.select().from(schema.scrapeJob)
    const mapped = (parent: string, media: string) =>
      result.mapping.find(
        (entry) =>
          entry.originalJobId === parent && entry.mediaItemId === media,
      )?.jobId
    expect(
      jobs.find((job) => job.id === mapped('a', 'media-1'))?.options.retryJobId,
    ).toBe(mapped('b', 'media-1'))
    expect(
      jobs.find((job) => job.id === mapped('b', 'media-1'))?.options.retryOf,
    ).toBe(mapped('a', 'media-1'))
    expect(
      jobs.find((job) => job.id === mapped('a', 'media-0'))?.options.retryJobId,
    ).toBeUndefined()
    expect(
      jobs.find((job) => job.id === mapped('b', 'media-2'))?.options.retryOf,
    ).toBeUndefined()
    expect(result.counts.clearedRetryLinks).toBe(4)
    for (const job of jobs) {
      for (const key of ['retryOf', 'retryJobId']) {
        const targetId = job.options[key]
        if (targetId === undefined) continue
        expect(
          jobs.find((target) => target.id === targetId)?.scope.mediaItemIds,
        ).toEqual(job.scope.mediaItemIds)
      }
    }
    expect(
      jobs.find((job) => job.id === mapped('c', 'media-1'))?.options
        .jobHistorySplit,
    ).toMatchObject({
      originalOptions: {
        retryOf: 'b',
        retryJobId: { unknown: 'relationship' },
      },
    })
  })

  it.each(['queued', 'running'])(
    'atomically refuses a %s multi-item job alongside terminal jobs',
    async (status) => {
      await seedJob('terminal')
      await seedJob('active', JobStatusSchema.parse(status))
      const before = await capture()
      expect((await splitJobHistory(database)).blockers).toContain(
        `Active multi-item job active (${status}); resolve separately.`,
      )
      await expect(splitJobHistory(database, { apply: true })).rejects.toThrow(
        'Active multi-item job',
      )
      expect(await capture()).toEqual(before)
    },
  )

  it('refuses ambiguous/deleted identities and unsafe inbound retries without changing single jobs', async () => {
    await seedJob('legacy')
    await seedJob('single', 'failed', [1], { retryOf: 'legacy' })
    const before = await capture()
    await expect(splitJobHistory(database, { apply: true })).rejects.toThrow(
      'Untouched job single.retryOf',
    )
    expect(await capture()).toEqual(before)
    await database
      .delete(schema.scrapeJob)
      .where(eq(schema.scrapeJob.id, 'single'))
    await database
      .update(schema.scrapeJobItem)
      .set({ mediaItemId: 'media-0' })
      .where(eq(schema.scrapeJobItem.id, 'legacy-item-1'))
    await expect(splitJobHistory(database, { apply: true })).rejects.toThrow(
      'duplicate media identity',
    )
    await database
      .update(schema.scrapeJobItem)
      .set({ mediaItemId: null })
      .where(eq(schema.scrapeJobItem.id, 'legacy-item-1'))
    await expect(splitJobHistory(database, { apply: true })).rejects.toThrow(
      'no surviving media identity',
    )
  })

  it('holds the queue advisory lock and rolls back all changes on a late SQL failure', async () => {
    await seedJob('legacy')
    await database.insert(schema.providerSnapshot).values({
      id: 'reject',
      mediaItemId: 'media-1',
      provider: 'fixture-provider',
      payload: { keep: true },
      checksum: 'keep',
      source: 'scrape',
      scrapeJobId: 'legacy',
    })
    await database.execute(
      sql`create function reject_split_snapshot() returns trigger language plpgsql as $$ begin raise exception 'fixture late failure'; end $$`,
    )
    await database.execute(
      sql`create trigger reject_split before update on provider_snapshot for each row execute function reject_split_snapshot()`,
    )
    const before = await capture()
    try {
      await expect(
        splitJobHistory(database, {
          apply: true,
          async writeReport() {
            const other = await pool.connect()
            try {
              const lock = await other.query(
                'select pg_try_advisory_lock(614104) as acquired',
              )
              expect(lock.rows).toEqual([{ acquired: false }])
            } finally {
              await other.query('select pg_advisory_unlock_all()')
              other.release()
            }
          },
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'fixture late failure' }),
      })
      expect(await capture()).toEqual(before)
    } finally {
      await database.execute(
        sql`drop trigger reject_split on provider_snapshot`,
      )
      await database.execute(sql`drop function reject_split_snapshot()`)
    }
  })

  it('requires fresh mode-600 reports, defaults to dry-run and writes the plan before apply', async () => {
    await seedJob('legacy')
    expect(() => parseJobHistorySplitArguments([])).toThrow('--report')
    expect(() =>
      parseJobHistorySplitArguments(['--report=x', '--apply', '--apply']),
    ).toThrow('repeated')
    expect(() =>
      parseJobHistorySplitArguments(['--report=x', '--unknown']),
    ).toThrow('Unknown')
    const path = join(directory, 'preview.json')
    const before = await capture()
    const dry = await splitJobHistoryCli([`--report=${path}`], database)
    expect(dry.applied).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      mode: 'dry-run',
      applied: false,
      counts: { items: 5 },
    })
    expect(await capture()).toEqual(before)
    await expect(
      splitJobHistoryCli([`--report=${path}`, '--apply'], database),
    ).rejects.toThrow('EEXIST')
    expect(await capture()).toEqual(before)
    await expect(
      splitJobHistory(database, {
        apply: true,
        writeReport: async () => {
          throw new Error('disk failure')
        },
      }),
    ).rejects.toThrow('disk failure')
    expect(await capture()).toEqual(before)
    const applyPath = join(directory, 'apply.json')
    const result = await splitJobHistoryCli(
      [`--report=${applyPath}`, '--apply'],
      database,
    )
    expect(result.applied).toBe(true)
    expect((await stat(applyPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(applyPath, 'utf8'))).toMatchObject({
      mode: 'apply',
      applied: false,
      mapping: result.mapping,
    })
    expect(network).not.toHaveBeenCalled()
  })
})
