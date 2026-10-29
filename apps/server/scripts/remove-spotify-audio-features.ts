import { mkdir, open, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AudioCleanupRowSchema,
  parseAudioCleanupArguments,
  runAudioFeatureCleanup,
} from '@/lib/audio-feature-cleanup'

export async function removeStoredSpotifyAudioFeatures(args: string[]) {
  const { apply, backupDirectory } = parseAudioCleanupArguments(args)
  const backupPath = backupDirectory ? resolve(backupDirectory) : undefined
  if (backupPath) await mkdir(backupPath, { mode: 0o700 })
  // Load only DB configuration, never the app, registry, providers or job queue.
  const { db } = await import('@/lib/db')
  try {
    const report = await db.transaction(async (tx) => {
      if (!apply) await tx.execute(sql`set transaction read only`)
      await tx.execute(sql`set local lock_timeout = '2s'`)
      return runAudioFeatureCleanup(
        {
          async read(target, cursor) {
            const result = await tx.execute(sql`
            select to_jsonb(t) as row from ${sql.identifier(target.table)} t
            where ${sql.raw(target.scope)}
              ${cursor ? sql`and t.${sql.identifier(target.idColumn)} > ${cursor}` : sql``}
            order by t.${sql.identifier(target.idColumn)} limit 100
          `)
            return z
              .array(z.object({ row: AudioCleanupRowSchema }))
              .parse(result.rows)
              .map((entry) => entry.row)
          },
          async backup(target, row, updates) {
            if (!backupPath) throw new Error('Missing backup directory')
            const file = await open(
              resolve(backupPath, `${target.table}.jsonl`),
              'a',
              0o600,
            )
            try {
              await file.writeFile(
                JSON.stringify({
                  table: target.table,
                  idColumn: target.idColumn,
                  before: row,
                  updates,
                }) + '\n',
              )
              await file.sync()
            } finally {
              await file.close()
            }
          },
          async update(target, id, updates, before) {
            const assignments = Object.entries(updates).map(
              ([column, value]) =>
                column === 'checksum'
                  ? sql`${sql.identifier(column)} = ${value}`
                  : sql`${sql.identifier(column)} = ${JSON.stringify(value)}::jsonb`,
            )
            const comparedColumns = new Set(Object.keys(updates))
            if ('checksum' in updates) {
              comparedColumns.add('payload')
              comparedColumns.add('normalized_data')
            }
            const unchanged = [...comparedColumns].map((column) =>
              column === 'checksum'
                ? sql`${sql.identifier(column)} is not distinct from ${before[column]}`
                : sql`coalesce(${sql.identifier(column)}, 'null'::jsonb) is not distinct from ${JSON.stringify(before[column])}::jsonb`,
            )
            const result =
              await tx.execute(sql`update ${sql.identifier(target.table)}
            set ${sql.join(assignments, sql`, `)}
            where ${sql.identifier(target.idColumn)} = ${id}
              and ${sql.join(unchanged, sql` and `)}
            returning ${sql.identifier(target.idColumn)}`)
            if (result.rows.length !== 1)
              throw new Error(
                `Concurrent change in ${target.table}; cleanup rolled back. Retry with a new backup directory.`,
              )
          },
        },
        apply,
      )
    })
    if (backupPath)
      await writeFile(
        resolve(backupPath, 'report.json'),
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      )
    return report
  } finally {
    await db.$client.end()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void removeStoredSpotifyAudioFeatures(process.argv.slice(2))
    .then((report) =>
      process.stdout.write(JSON.stringify(report, null, 2) + '\n'),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        (error instanceof Error ? error.message : 'Audio cleanup failed') +
          '\n',
      )
      process.exitCode = 1
    })
}
