import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { getDatabaseConnectionOptions } from '@/lib/database-config'

const usage =
  'Usage: pnpm --filter @repo/server db:sample-statements [--seconds 30] [--limit 20]'
const unsignedCounter = z.string().regex(/^\d+$/).transform(BigInt)
const statement = z.object({
  fingerprint: z.string().regex(/^-?\d+$/),
  topLevel: z.boolean(),
  since: unsignedCounter,
  calls: unsignedCounter,
  executionMs: z.number().nonnegative(),
  sharedHits: unsignedCounter,
  sharedReads: unsignedCounter,
  tempReads: unsignedCounter,
  tempWrites: unsignedCounter,
})
const snapshot = z.object({
  started: unsignedCounter,
  reset: unsignedCounter.nullable(),
  deallocations: unsignedCounter,
  statements: z.array(statement),
})

type Snapshot = z.infer<typeof snapshot>

const snapshotSql = `
  SELECT
    (extract(epoch FROM pg_postmaster_start_time()) * 1000000)::bigint AS started,
    (extract(epoch FROM info.stats_reset) * 1000000)::bigint AS reset,
    info.dealloc AS deallocations,
    coalesce((
      SELECT json_agg(json_build_object(
        'fingerprint', s.queryid::text,
        'topLevel', s.toplevel,
        'since', (extract(epoch FROM s.stats_since) * 1000000)::bigint::text,
        'calls', s.calls::text,
        'executionMs', s.total_exec_time,
        'sharedHits', s.shared_blks_hit::text,
        'sharedReads', s.shared_blks_read::text,
        'tempReads', s.temp_blks_read::text,
        'tempWrites', s.temp_blks_written::text
      ))
      FROM pg_stat_statements(false) AS s
      WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND s.userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND s.queryid IS NOT NULL
        AND s.queryid IS DISTINCT FROM (
          SELECT query_id FROM pg_stat_activity WHERE pid = pg_backend_pid()
        )
    ), '[]'::json) AS statements
  FROM pg_stat_statements_info AS info
`

export function compareSnapshots(
  before: Snapshot,
  after: Snapshot,
  limit: number,
) {
  if (before.started !== after.started || before.reset !== after.reset) {
    return { reset: true, evictionsObserved: false, statements: [] }
  }

  const fingerprintKey = (row: z.infer<typeof statement>) =>
    `${row.fingerprint}/${row.topLevel}`
  const baseline = new Map(
    before.statements.map((row) => [fingerprintKey(row), row]),
  )
  const current = new Set(after.statements.map(fingerprintKey))
  const statements = after.statements.flatMap((row) => {
    const prior = baseline.get(fingerprintKey(row))
    if (prior && row.since !== prior.since) return []

    const calls = row.calls - (prior?.calls ?? 0n)
    const executionMs = row.executionMs - (prior?.executionMs ?? 0)
    const sharedHits = row.sharedHits - (prior?.sharedHits ?? 0n)
    const sharedReads = row.sharedReads - (prior?.sharedReads ?? 0n)
    const tempReads = row.tempReads - (prior?.tempReads ?? 0n)
    const tempWrites = row.tempWrites - (prior?.tempWrites ?? 0n)
    if (
      calls <= 0n ||
      executionMs < 0 ||
      sharedHits < 0n ||
      sharedReads < 0n ||
      tempReads < 0n ||
      tempWrites < 0n
    ) {
      return []
    }
    return [
      {
        fingerprint: row.fingerprint,
        topLevel: row.topLevel,
        calls: String(calls),
        executionMs,
        sharedHits: String(sharedHits),
        sharedReads: String(sharedReads),
        tempReads: String(tempReads),
        tempWrites: String(tempWrites),
      },
    ]
  })
  return {
    reset: false,
    evictionsObserved:
      after.deallocations > before.deallocations ||
      before.statements.some((row) => !current.has(fingerprintKey(row))),
    statements: statements
      .sort((left, right) => right.executionMs - left.executionMs)
      .slice(0, limit),
  }
}

async function capture(client: pg.Client): Promise<Snapshot> {
  const { rows } = await client.query<Record<string, unknown>>(snapshotSql)
  return snapshot.parse(rows[0])
}

const options = z.object({
  seconds: z.coerce.number().int().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(100),
})

async function main() {
  let values
  try {
    values = parseArgs({
      options: {
        seconds: { type: 'string', default: '30' },
        limit: { type: 'string', default: '20' },
        help: { type: 'boolean' },
      },
    }).values
  } catch {
    console.error(usage)
    process.exitCode = 1
    return
  }
  if (values.help) {
    console.info(usage)
    return
  }

  const argumentsResult = options.safeParse(values)
  if (!argumentsResult.success) {
    console.error(usage)
    process.exitCode = 1
    return
  }
  const { seconds, limit } = argumentsResult.data
  const { env } = await import('@/env')
  const client = new pg.Client({
    ...getDatabaseConnectionOptions(env),
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  })
  client.on('error', () => {
    process.exitCode = 1
  })

  try {
    await client.connect()
    const before = await capture(client)
    const start = performance.now()
    await setTimeout(seconds * 1000)
    const elapsedSeconds = (performance.now() - start) / 1000
    const after = await capture(client)
    console.info(
      JSON.stringify({
        elapsedSeconds,
        ...compareSnapshots(before, after, limit),
      }),
    )
  } finally {
    await client.end()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    console.error(
      'Statement sampling failed. Check the database configuration and PostgreSQL 17+ pg_stat_statements installation and permissions.',
    )
    process.exitCode = 1
  })
}
