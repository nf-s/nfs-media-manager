import { drizzle } from 'drizzle-orm/node-postgres'
import { describe, expect, it, vi } from 'vitest'
import { TagListQuerySchema } from '@repo/schemas/tags'

class CapturedQuery extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
  ) {
    super('Captured read query')
  }
}
const builder = drizzle.mock({
  logger: {
    logQuery(query, params) {
      throw new CapturedQuery(query, params)
    },
  },
})
vi.mock('@/lib/db', () => ({
  get db() {
    return builder
  },
}))
vi.mock('@/lib/database-read-cache', () => ({
  createDatabaseReadCache: () => (_key: string, load: () => Promise<unknown>) =>
    load(),
}))

describe('tag page query bounds', () => {
  it('paginates grouped identities before computing per-tag detail aggregates', async () => {
    const { listTags } = await import('../tags')
    let captured: CapturedQuery | undefined
    try {
      await listTags(
        TagListQuerySchema.parse({ mediaType: 'film', page: 40, size: 25 }),
      )
    } catch (error) {
      if (!(error instanceof CapturedQuery)) throw error
      captured = error
    }
    if (!captured) throw new Error('Expected a query')
    expect(captured.query).toContain(
      'from (select count(*) over()::integer as "total_count"',
    )
    expect(captured.query).toMatch(/limit \$\d+ offset \$\d+\) "page_groups"/)
    expect(captured.query).toContain('count(*) over()::integer')
    expect(captured.params).toContain(25)
    expect(captured.params).toContain(975)
  })
})
