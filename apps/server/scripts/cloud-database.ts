import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import {
  type Connection,
  inventorySchema,
  quoteIdentifier,
  soleUser,
} from './cloud-helpers'

const namesSchema = z.array(z.object({ schema: z.string(), name: z.string() }))
const userNamespaces =
  "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'"

export function databaseClient(value: Connection) {
  return new pg.Client({
    host: value.host,
    port: value.port,
    database: value.database,
    user: value.user,
    password: value.password,
    ssl: value.ssl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 15000,
    application_name: 'cloud-migration-offline',
    options:
      '-c default_transaction_read_only=on -c timezone=UTC -c statement_timeout=300000 -c lock_timeout=10000',
  })
}

export async function liveIdentity(client: pg.Client) {
  const result = await client.query(`SELECT current_database() AS database,
    inet_server_addr()::text AS address, inet_server_port() AS port,
    (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid`)
  return z
    .object({
      database: z.string(),
      address: z.string().nullable(),
      port: z.number().nullable(),
      oid: z.string(),
    })
    .parse(result.rows[0])
}

export async function readOwner(client: pg.Client) {
  const result = await client.query(
    'SELECT id, email FROM public."user" ORDER BY id',
  )
  return soleUser(result.rows)
}

export async function requireIdle(client: pg.Client) {
  const result = await client.query(`SELECT
    (SELECT count(*) FROM public.scrape_job WHERE status = 'running')::text AS jobs,
    (SELECT count(*) FROM public.library_import WHERE status = 'running')::text AS imports`)
  const state = z
    .object({ jobs: z.literal('0'), imports: z.literal('0') })
    .safeParse(result.rows[0])
  if (!state.success)
    throw new Error(
      'Stop writers and resolve active work before migrating; queued work is retained',
    )
}

export async function requireStoppedWorker(client: pg.Client) {
  const lock = z
    .object({ locked: z.literal(true) })
    .safeParse(
      (await client.query('SELECT pg_try_advisory_xact_lock(614105) AS locked'))
        .rows[0],
    )
  if (!lock.success) throw new Error('Stop the job worker before migrating')
  const activity =
    await client.query(`SELECT count(*)::text AS count FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND backend_type = 'client backend' AND (state IS NULL OR state <> 'idle')`)
  if (
    !z.object({ count: z.literal('0') }).safeParse(activity.rows[0]).success
  ) {
    throw new Error(
      'Other active database clients must be stopped before migration',
    )
  }
}

export async function requireEmpty(client: pg.Client) {
  const result = await client.query(`SELECT count(*)::text AS count FROM (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${userNamespaces}
    UNION ALL
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${userNamespaces}
    UNION ALL
    SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE ${userNamespaces}
  ) objects`)
  if (!z.object({ count: z.literal('0') }).safeParse(result.rows[0]).success) {
    throw new Error(
      'Restore requires an empty database; no clean/drop operation is supported',
    )
  }
}

export async function inventory(client: pg.Client) {
  const tables = namesSchema.parse(
    (
      await client.query(`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userNamespaces} AND c.relkind = 'r'
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`)
    ).rows,
  )
  const unsupported =
    await client.query(`SELECT count(*)::text AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userNamespaces} AND c.relkind IN ('f', 'm', 'p')`)
  if (
    !z.object({ count: z.literal('0') }).safeParse(unsupported.rows[0]).success
  ) {
    throw new Error(
      'Foreign tables, materialized views and partitions require a separate validation strategy',
    )
  }
  const results: z.infer<typeof inventorySchema> = { tables: [], sequences: [] }
  for (const table of tables) {
    const name = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`
    await client.query(`DECLARE cloud_rows NO SCROLL CURSOR FOR
      SELECT to_jsonb(t)::text AS row FROM ONLY ${name} t ORDER BY to_jsonb(t)::text COLLATE "C"`)
    const hash = createHash('sha256')
    let count = 0
    try {
      while (true) {
        const batch = z
          .array(z.object({ row: z.string() }))
          .parse((await client.query('FETCH 500 FROM cloud_rows')).rows)
        if (batch.length === 0) break
        for (const value of batch) {
          hash.update(value.row).update('\n')
          count++
        }
      }
    } finally {
      await client.query('CLOSE cloud_rows')
    }
    results.tables.push({ ...table, count, sha256: hash.digest('hex') })
  }
  const sequences = namesSchema.parse(
    (
      await client.query(`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userNamespaces} AND c.relkind = 'S'
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`)
    ).rows,
  )
  for (const sequence of sequences) {
    const state = z
      .object({ lastValue: z.string(), isCalled: z.boolean() })
      .parse(
        (
          await client.query(
            `SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM ${quoteIdentifier(sequence.schema)}.${quoteIdentifier(sequence.name)}`,
          )
        ).rows[0],
      )
    results.sequences.push({ ...sequence, ...state })
  }
  return results
}

// No shell, URL arguments, inherited PG settings, or raw tool diagnostics.
export async function postgresTool(
  command: 'pg_dump' | 'pg_restore',
  args: string[],
  value: Connection,
  outputFd?: number,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    PGHOST: value.host,
    PGPORT: String(value.port),
    PGDATABASE: value.database,
    PGUSER: value.user,
    PGPASSWORD: value.password,
    PGSSLMODE: value.ssl ? 'verify-full' : 'disable',
    PGSSLROOTCERT: value.ssl ? 'system' : undefined,
    PGGSSENCMODE: 'disable',
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'cloud-migration-offline',
    PGOPTIONS: `-c timezone=UTC -c lock_timeout=10000${command === 'pg_dump' ? ' -c default_transaction_read_only=on' : ''}`,
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ['ignore', outputFd ?? 'ignore', 'ignore'],
    })
    child.once('error', () => reject(new Error('PostgreSQL tool unavailable')))
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              'PostgreSQL tool failed; keep services stopped and inspect configuration privately',
            ),
          ),
    )
  })
}
