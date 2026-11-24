import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  read: vi.fn<
    (table: PgTable, selection: object | undefined, where: SQL) => void
  >(),
}))
vi.mock('@/lib/db', () => {
  const select = (selection?: object) => ({
    from: (table: PgTable) => {
      const query = {
        where: (where: SQL) => {
          mocks.read(table, selection, where)
          return query
        },
        leftJoin: () => query,
        innerJoin: () => query,
        orderBy: () => query,
        limit: () => query,
        offset: () => query,
        then: (
          resolve: (rows: unknown) => unknown,
          reject: (error: unknown) => unknown,
        ) => Promise.resolve(mocks.rows()).then(resolve, reject),
      }
      return query
    },
  })
  return {
    db: {
      select,
      selectDistinct: select,
      selectDistinctOn: (_keys: unknown[], selection: object) =>
        select(selection),
    },
  }
})
import {
  getMediaHistory,
  getMediaSourceSnapshot,
  getMediaSources,
  listMediaSourceSnapshots,
} from '../history'
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

  it('lists scoped snapshot summaries without loading either provider payload', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    mocks.rows
      .mockResolvedValueOnce([
        {
          id: 'saved',
          provider: 'example',
          source: 'scrape',
          jobId: 'job',
          createdAt,
        },
      ])
      .mockResolvedValueOnce([{ count: 7 }])
    await expect(
      listMediaSourceSnapshots('film-1', 'example', { page: 2, size: 4 }),
    ).resolves.toEqual({
      page: 2,
      size: 4,
      totalCount: 7,
      pageCount: 2,
      items: [
        {
          id: 'saved',
          provider: 'example',
          source: 'scrape',
          jobId: 'job',
          createdAt: createdAt.toISOString(),
        },
      ],
    })
    for (const [table, projection, where] of mocks.read.mock.calls) {
      expect(table).toBe(providerSnapshot)
      expect(projection).not.toHaveProperty('data')
      expect(projection).not.toHaveProperty('payload')
      expect(projection).not.toHaveProperty('normalizedData')
      expect(new PgDialect().sqlToQuery(where).params).toEqual([
        'film-1',
        'example',
      ])
    }
  })

  it('indexes sources from saved results and jobs without selecting payloads', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const snapshot = {
      id: 'saved',
      provider: 'example',
      source: 'scrape',
      jobId: 'job',
      createdAt,
    }
    mocks.rows
      .mockResolvedValueOnce([
        {
          provider: 'example',
          snapshot: {
            ...snapshot,
            tags: [{ name: 'Fixture tag' }],
            tracks: true,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          provider: 'example',
          jobId: 'failed-refresh',
          status: 'failed',
          createdAt,
          finishedAt: createdAt,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await expect(getMediaSources('film-1')).resolves.toEqual({
      providers: [
        {
          id: 'example',
          latestSnapshot: { ...snapshot, createdAt: createdAt.toISOString() },
          latestAttempt: {
            jobId: 'failed-refresh',
            status: 'failed',
            createdAt: createdAt.toISOString(),
            finishedAt: createdAt.toISOString(),
          },
          returnedTags: ['Fixture tag'],
          returnedTrackList: true,
        },
      ],
      changes: [],
    })
    expect(mocks.read.mock.calls[0]?.[1]).toHaveProperty('snapshot.id')
    expect(mocks.read.mock.calls[0]?.[1]).not.toHaveProperty('snapshot.payload')
    expect(mocks.read.mock.calls[1]?.[1]).not.toHaveProperty('payload')
  })

  it('only reads a raw snapshot under the matching item and provider', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    mocks.rows
      .mockResolvedValueOnce([
        {
          id: 'saved',
          provider: 'example',
          source: 'scrape',
          jobId: 'job',
          createdAt,
          data: { synthetic: true },
          normalizedData: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await expect(
      getMediaSourceSnapshot('film-1', 'example', 'saved'),
    ).resolves.toMatchObject({ data: { synthetic: true } })
    await expect(
      getMediaSourceSnapshot('other-film', 'example', 'saved'),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      getMediaSourceSnapshot('film-1', 'other-provider', 'saved'),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(
      mocks.read.mock.calls.map(
        ([, , where]) => new PgDialect().sqlToQuery(where).params,
      ),
    ).toEqual([
      ['film-1', 'example', 'saved'],
      ['other-film', 'example', 'saved'],
      ['film-1', 'other-provider', 'saved'],
    ])
  })
})
