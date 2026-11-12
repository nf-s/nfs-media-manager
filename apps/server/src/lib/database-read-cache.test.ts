import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const mocks = vi.hoisted(() => ({
  execute: vi.fn<(query: SQL) => Promise<{ rows: unknown[] }>>(),
  env: {
    DATABASE_URL: 'postgresql://user:secret@branch-a.neon.tech/library',
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: 5432,
  },
}))
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@/env', () => ({ env: mocks.env }))
import { createDatabaseReadCache } from './database-read-cache'

const version = {
  version: '100:103:100',
  database: 'library',
  role: 'reader',
  schemas: '{public}',
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.env.DATABASE_URL = 'postgresql://user:secret@branch-a.neon.tech/library'
  mocks.execute.mockResolvedValue({ rows: [version] })
})

describe('database-scoped read cache', () => {
  it('uses the Worker-aliased database and reads the full visibility snapshot each time', async () => {
    const cache = createDatabaseReadCache<number>({
      maxEntries: 2,
      maxValueBytes: 100,
    })
    const load = vi.fn(async () => 4)
    await cache('count', load)
    await cache('count', load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    const query = mocks.execute.mock.calls[0]?.[0]
    if (!query) throw new Error('Expected version query')
    const compiled = new PgDialect().sqlToQuery(query)
    expect(compiled.sql).toContain('pg_current_snapshot()::text')
    expect(compiled.sql).toContain('current_database()')
    expect(compiled.sql).toContain('current_user')
    expect(compiled.sql).toContain('current_schemas(true)')
    expect(compiled.params).toEqual([])
  })

  it('does not reuse identical snapshots across endpoints, databases, roles or schemas', async () => {
    const cache = createDatabaseReadCache<number>({
      maxEntries: 2,
      maxValueBytes: 100,
    })
    const load = vi.fn(async () => 4)
    await cache('count', load)
    mocks.env.DATABASE_URL =
      'postgresql://user:secret@branch-b.neon.tech/library'
    await cache('count', load)
    for (const identity of [
      { database: 'another' },
      { role: 'another' },
      { schemas: '{tenant,public}' },
    ]) {
      mocks.execute.mockResolvedValue({ rows: [{ ...version, ...identity }] })
      await cache('count', load)
    }
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('bypasses reuse when the database identity is missing or invalid', async () => {
    const cache = createDatabaseReadCache<number>({
      maxEntries: 2,
      maxValueBytes: 100,
    })
    const load = vi.fn(async () => 4)
    mocks.execute.mockResolvedValue({ rows: [{ version: version.version }] })
    await cache('count', load)
    await cache('count', load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
