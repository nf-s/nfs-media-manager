import { open, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  applyTagProvenanceBackfill,
  auditTagProvenance,
} from '@/services/tag-provenance-backfill'

export function parseTagBackfillArguments(args: string[]) {
  const values = new Map<string, string>()
  for (const arg of args) {
    const match = /^--(media-type|name|backup|review|report)=(.+)$/.exec(arg)
    const key = match?.[1]
    const value = match?.[2]
    if (arg === '--apply' && !values.has('apply')) values.set('apply', 'true')
    else if (key && value && !values.has(key)) values.set(key, value)
    else throw new Error(`Unknown, empty or repeated argument: ${arg}`)
  }
  const mediaType = z.enum(['album', 'film']).parse(values.get('media-type'))
  const apply = values.has('apply')
  const backup = values.get('backup')
  const review = values.get('review')
  if (apply && (!backup || !review || !/^[a-f0-9]{64}$/.test(review)))
    throw new Error(
      '--apply requires --backup=<fresh verified pg_dump> and --review=<dry-run hash>',
    )
  if (!apply && (backup || review))
    throw new Error('--backup and --review are only valid with --apply')
  const name = values.get('name')
  if (name && !name.trim()) throw new Error('--name must not be blank')
  return {
    scope: { mediaType, ...(name ? { name } : {}) },
    apply,
    backup,
    review,
    report: values.get('report'),
  }
}

async function verifyBackup(path: string) {
  const info = await stat(path)
  if (
    !info.isFile() ||
    info.size < 5 ||
    Date.now() - info.mtimeMs > 60 * 60 * 1000 ||
    info.mtimeMs > Date.now()
  )
    throw new Error(
      'Backup must be a nonempty pg_dump created within the last hour; coordinate a fresh backup first.',
    )
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(5)
    await file.read(bytes, 0, 5, 0)
    if (bytes.toString() !== 'PGDMP')
      throw new Error('Expected a verified custom-format pg_dump backup.')
  } finally {
    await file.close()
  }
}

export async function backfillTagProvenance(args: string[]) {
  const options = parseTagBackfillArguments(args)
  if (options.apply && options.backup)
    await verifyBackup(resolve(options.backup))
  const { db } = await import('@/lib/db')
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        options.apply
          ? sql`set transaction isolation level serializable`
          : sql`set transaction isolation level repeatable read, read only`,
      )
      await tx.execute(sql`set local lock_timeout = '2s'`)
      const report =
        options.apply && options.review
          ? await applyTagProvenanceBackfill(tx, options.scope, options.review)
          : { ...(await auditTagProvenance(tx, options.scope)), inserted: 0 }
      if (options.report)
        await writeFile(
          resolve(options.report),
          JSON.stringify(report, null, 2) + '\n',
          { flag: 'wx', mode: 0o600 },
        )
      return report
    })
    return {
      apply: options.apply,
      scope: result.scope,
      review: result.review,
      snapshotsScanned: result.snapshotsScanned,
      scannedMemberships: result.scannedMemberships,
      missingMemberships: result.missingMemberships,
      alreadyPresent: result.alreadyPresent,
      planned: result.additions.length,
      inserted: result.inserted,
      unresolvedCount: result.unresolved.length,
      additions: result.additions.slice(0, 20),
      unresolved: result.unresolved.slice(0, 20),
      report: options.report ?? null,
    }
  } finally {
    await db.$client.end()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void backfillTagProvenance(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    })
    .catch((error: unknown) => {
      process.stderr.write(
        (error instanceof Error
          ? error.message
          : 'Tag provenance backfill failed') + '\n',
      )
      process.exitCode = 1
    })
}
