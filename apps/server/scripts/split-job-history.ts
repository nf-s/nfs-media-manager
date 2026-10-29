import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { db } from '@/lib/db'
import { splitJobHistory } from '@/services/job-history-split'

export function parseJobHistorySplitArguments(args: string[]) {
  let apply = false
  let report: string | undefined
  for (const arg of args) {
    if (arg === '--apply' && !apply) apply = true
    else if (arg.startsWith('--report=') && report === undefined)
      report = arg.slice('--report='.length)
    else throw new Error(`Unknown or repeated argument: ${arg}`)
  }
  if (!report?.trim())
    throw new Error(
      'Required: --report=<fresh JSON file>; dry-run by default, --apply to commit.',
    )
  return { apply, report: resolve(report) }
}

export async function splitJobHistoryCli(args: string[], database?: typeof db) {
  const options = parseJobHistorySplitArguments(args)
  // Exclusive creation refuses existing files and symlinks before DB access.
  const file = await open(options.report, 'wx', 0o600)
  let ownedDatabase: typeof db | undefined
  try {
    await file.chmod(0o600)
    const connection =
      database ?? (ownedDatabase = (await import('@/lib/db')).db)
    const result = await splitJobHistory(connection, {
      apply: options.apply,
      async writeReport(report) {
        await file.writeFile(
          JSON.stringify(
            {
              ...report,
              note: 'Pre-mutation plan, not proof of commit. See CLI outcome for transaction result.',
            },
            null,
            2,
          ) + '\n',
        )
        await file.sync()
      },
    })
    return { ...result, report: options.report }
  } finally {
    await file.close()
    await ownedDatabase?.$client.end()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void splitJobHistoryCli(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(
        JSON.stringify(
          {
            applied: result.applied,
            counts: result.counts,
            blockers: result.blockers,
            report: result.report,
          },
          null,
          2,
        ) + '\n',
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        (error instanceof Error ? error.message : 'Job history split failed') +
          '\n',
      )
      process.exitCode = 1
    })
}
