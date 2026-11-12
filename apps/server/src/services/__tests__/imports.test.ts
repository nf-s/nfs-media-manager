import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const mocks = vi.hoisted(() => {
  const database = { select: vi.fn(), update: vi.fn(), insert: vi.fn() }
  return {
    database,
    transaction: vi.fn(),
    connect: vi.fn(),
    stat: vi.fn(),
    commitFilm: vi.fn(),
    commitAlbum: vi.fn(),
    enrichment: vi.fn(),
    where: vi.fn<(condition: SQL) => void>(),
    environment: { RUNTIME_KIND: 'cloudflare', LEGACY_SERVER_DATA_DIR: 'data' },
  }
})
vi.mock('@/lib/db', () => ({
  db: {
    ...mocks.database,
    transaction: mocks.transaction,
    $client: { connect: mocks.connect },
  },
}))
vi.mock('@/env', () => ({ env: mocks.environment }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }))
vi.mock('../film-imports', () => ({
  commitQueuedFilmImportRow: mocks.commitFilm,
}))
vi.mock('../album-imports', () => ({
  commitQueuedAlbumImportRow: mocks.commitAlbum,
}))
vi.mock('../film-enrichment', () => ({
  queueMediaEnrichment: mocks.enrichment,
}))

import { filmImportPreview, libraryImport, scrapeJobItem } from '@/schemas/db'
import { withCloudQueue } from '@/lib/runtime'
import {
  dispatchQueuedImports,
  executeQueuedImport,
  getImportStatus,
  startLibraryImport,
  startManagedImport,
  startQueuedImport,
  type QueuedImportTask,
} from '../imports'

const TestRunSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    stage: z.string(),
    result: z.unknown(),
    requestedByUserId: z.string().nullable(),
    createdAt: z.date().default(() => new Date()),
    processed: z.number().default(0),
    total: z.number().default(0),
    errorMessage: z.string().nullable().default(null),
    finishedAt: z.date().nullable().default(null),
  })
  .passthrough()
let run: z.infer<typeof TestRunSchema> | undefined
let claimed = false
let existingJobs: Array<{ mediaItemId: string; provider: string }> = []
const preview = {
  id: 'preview',
  kind: 'csv',
  requestedByUserId: 'owner',
  records: [],
  claimed: true,
}
const tx = { ...mocks.database, transaction: mocks.transaction }

function query(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {
    where: vi.fn((condition: SQL) => {
      mocks.where(condition)
      return result
    }),
    returning: vi.fn(),
    for: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    innerJoin: vi.fn(),
  })
  for (const method of [
    result.returning,
    result.for,
    result.orderBy,
    result.limit,
    result.innerJoin,
  ])
    method.mockReturnValue(result)
  return result
}
function currentRun() {
  if (!run) throw new Error('Missing execution record')
  return run
}
function task(overrides: Partial<QueuedImportTask> = {}): QueuedImportTask {
  return {
    version: 1,
    mediaType: 'film',
    previewId: 'preview',
    rows: [0],
    providers: [],
    confirmBroadRun: false,
    ...overrides,
  }
}
function counts() {
  return z
    .object({
      cursor: z.number(),
      created: z.number(),
      unchanged: z.number(),
      failed: z.number(),
      newIds: z.array(z.string()),
    })
    .parse(currentRun().result)
}

describe('durable cloud imports (mock persistence only)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    run = undefined
    claimed = false
    mocks.environment.RUNTIME_KIND = 'cloudflare'
    existingJobs = []
    mocks.transaction.mockImplementation(
      async (execute: (database: typeof tx) => Promise<unknown>) => execute(tx),
    )
    mocks.database.select.mockImplementation(() => ({
      from: (table: unknown) =>
        query(
          table === libraryImport
            ? run
              ? [run]
              : []
            : table === scrapeJobItem
              ? existingJobs
              : [preview],
        ),
    }))
    mocks.database.insert.mockImplementation(() => ({
      values: async (value: unknown) => {
        run = TestRunSchema.parse(value)
      },
    }))
    mocks.database.update.mockImplementation((table: unknown) => ({
      set: (value: Record<string, unknown>) => {
        if (table === filmImportPreview) {
          const rows = claimed ? [] : [{ id: 'preview' }]
          claimed = true
          return query(rows)
        }
        if (run) Object.assign(run, value)
        return query([])
      },
    }))
    mocks.commitFilm.mockResolvedValue({ id: 'new-film', action: 'new' })
    mocks.commitAlbum.mockResolvedValue({ id: 'new-album', action: 'new' })
    mocks.enrichment.mockResolvedValue({ queued: 1, skipped: 0, warnings: [] })
  })

  it('persists a serializable task, claims its owner-bound unexpired preview, and sends only an ID', async () => {
    const send = vi.fn(async () => undefined)
    const result = await withCloudQueue({ send }, () =>
      startQueuedImport('owner', task({ rows: [2, 4] })),
    )
    expect(result.status).toBe('queued')
    expect(currentRun().result).toMatchObject({
      task: task({ rows: [2, 4] }),
      cursor: 0,
    })
    expect(send).toHaveBeenCalledWith({ type: 'import', importId: result.id })
    expect(JSON.parse(JSON.stringify(currentRun().result))).toEqual(
      currentRun().result,
    )
    const predicate = mocks.where.mock.calls[0]?.[0]
    if (!predicate) throw new Error('Missing claim predicate')
    expect(new PgDialect().sqlToQuery(predicate).params).toEqual(
      expect.arrayContaining(['preview', false, 'owner', 'csv']),
    )
    expect(mocks.commitFilm).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('fails closed when the invocation has no queue binding', async () => {
    await expect(startQueuedImport('owner', task())).rejects.toThrow(
      'queue is unavailable',
    )
    expect(mocks.database.insert).not.toHaveBeenCalled()
    expect(claimed).toBe(false)
  })

  it('limits recovery to serialized unfinished tasks, excluding legacy closure-based imports', async () => {
    const selected = query([])
    mocks.database.select.mockReturnValue({ from: () => selected })
    const send = vi.fn(async () => undefined)
    await withCloudQueue({ send }, dispatchQueuedImports)
    const predicate = mocks.where.mock.calls[0]?.[0]
    if (!predicate) throw new Error('Missing recovery predicate')
    const statement = new PgDialect().sqlToQuery(predicate)
    expect(statement.sql).toContain('"library_import"."result" ? \'task\'')
    expect(statement.params).toEqual(['queued', 'running'])
    expect(selected.limit).toHaveBeenCalledWith(100)
    expect(send).not.toHaveBeenCalled()
    expect(mocks.commitFilm).not.toHaveBeenCalled()
    expect(mocks.enrichment).not.toHaveBeenCalled()
  })

  it('retains an ambiguous queue send as an outbox record and republishes through the recovery sweep', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValue(undefined)
    await withCloudQueue({ send }, async () => {
      await startQueuedImport('owner', task())
      expect(currentRun().status).toBe('queued')
      expect(currentRun().stage).toBe('Awaiting queue delivery')
      expect(claimed).toBe(true)
      await expect(startQueuedImport('owner', task())).rejects.toThrow(
        'already used',
      )
      await dispatchQueuedImports()
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1])
  })

  it('awaits selected rows, checkpoints in the same transaction, and ignores completed redelivery', async () => {
    await withCloudQueue({ send: vi.fn() }, async () => {
      await startQueuedImport('owner', task({ rows: [3, 7] }))
      await executeQueuedImport(currentRun().id)
      await executeQueuedImport(currentRun().id)
    })
    expect(mocks.commitFilm.mock.calls.map((call) => call[1])).toEqual([3, 7])
    expect(mocks.commitFilm).toHaveBeenCalledWith(preview.records, 3, tx)
    expect(counts()).toMatchObject({ cursor: 2, created: 2, failed: 0 })
    expect(currentRun().status).toBe('succeeded')
    expect(mocks.enrichment).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('bounds deliveries to twenty rows and resumes instead of replaying their canonical writes', async () => {
    const send = vi.fn(async () => undefined)
    await withCloudQueue({ send }, async () => {
      await startQueuedImport(
        'owner',
        task({ rows: Array.from({ length: 23 }, (_, row) => row) }),
      )
      await executeQueuedImport(currentRun().id)
      expect(counts().cursor).toBe(20)
      expect(currentRun().status).toBe('running')
      expect(send).toHaveBeenCalledTimes(2)
      await executeQueuedImport(currentRun().id)
    })
    expect(counts().cursor).toBe(23)
    expect(mocks.commitFilm).toHaveBeenCalledTimes(23)
    expect(currentRun().status).toBe('succeeded')
  })

  it('queues only explicitly selected providers for newly created records', async () => {
    mocks.commitFilm.mockResolvedValueOnce({
      id: 'existing',
      action: 'unchanged',
    })
    await withCloudQueue({ send: vi.fn() }, async () => {
      await startQueuedImport(
        'owner',
        task({ rows: [0, 1], providers: ['tmdb'] }),
      )
      await executeQueuedImport(currentRun().id)
    })
    expect(mocks.enrichment).toHaveBeenCalledWith(
      [{ mediaItemId: 'new-film', provider: 'tmdb' }],
      'owner',
      expect.objectContaining({
        batchId: 'preview',
        mediaType: 'film',
        missingOnly: true,
      }),
    )
    expect(counts()).toMatchObject({
      created: 1,
      unchanged: 1,
      newIds: ['new-film'],
    })
  })

  it('checkpoints rejected rows and reports failure without repeating successful rows', async () => {
    mocks.commitFilm.mockRejectedValueOnce(new Error('Conflicting identifier'))
    await withCloudQueue({ send: vi.fn() }, async () => {
      await startQueuedImport('owner', task({ rows: [0, 1] }))
      await executeQueuedImport(currentRun().id)
      await executeQueuedImport(currentRun().id)
    })
    expect(counts()).toMatchObject({ cursor: 2, failed: 1, created: 1 })
    expect(currentRun().status).toBe('failed')
    expect(mocks.commitFilm).toHaveBeenCalledTimes(2)
  })

  it('does not recreate metadata jobs from the same import after a checkpoint interruption, regardless of job status', async () => {
    existingJobs = [{ mediaItemId: 'new-film', provider: 'tmdb' }]
    await withCloudQueue({ send: vi.fn() }, async () => {
      await startQueuedImport('owner', task({ providers: ['tmdb'] }))
      await executeQueuedImport(currentRun().id)
    })
    expect(mocks.enrichment).not.toHaveBeenCalled()
    expect(currentRun().result).toMatchObject({
      queuedJobs: 1,
      enrichmentCursor: 1,
    })
    expect(currentRun().status).toBe('succeeded')
  })

  it('rejects invalid persisted tasks rather than executing an unvalidated payload', async () => {
    await withCloudQueue({ send: vi.fn() }, () =>
      startQueuedImport('owner', task()),
    )
    currentRun().result = { task: { version: 9 } }
    await executeQueuedImport(currentRun().id)
    expect(currentRun().status).toBe('failed')
    expect(mocks.commitFilm).not.toHaveBeenCalled()
  })

  it('reports legacy sources unavailable without accessing the filesystem or starting a detached task', async () => {
    const status = await getImportStatus()
    expect(status.sources).toHaveLength(4)
    expect(status.sources.every((source) => !source.available)).toBe(true)
    const execute = vi.fn(async () => ({ albums: 0, films: 0 }))
    await expect(startManagedImport('owner', execute)).rejects.toThrow(
      'unavailable in cloud',
    )
    await expect(
      startLibraryImport(
        { fullLibrary: false, albumLimit: 2, filmLimit: 2 },
        'owner',
      ),
    ).rejects.toThrow('unavailable in cloud')
    expect(execute).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('retains the managed Node execution path and releases its session lock after completion', async () => {
    mocks.environment.RUNTIME_KIND = 'node'
    const release = vi.fn()
    const query = vi.fn(async () => ({ rows: [{ locked: true }] }))
    mocks.connect.mockResolvedValue({ query, release })
    let complete: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      complete = resolve
    })
    const result = await startManagedImport(
      'owner',
      async () => {
        await waiting
        return { albums: 0, films: 1 }
      },
      'film',
    )
    expect(result.status).toBe('running')
    expect(release).not.toHaveBeenCalled()
    if (!complete) throw new Error('Missing completion callback')
    complete()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(currentRun().status).toBe('succeeded')
    expect(query).toHaveBeenLastCalledWith('select pg_advisory_unlock(614103)')
  })
})
