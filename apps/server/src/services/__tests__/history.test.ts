import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  read: vi.fn<
    (table: PgTable, selection: object | undefined, where: SQL) => void
  >(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    select: (selection?: object) => ({
      from: (table: PgTable) => ({
        where: (where: SQL) => {
          mocks.read(table, selection, where)
          return mocks.rows()
        },
      }),
    }),
  },
}))
import { getMediaHistory } from '../history'
import { providerSnapshot, scrapeJob } from '@/schemas/db'

beforeEach(() => vi.resetAllMocks())

describe('media history read projections', () => {
  it('keeps full event data and error fallback while reading only unique job summaries', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const item = {
      id: 'item',
      jobId: 'job',
      provider: 'one',
      message: null,
      createdAt,
      payload: { complete: true },
    }
    mocks.rows
      .mockResolvedValueOnce([
        {
          id: 'snapshot',
          scrapeJobId: 'job',
          provider: 'one',
          source: 'saved',
          createdAt,
          payload: { complete: true },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        item,
        { ...item, id: 'item-2', message: 'item error' },
      ])
      .mockResolvedValueOnce([{ id: 'job', errorMessage: 'job error' }])
    const result = await getMediaHistory('film')
    expect(result.events).toHaveLength(3)
    expect(
      result.events.find((event) => event.id === 'snapshot')?.data,
    ).toEqual({ complete: true })
    expect(
      result.events.find((event) => event.id === 'item')?.description,
    ).toBe('job error')
    expect(
      result.events.find((event) => event.id === 'item-2')?.description,
    ).toBe('item error')
    const jobRead = mocks.read.mock.calls.find(([table]) => table === scrapeJob)
    if (!jobRead) throw new Error('Expected job summaries')
    expect(Object.keys(jobRead[1] ?? {})).toEqual(['id', 'errorMessage'])
    expect(new PgDialect().sqlToQuery(jobRead[2]).params).toEqual(['job'])
    const snapshotRead = mocks.read.mock.calls.find(
      ([table]) => table === providerSnapshot,
    )
    expect(snapshotRead?.[1]).not.toHaveProperty('normalizedData')
    expect(snapshotRead?.[1]).toHaveProperty('payload')
  })

  it('does not query jobs for an item without job history', async () => {
    mocks.rows.mockResolvedValue([])
    expect(await getMediaHistory('film')).toEqual({
      mediaItemId: 'film',
      events: [],
    })
    expect(mocks.rows).toHaveBeenCalledTimes(4)
  })
})
