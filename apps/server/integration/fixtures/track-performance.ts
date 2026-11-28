import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import { z } from 'zod'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const ExplainJoinWorkSchema = z.object({
  'Actual Loops': z.number(),
  'Rows Removed by Join Filter': z.number().default(0),
  Plans: z.array(z.unknown()).default([]),
})

export const ExplainSchema = z.tuple([
  z.object({
    'QUERY PLAN': z.tuple([
      z.object({
        Plan: ExplainJoinWorkSchema.extend({
          'Shared Hit Blocks': z.number(),
          'Shared Read Blocks': z.number(),
          'Temp Read Blocks': z.number(),
          'Temp Written Blocks': z.number(),
        }).passthrough(),
        'Execution Time': z.number(),
      }),
    ]),
  }),
])

function rejectedJoinRows(plan: unknown): number {
  const parsed = ExplainJoinWorkSchema.parse(plan)
  // PostgreSQL reports the average number of rejected rows per loop.
  return (
    parsed['Rows Removed by Join Filter'] * parsed['Actual Loops'] +
    parsed.Plans.reduce<number>(
      (sum, child) => sum + rejectedJoinRows(child),
      0,
    )
  )
}

export function createTrackPerformanceFixture() {
  const name = 'track_query_budgets_' + randomUUID().replaceAll('-', '')
  const connection = {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 5000,
  }
  const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
  const pool = new pg.Pool({
    ...connection,
    database: name,
    max: 2,
    options: '-c jit=off -c timezone=UTC -c work_mem=16MB',
    statement_timeout: 30_000,
  })
  const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
  const database = drizzle(pool, { schema, logger: { logQuery } })
  let created = false

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network requests are forbidden in performance tests')
      }),
    )
    await admin.connect()
    await admin.query('create database ' + name)
    created = true
    await migrate(database, { migrationsFolder: './drizzle' })
    // A database read cache entry ends when any transaction commits in the
    // server, so autovacuum must find no work here while a file runs: an
    // analyze it commits between a read and its cached repeat fails the
    // repeat's statement budget. Library writes add device marks, which the
    // device feed files vacuum themselves, and the migrations leave the
    // catalogs to be analyzed, which the end of this set-up does.
    await pool.query(
      'alter table device_dirty set (autovacuum_enabled = false)',
    )
    // One thousand recordings have a second release. Ten selective titles are
    // placed at the end of the library and each has a distinct artist credit.
    await pool.query(`
    insert into artist (id, name)
    select 'artist-' || n, 'Fixture artist ' || n from generate_series(1, 1000) n;
    insert into media_item (id, slug, media_type, title, release_date)
    select 'album-' || n, 'album-' || n, 'album', 'Fixture album ' || n,
      timestamp '2020-01-01' + n * interval '1 day'
    from generate_series(1, 1000) n;
    insert into album (media_item_id) select id from media_item where media_type = 'album';
    insert into media_item (id, slug, media_type, title, release_date)
    select 'track-' || n, 'track-' || n, 'track',
      case when n > 19990 then 'Quicksilver ' else 'Fixture track ' end ||
        lpad((case when n between 18001 and 19000 then n - 18000 else n end)::text, 5, '0'),
      timestamp '2020-01-01' + n * interval '1 day'
    from generate_series(1, 20000) n;
    insert into library_track (media_item_id, album_media_item_id, album_name, date_added, duration_sec, scrobble_count, isrc)
    select 'track-' || n, 'album-' || (1 + (n + n / 1000) % 1000),
      'Fixture album ' || (1 + (n + n / 1000) % 1000),
      timestamp '2024-01-01' + n * interval '1 hour',
      150 + n % 30, n % 101,
      'ZZFIX26' || lpad((case when n between 18001 and 19000 then n - 18000 else n end)::text, 5, '0')
    from generate_series(1, 20000) n;
    insert into media_credit (media_item_id, artist_id, role)
    select 'track-' || n, 'artist-' || ((n - 1) % 1000 + 1), 'artist'
    from generate_series(1, 20000) n;
  `)
    for (const table of [
      'artist',
      'media_item',
      'album',
      'library_track',
      'media_credit',
    ]) {
      await pool.query(`vacuum analyze ${table}`)
    }
    // Each connection reports the changes it made first, so that the analyze
    // counts them all.
    for (const client of await Promise.all([pool.connect(), pool.connect()])) {
      await client.query('select pg_stat_force_next_flush()')
      client.release()
    }
    await pool.query(`do $$
      declare catalog regclass;
      begin
        for catalog in select c.oid::regclass from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('pg_catalog', 'drizzle') and c.relkind = 'r'
        loop
          execute format('analyze %s', catalog);
        end loop;
      end $$`)
  })

  afterAll(async () => {
    await pool.end()
    if (created) await admin.query('drop database ' + name)
    await admin.end()
    vi.unstubAllGlobals()
  })

  // PostgreSQL's root buffer totals include child paths. Hits plus reads
  // measure logical work independently of the warmth of the shared cache.
  async function checkBudget<T>(
    label: string,
    maxSharedBlocks: number,
    maxStatements: number,
    read: () => Promise<T>,
    maxRejectedJoinRows?: number,
    inspectPlan?: (plan: unknown) => void,
  ) {
    logQuery.mockClear()
    const observed = await read()
    const statements = logQuery.mock.calls.filter(([query]) =>
      /^\s*(select|with)\b/i.test(query),
    )
    expect(statements.length, label).toBeGreaterThan(0)
    const statementCount = logQuery.mock.calls.length
    expect(statementCount, label + ' statements').toBeLessThanOrEqual(
      maxStatements,
    )

    let sharedBlocks = 0
    let tempBlocks = 0
    let executionMs = 0
    let rejectedRows = 0
    for (const [query, params] of statements) {
      const result = await pool.query(
        `explain (analyze, buffers, timing off, format json) ${query}`,
        params,
      )
      const explain = ExplainSchema.parse(result.rows)[0]['QUERY PLAN'][0]
      inspectPlan?.(explain.Plan)
      sharedBlocks +=
        explain.Plan['Shared Hit Blocks'] + explain.Plan['Shared Read Blocks']
      tempBlocks +=
        explain.Plan['Temp Read Blocks'] + explain.Plan['Temp Written Blocks']
      executionMs += explain['Execution Time']
      if (maxRejectedJoinRows !== undefined)
        rejectedRows += rejectedJoinRows(explain.Plan)
    }
    process.stdout.write(
      `${label}: ${sharedBlocks}/${maxSharedBlocks} shared blocks, ${tempBlocks} temp blocks, ${executionMs.toFixed(1)} ms across ${statementCount}/${maxStatements} statements (${statements.length} explained)\n`,
    )
    expect(sharedBlocks, label + ' shared blocks').toBeLessThanOrEqual(
      maxSharedBlocks,
    )
    expect(tempBlocks, label + ' temp blocks').toBe(0)
    if (maxRejectedJoinRows !== undefined) {
      process.stdout.write(
        `${label}: ${rejectedRows}/${maxRejectedJoinRows} rejected join rows\n`,
      )
      expect(rejectedRows, label + ' rejected join rows').toBeLessThanOrEqual(
        maxRejectedJoinRows,
      )
    }
    return observed
  }

  return { name, connection, pool, database, logQuery, checkBudget }
}
