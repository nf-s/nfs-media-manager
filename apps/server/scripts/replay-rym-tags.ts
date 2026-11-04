import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { z } from 'zod'
import * as schema from '../src/schemas/db'
import { getDatabaseConnectionOptions } from '../src/lib/database-config'

export function parseReplayArguments(args: string[]) {
  const { values, tokens } = parseArgs({
    args,
    tokens: true,
    options: {
      apply: { type: 'boolean' },
      review: { type: 'string' },
      report: { type: 'string' },
      'media-id': { type: 'string' },
    },
  })
  const flags = tokens.flatMap((t) => (t.kind === 'option' ? [t.name] : []))
  if (new Set(flags).size !== flags.length) throw new Error('Repeated flag')
  if (!values.report?.trim())
    throw new Error('--report=<new JSON file> is required')
  if (
    values.apply
      ? !/^[0-9a-f]{64}$/.test(values.review ?? '')
      : values.review !== undefined
  )
    throw new Error(
      '--apply and --review=<preview SHA-256> must be supplied together',
    )
  if (values['media-id'] !== undefined && !values['media-id'].trim())
    throw new Error('--media-id cannot be blank')
  return {
    apply: values.apply ?? false,
    review: values.review,
    report: values.report,
    mediaId: values['media-id'],
  }
}

export function replayTarget(
  explicit: string | undefined,
  configuration: Parameters<typeof getDatabaseConnectionOptions>[0],
) {
  const raw = explicit ?? configuration.DATABASE_URL
  const dbSchema =
    explicit !== undefined
      ? 'public'
      : (configuration.DATABASE_SCHEMA ?? 'public')
  if (!/^[a-z_][a-z0-9_]*$/.test(dbSchema))
    throw new Error('Unsupported database schema')
  const options = `-c search_path=${dbSchema},public`
  const isLocal = (host: string) =>
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
  if (raw === undefined) {
    if (!isLocal(configuration.DATABASE_HOST))
      throw new Error('Remote targets require RYM_REPLAY_DATABASE_URL')
    return {
      connection: { ...getDatabaseConnectionOptions(configuration), options },
      databaseName: configuration.DATABASE_NAME,
      dbSchema,
      label: `${configuration.DATABASE_HOST}:${configuration.DATABASE_PORT}/${configuration.DATABASE_NAME}#${dbSchema}`,
    }
  }
  const parsed = z.url({ protocol: /^postgres(?:ql)?$/ }).safeParse(raw)
  if (!parsed.success)
    throw new Error(
      'Supply a direct database URL through RYM_REPLAY_DATABASE_URL',
    )
  const target = new URL(parsed.data)
  const local = isLocal(target.hostname)
  if (!local && explicit === undefined)
    throw new Error('Remote targets require RYM_REPLAY_DATABASE_URL')
  if (
    !target.hostname ||
    !/^\/[^/]+$/.test(target.pathname) ||
    target.hash ||
    target.hostname.includes('-pooler.') ||
    [...target.searchParams.keys()].some(
      (k) => !['sslmode', 'channel_binding'].includes(k),
    )
  )
    throw new Error('Use a direct database URL with an explicit database name')
  target.searchParams.set('sslmode', local ? 'disable' : 'verify-full')
  return {
    connection: {
      connectionString: target.href,
      options,
    },
    databaseName: decodeURIComponent(target.pathname.slice(1)),
    dbSchema,
    label: `${target.hostname}:${target.port || '5432'}${target.pathname}#${dbSchema}`,
  }
}

export async function replayRymTags(args: string[]) {
  const options = parseReplayArguments(args)
  // Capture the explicit destination before project dotenv loads.
  const explicit = process.env.RYM_REPLAY_DATABASE_URL
  const { env } = await import('../src/env')
  const target = replayTarget(explicit, env)
  const pool = new pg.Pool({
    ...target.connection,
    application_name: 'offline-rym-tag-replay',
    connectionTimeoutMillis: 15000,
  })
  try {
    const { previewRymTags, applyRymTags } =
      await import('../src/services/rym-tag-replay')
    const database = drizzle(pool, { schema })
    const scope = {
      target: target.label,
      ...(options.mediaId ? { mediaId: options.mediaId } : {}),
    }
    return await database.transaction(
      async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`)
        const actual = await tx.execute(
          sql`select current_database() as db, current_schema() as namespace`,
        )
        if (
          actual.rows[0]?.db !== target.databaseName ||
          actual.rows[0]?.namespace !== target.dbSchema
        )
          throw new Error(
            'Connected database or schema does not match the requested target',
          )
        const report =
          options.apply && options.review
            ? await applyRymTags(tx, scope, options.review)
            : await previewRymTags(tx, scope)
        const counts = { tags: 0, memberships: 0, occurrences: 0 }
        for (const item of report.additions) {
          counts.tags += Number(item.newTag)
          counts.memberships += Number(item.newMembership)
          counts.occurrences += Number(item.newOccurrence)
        }
        const summary = {
          mode: options.apply ? 'apply' : 'preview',
          scope,
          scanned: report.scanned,
          historical: report.historical,
          alreadyPresent: report.alreadyPresent,
          duplicateEvidence: report.duplicateEvidence,
          skippedAlbums: report.skipped.length,
          affectedAlbums: new Set(report.additions.map((r) => r.mediaItemId))
            .size,
          planned: counts,
          review: report.review,
          report: resolve(options.report),
        }
        await writeFile(
          options.report,
          JSON.stringify(
            {
              document: 'reviewed operations plan, not proof of commit',
              ...summary,
              skipped: report.skipped,
              additions: report.additions,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx', mode: 0o600 },
        )
        return {
          ...summary,
          inserted: options.apply
            ? counts
            : { tags: 0, memberships: 0, occurrences: 0 },
        }
      },
      options.apply
        ? { isolationLevel: 'serializable' }
        : { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  } finally {
    await pool.end()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void replayRymTags(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    })
    .catch((error: unknown) => {
      const detail =
        error instanceof Error && !error.cause
          ? error.message
          : 'Database operation failed; no automatic retry'
      process.stderr.write(detail + '\n')
      process.exitCode = 1
    })
}
