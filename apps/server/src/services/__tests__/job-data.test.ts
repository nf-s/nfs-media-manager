import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core'

const mocks = vi.hoisted(() => ({
  job: vi.fn(),
  rows: vi.fn(),
  read: vi.fn<
    (
      table: PgTable | undefined,
      selection: object,
      where: SQL | undefined,
    ) => void
  >(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    query: { scrapeJob: { findFirst: mocks.job } },
    select: (selection: object) => {
      let table: PgTable | undefined
      let condition: SQL | undefined
      const builder = {
        from: (source: PgTable) => {
          table = source
          return builder
        },
        where: (where: SQL | undefined) => {
          condition = where
          return builder
        },
        getSQL: (): SQL => sql`select 1 from ${table} where ${condition}`,
        orderBy: () => {
          mocks.read(table, selection, condition)
          return mocks.rows()
        },
      }
      return builder
    },
  },
}))
import { getJobData } from '../job-data'
import { providerSnapshot, scrapeJobItem, scrapeJobLog } from '@/schemas/db'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.job.mockResolvedValue({ id: 'job' })
  mocks.rows.mockResolvedValue([])
})

describe('stored job data reads', () => {
  it('rejects missing jobs before loading any payloads', async () => {
    mocks.job.mockResolvedValue(undefined)
    await expect(getJobData('missing')).rejects.toThrow('Job not found')
    expect(mocks.rows).not.toHaveBeenCalled()
  })

  it('pushes diagnostic and fallback filtering into SQL without loading unrelated data', async () => {
    await getJobData('job')
    const dialect = new PgDialect()
    const logRead = mocks.read.mock.calls.find(
      ([table]) => table === scrapeJobLog,
    )
    const itemRead = mocks.read.mock.calls.find(
      ([table]) => table === scrapeJobItem,
    )
    const snapshotRead = mocks.read.mock.calls.find(
      ([table]) => table === providerSnapshot,
    )
    if (!logRead?.[2] || !itemRead?.[2])
      throw new Error('Expected filtered reads')
    const logQuery = dialect.sqlToQuery(logRead[2])
    const itemQuery = dialect.sqlToQuery(itemRead[2])
    expect(logQuery.sql).toContain('jsonb_typeof')
    expect(logQuery.sql).toContain("<> '[]'::jsonb")
    expect(logQuery.params).toEqual(['job'])
    expect(itemQuery.sql).toContain('not exists')
    expect(itemQuery.sql).toContain('is not distinct from')
    expect(itemQuery.sql).toContain("<> 'null'::jsonb")
    expect(itemQuery.params).toEqual(['job', 'succeeded', 'job'])
    expect(snapshotRead?.[1]).not.toHaveProperty('normalizedData')
  })

  it('preserves complete snapshots, diagnostics and legacy payloads in the shared contract', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const snapshot = {
      id: 'snapshot',
      mediaItemId: 'film',
      provider: 'one',
      createdAt,
      payload: { response: ['complete'] },
    }
    const legacy = {
      id: 'item',
      mediaItemId: null,
      provider: 'two',
      payload: { response: 'legacy' },
    }
    mocks.rows
      .mockResolvedValueOnce([snapshot])
      .mockResolvedValueOnce([
        {
          id: 'log',
          createdAt,
          metadata: {
            diagnostics: [{ response: [] }],
            unrelated: 'not exposed',
          },
        },
        { id: 'invalid', createdAt, metadata: { diagnostics: [] } },
      ])
      .mockResolvedValueOnce([legacy])
    expect(await getJobData('job')).toEqual({
      jobId: 'job',
      snapshots: [{ ...snapshot, createdAt: createdAt.toISOString() }],
      diagnostics: [
        {
          id: 'log',
          createdAt: createdAt.toISOString(),
          data: [{ response: [] }],
        },
      ],
      itemPayloads: [legacy],
    })
  })
})
